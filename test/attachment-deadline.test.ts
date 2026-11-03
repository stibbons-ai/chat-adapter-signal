import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchData } from "../src/attachments.js";
import { requestDeadlineMs } from "../src/errors.js";
import type { SignalTransportConfig } from "../src/index.js";
import type { RequestOptions, SignalTransport } from "../src/transport/types.js";
import { HttpTransport } from "../src/transport/http.js";
import { ALICE_ACI, attachmentEnvelope, BOT_ACCOUNT, directTextEnvelope, FakeSignalCli } from "./fake-signal-cli.js";
import { fakeSignalCliOnPath, startBot, type Bot } from "./helpers.js";

// Real deadlines against a real fake daemon, as in request-timeouts.test.ts.
const REQUEST_TIMEOUT_MS = 250;
/** The deadline includes starting the spawned process (the fake executable is a Node script), so it gets longer. */
const SPAWN_REQUEST_TIMEOUT_MS = 2_000;
/** The documented allowance: 1 ms of deadline per 64 bytes of base64 attachment content. */
const BASE64_BYTES_PER_MS = 64;
/** Raw bytes whose base64 adds `ms` to the deadline. */
const rawBytesFor = (ms: number) => (ms * BASE64_BYTES_PER_MS * 3) / 4;
const SIGNAL_CLI_MAX_ATTACHMENT_BYTES = 150 * 1024 * 1024;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  vi.unstubAllEnvs();
});

async function startFake(): Promise<FakeSignalCli> {
  const fake = await FakeSignalCli.start();
  cleanups.push(() => fake.stop());
  return fake;
}

async function bot(fake: FakeSignalCli, transport: SignalTransportConfig, requestTimeoutMs: number): Promise<Bot> {
  const started = await startBot({ fake, config: { account: BOT_ACCOUNT, transport, requestTimeoutMs } });
  cleanups.push(() => started.chat.shutdown());
  return started;
}

const transports: Array<[string, number, (fake: FakeSignalCli) => Promise<SignalTransportConfig>]> = [
  ["http", REQUEST_TIMEOUT_MS, async (fake) => ({ type: "http", url: fake.url })],
  [
    "spawn",
    SPAWN_REQUEST_TIMEOUT_MS,
    async (fake) => {
      await fakeSignalCliOnPath(fake);
      return { type: "spawn" };
    },
  ],
  [
    "socket",
    REQUEST_TIMEOUT_MS,
    async (fake) => {
      const dir = await mkdtemp(join(tmpdir(), "signal-attachment-deadline-"));
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      const path = join(dir, "signal-cli.sock");
      await fake.listenSocket(path);
      return { type: "socket", path };
    },
  ],
  ["tcp", REQUEST_TIMEOUT_MS, async (fake) => ({ type: "tcp", host: "127.0.0.1", port: await fake.listenTcp() })],
];

function timeoutError(method: string, deadlineMs: number) {
  return expect.objectContaining({
    name: "NetworkError",
    message: expect.stringMatching(new RegExp(`^signal-cli JSON-RPC ${method} .+ did not answer within ${deadlineMs} ms$`)),
  });
}

