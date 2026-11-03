import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignalAdapter, type SignalTransportConfig } from "../src/index.js";
import { LineTransport } from "../src/transport/line.js";
import { ALICE_ACI, BOT_ACCOUNT, directTextEnvelope, FakeSignalCli } from "./fake-signal-cli.js";
import { fakeSignalCliOnPath, startBot, type Bot } from "./helpers.js";

// Real deadlines: the adapter talks to a real fake daemon, so fake timers are not an option.
const REQUEST_TIMEOUT_MS = 100;
/** The deadline includes starting the spawned process (the fake executable is a Node script), so it gets longer. */
const SPAWN_REQUEST_TIMEOUT_MS = 2_000;

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

async function bot(
  fake: FakeSignalCli,
  transport: SignalTransportConfig,
  initialize = true,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Bot> {
  const started = await startBot({ fake, config: { account: BOT_ACCOUNT, transport, requestTimeoutMs }, initialize });
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
      const dir = await mkdtemp(join(tmpdir(), "signal-timeout-"));
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      const path = join(dir, "signal-cli.sock");
      await fake.listenSocket(path);
      return { type: "socket", path };
    },
  ],
  ["tcp", REQUEST_TIMEOUT_MS, async (fake) => ({ type: "tcp", host: "127.0.0.1", port: await fake.listenTcp() })],
];

function timeoutError(method: string, timeoutMs = REQUEST_TIMEOUT_MS) {
  return expect.objectContaining({
    name: "NetworkError",
    message: expect.stringMatching(new RegExp(`^signal-cli JSON-RPC ${method} .+ did not answer within ${timeoutMs} ms$`)),
  });
}

/** In-flight requests a line transport still tracks: private, as a freed entry leaves no public trace. */
function pendingRequests(transport: LineTransport): number {
  return (Reflect.get(transport, "pending") as Map<number, unknown>).size;
}

describe.each(transports)("request deadline over the %s transport", (_name, timeoutMs, transportFor) => {
  it("fails a reply that signal-cli never answers with a timeout error", async () => {
    const fake = await startFake();
    const { nextDirectMessage } = await bot(fake, await transportFor(fake), true, timeoutMs);
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "hi" }));
    const { thread } = await nextDirectMessage();
    fake.swallowRpc("send");

    await expect(thread.post("reply")).rejects.toThrow(timeoutError("send", timeoutMs));
    expect(fake.rpcRequests("send")).toHaveLength(1);
  });

  it("fails initialize() when startup's version request is never answered", async () => {
    const fake = await startFake();
    const transport = await transportFor(fake);
    fake.swallowRpc("version");
    const { chat } = await bot(fake, transport, false, timeoutMs);

    await expect(chat.initialize()).rejects.toThrow(timeoutError("version", timeoutMs));
    expect(fake.rpcRequests("version")).toHaveLength(1);
  });
});

it("fails initialize() when the HTTP health check is never answered", async () => {
  const fake = await startFake();
  fake.swallowRpc("check");
  const { chat } = await bot(fake, { type: "http", url: fake.url }, false);

  await expect(chat.initialize()).rejects.toThrow(
    expect.objectContaining({
      name: "NetworkError",
      message: `signal-cli health check at ${fake.url} did not answer within ${REQUEST_TIMEOUT_MS} ms`,
    }),
  );
});

describe("a timed-out request on a line transport", () => {
  it("releases its pending entry and drops the late reply instead of answering another request", async () => {
    const fake = await startFake();
    const port = await fake.listenTcp();
    const transport = new LineTransport({ type: "tcp", host: "127.0.0.1", port }, BOT_ACCOUNT, REQUEST_TIMEOUT_MS);
    cleanups.push(() => transport.close());
    fake.groups = [{ id: "Z3JvdXA=", name: "Group" }];
    const releaseSend = fake.holdNext("send");

    await expect(transport.request("send", { message: "late" })).rejects.toThrow(timeoutError("send"));
    expect(pendingRequests(transport)).toBe(0);

    const releaseGroups = fake.holdNext("listGroups");
    const groups = transport.request("listGroups");
    await expect.poll(() => fake.rpcRequests("listGroups").length).toBe(1);
    releaseSend(); // signal-cli finally answers the timed-out send, ahead of listGroups on the wire
    releaseGroups();

    await expect(groups).resolves.toEqual(fake.groups);
    expect(pendingRequests(transport)).toBe(0);
  });
});

describe("requestTimeoutMs", () => {
  it.each([Number.POSITIVE_INFINITY, Number.NaN, 0, -1, 1.5, 2 ** 31])("rejects %s", (requestTimeoutMs) => {
    expect(() =>
      createSignalAdapter({ account: BOT_ACCOUNT, transport: { type: "http", url: "http://signal-cli:8080" }, requestTimeoutMs }),
    ).toThrow(expect.objectContaining({ name: "ValidationError", message: expect.stringContaining("requestTimeoutMs") }));
  });

  it.each([1, 2 ** 31 - 1])("accepts %s", (requestTimeoutMs) => {
    expect(() =>
      createSignalAdapter({ account: BOT_ACCOUNT, transport: { type: "http", url: "http://signal-cli:8080" }, requestTimeoutMs }),
    ).not.toThrow();
  });
});