// The spawn row's deadline alone is 2 s, so its tests get more than vitest's 5 s default.
describe.each(transports)("attachment deadline over the %s transport", { timeout: 15_000 }, (_name, timeoutMs, transportFor) => {
  async function dmThread(fake: FakeSignalCli) {
    const started = await bot(fake, await transportFor(fake), timeoutMs);
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "send me the report" }));
    return { ...started, thread: (await started.nextDirectMessage()).thread };
  }

  it("sends an attachment that signal-cli takes longer than requestTimeoutMs to upload", async () => {
    const fake = await startFake();
    const { thread } = await dmThread(fake);
    const release = fake.hold("send"); // signal-cli still receiving the file and uploading it to Signal
    setTimeout(release, timeoutMs + 500);
    const started = Date.now();

    await thread.post({ markdown: "report", files: [{ data: Buffer.alloc(rawBytesFor(timeoutMs + 1_500), 7), filename: "report.bin" }] });

    expect(Date.now() - started).toBeGreaterThan(timeoutMs);
    expect(fake.rpcRequests("send")).toHaveLength(1);
  });

  it("fails a send with attachments that signal-cli never answers once the deadline for their total size passes", async () => {
    const fake = await startFake();
    const { thread } = await dmThread(fake);
    fake.hold("send"); // never released: a wedged daemon
    const started = Date.now();
    const files = [
      { data: Buffer.alloc(rawBytesFor(200), 7), filename: "a.bin" },
      { data: Buffer.alloc(rawBytesFor(300), 8), filename: "b.bin" },
    ];

    const error = await thread.post({ markdown: "report", files }).catch((e: unknown) => e);

    const uris = fake.rpcRequests("send")[0]!.params!.attachments as string[];
    expect(uris).toHaveLength(2);
    const deadlineMs = timeoutMs + Math.ceil(uris.reduce((total, uri) => total + uri.length, 0) / BASE64_BYTES_PER_MS);
    expect(error).toEqual(timeoutError("send", deadlineMs));
    expect(Date.now() - started).toBeGreaterThanOrEqual(deadlineMs - 1);
  });

  it("fetches an attachment whose content arrives slower than requestTimeoutMs allows", async () => {
    const fake = await startFake();
    const { adapter } = await bot(fake, await transportFor(fake), timeoutMs);
    const content = Buffer.alloc(rawBytesFor(timeoutMs + 1_500), 9);
    fake.storedAttachments.set("big.bin", content);
    fake.trickle("getAttachment", 5, (timeoutMs + 500) / 4); // still arriving after requestTimeoutMs
    const message = adapter.parseMessage(attachmentEnvelope({ aci: ALICE_ACI, attachments: [{ id: "big.bin", size: content.length }] }));
    const started = Date.now();

    const data = await message.attachments[0]!.fetchData!();

    expect(Date.now() - started).toBeGreaterThan(timeoutMs);
    expect(Buffer.from(data as Buffer).equals(content)).toBe(true);
  });

  it("fails fetching an attachment that signal-cli never returns once the deadline for its size passes", async () => {
    const fake = await startFake();
    const { adapter } = await bot(fake, await transportFor(fake), timeoutMs);
    fake.hold("getAttachment"); // never released: a wedged daemon
    const message = adapter.parseMessage(attachmentEnvelope({ aci: ALICE_ACI, attachments: [{ id: "big.bin", size: rawBytesFor(400) }] }));
    const started = Date.now();

    await expect(message.attachments[0]!.fetchData!()).rejects.toThrow(timeoutError("getAttachment", timeoutMs + 400));
    expect(Date.now() - started).toBeGreaterThanOrEqual(timeoutMs + 400 - 1);
  });
});

it("is not cut short over HTTP by the fetch client's response-headers timeout", { timeout: 15_000 }, async () => {
  // Node's fetch (undici) fails a request whose response headers take over 300 s; signal-cli sends
  // them for `send` only after uploading the attachments to Signal. Node exports no undici Agent, so
  // the test builds one from the global dispatcher's class with the limit scaled down. undici's
  // timers tick about once a second, so 100 ms fires after about 1 s; the reply comes after 2.5 s.
  await fetch("data:,").catch(() => {}); // creates the global dispatcher
  const key = Symbol.for("undici.globalDispatcher.1");
  const original = Reflect.get(globalThis, key) as { constructor: new (options: object) => { close(): Promise<void> } };
  const strict = new original.constructor({ headersTimeout: 100 });
  Reflect.set(globalThis, key, strict);
  cleanups.push(async () => {
    Reflect.set(globalThis, key, original);
    await strict.close();
  });
  const fake = await startFake();
  const { adapter } = await bot(fake, { type: "http", url: fake.url }, REQUEST_TIMEOUT_MS);
  const release = fake.hold("send"); // uploading to Signal: no response headers yet
  setTimeout(release, 2_500);

  const sent = await adapter.postMessage(`signal:dm:${ALICE_ACI}`, {
    markdown: "report",
    files: [{ data: Buffer.alloc(rawBytesFor(4_000), 7), filename: "report.bin" }],
  });

  expect(sent.raw.timestamp).toEqual(expect.any(Number));
});

it.each([
  // node:http accepts any three-digit status, e.g. from a misbehaving proxy; a Response cannot hold it.
  ["a status outside 200-599", "HTTP/1.1 600 Weird\r\nContent-Length: 0\r\n\r\n", /returned HTTP 600$/],
  // node:http hands a 101 only to 'upgrade' listeners and just closes the request; without care it never settles.
  ["a 101 Switching Protocols", "HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n", /closed without a response/],
])("reports an HTTP reply with %s on a JSON-RPC request as a NetworkError", async (_case, reply, message) => {
  const server = createNetServer((socket) => socket.end(reply, () => socket.destroy()));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  const transport = new HttpTransport({ type: "http", url: `http://127.0.0.1:${port}` }, BOT_ACCOUNT, REQUEST_TIMEOUT_MS);

  await expect(transport.request("version")).rejects.toThrow(expect.objectContaining({ name: "NetworkError", message: expect.stringMatching(message) }));
});

it.each([
  [401, {}, { name: "AuthenticationError" }],
  [429, { "Retry-After": "30" }, { name: "AdapterRateLimitError", retryAfter: 30 }],
])("maps an HTTP %s on a JSON-RPC request like before", async (status, headers, expected) => {
  // JSON-RPC goes through node:http, the health check through fetch: this covers the RPC path.
  const fake = await startFake();
  fake.httpStatus = status;
  fake.httpHeaders = headers;
  const transport = new HttpTransport({ type: "http", url: fake.url }, BOT_ACCOUNT, REQUEST_TIMEOUT_MS);

  await expect(transport.request("version")).rejects.toThrow(expect.objectContaining(expected));
});

describe("getAttachment deadline", () => {
  /** The `transferBytes` that fetching an attachment reporting `size` asks the transport for. */
  async function transferBytesFor(size: unknown): Promise<number | undefined> {
    let options: RequestOptions | undefined;
    const transport = {
      request: async (_method: string, _params: unknown, given?: RequestOptions) => {
        options = given;
        return { data: "" };
      },
    } as unknown as SignalTransport;
    const attachment = { type: "file", size, fetchMetadata: { id: "a", threadId: `signal:dm:${ALICE_ACI}` } } as unknown as Attachment;
    await withFetchData(attachment, transport, BOT_ACCOUNT).fetchData!();
    return options?.transferBytes;
  }

  const largest = Math.ceil(SIGNAL_CLI_MAX_ATTACHMENT_BYTES / 3) * 4;

  it("allows for the base64 of the reported size", async () => {
    expect(await transferBytesFor(3_000)).toBe(4_000);
    expect(await transferBytesFor(1)).toBe(4);
  });

  it.each([
    ["no size", undefined],
    ["size 0", 0],
    ["a negative size", -1],
    ["a size beyond what signal-cli downloads", SIGNAL_CLI_MAX_ATTACHMENT_BYTES + 1],
  ])("allows for the largest attachment signal-cli downloads given %s", async (_case, size) => {
    expect(await transferBytesFor(size)).toBe(largest);
  });
});

describe("requestDeadlineMs", () => {
  it("adds 1 ms per 64 bytes of transfer, rounded up", () => {
    expect(requestDeadlineMs(60_000)).toBe(60_000);
    expect(requestDeadlineMs(60_000, 64)).toBe(60_001);
    expect(requestDeadlineMs(60_000, 65)).toBe(60_002);
  });

  it("stays within what setTimeout honours", () => {
    expect(requestDeadlineMs(2 ** 31 - 1, 1_000_000)).toBe(2 ** 31 - 1);
  });
});
