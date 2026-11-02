import {
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  ResourceNotFoundError,
  ValidationError,
} from "@chat-adapter/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignalAdapter, type SignalTransportConfig } from "../src/index.js";
import { BOT_ACCOUNT, BOT_ACI, directTextEnvelope, FakeSignalCli, type JsonRpcError } from "./fake-signal-cli.js";
import { startBot, type Bot } from "./helpers.js";

const ALICE_ACI = "a1b2c3d4-0000-4000-8000-00000000a11c";
const BOB_ACI = "b0b0b0b0-0000-4000-8000-000000000b0b";

const bots: Bot[] = [];
async function bot(options?: Parameters<typeof startBot>[0]): Promise<Bot> {
  const started = await startBot(options);
  bots.push(started);
  return started;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const started of bots.splice(0)) {
    await started.chat.shutdown();
    await started.fake.stop();
  }
});

describe("configuration", () => {
  it("falls back to SIGNAL_ACCOUNT and SIGNAL_CLI_URL when options are omitted", async () => {
    const fake = await FakeSignalCli.start();
    vi.stubEnv("SIGNAL_ACCOUNT", BOT_ACCOUNT);
    vi.stubEnv("SIGNAL_CLI_URL", fake.url);

    const { nextDirectMessage } = await bot({ fake, config: {} });
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "hi" }));

    expect((await nextDirectMessage()).message.text).toBe("hi");
    expect(fake.requests.find((request) => request.path.startsWith("/api/v1/events"))?.path).toBe(
      `/api/v1/events?account=${encodeURIComponent(BOT_ACCOUNT)}`,
    );
  });

  it("explicit options win over the environment", async () => {
    const fake = await FakeSignalCli.start();
    vi.stubEnv("SIGNAL_ACCOUNT", "+15559999999");
    vi.stubEnv("SIGNAL_CLI_URL", "http://127.0.0.1:1");

    const { chat } = await bot({ fake, config: { account: BOT_ACCOUNT, transport: { type: "http", url: fake.url } } });
    await chat.thread(`signal:dm:${ALICE_ACI}`).post("hello");

    expect(fake.rpcRequests("send")[0]?.params?.account).toBe(BOT_ACCOUNT);
  });

  it("rejects a missing account or URL with a clear validation error", () => {
    vi.stubEnv("SIGNAL_ACCOUNT", "");
    vi.stubEnv("SIGNAL_CLI_URL", "");

    expect(() => createSignalAdapter({ transport: { type: "http", url: "http://signal-cli:8080" } })).toThrow(
      expect.objectContaining({ name: "ValidationError", message: expect.stringContaining("SIGNAL_ACCOUNT") }),
    );
    expect(() => createSignalAdapter({ account: BOT_ACCOUNT })).toThrow(
      expect.objectContaining({ name: "ValidationError", message: expect.stringContaining("SIGNAL_CLI_URL") }),
    );
  });

  it.each([Number.POSITIVE_INFINITY, Number.NaN, -1, 1.5, 2 ** 31])("rejects drainTimeoutMs %s", (drainTimeoutMs) => {
    expect(() =>
      createSignalAdapter({ account: BOT_ACCOUNT, transport: { type: "http", url: "http://signal-cli:8080" }, drainTimeoutMs }),
    ).toThrow(expect.objectContaining({ name: "ValidationError", message: expect.stringContaining("drainTimeoutMs") }));
  });

  it("rejects an unsupported transport type by name", () => {
    const transport = { type: "socket", path: "/run/signal-cli.sock" } as unknown as SignalTransportConfig;

    expect(() => createSignalAdapter({ account: BOT_ACCOUNT, transport })).toThrow(
      expect.objectContaining({ name: "ValidationError", message: 'Unsupported transport type "socket"' }),
    );
  });

  it("accepts a URL with a trailing slash", async () => {
    const fake = await FakeSignalCli.start();
    await bot({ fake, config: { account: BOT_ACCOUNT, transport: { type: "http", url: `${fake.url}/` } } });

    expect(fake.requests.map((request) => request.path.split("?")[0])).toEqual(
      expect.arrayContaining(["/api/v1/check", "/api/v1/rpc", "/api/v1/events"]),
    );
    expect(fake.requests.every((request) => !request.path.startsWith("//"))).toBe(true);
  });

  it("accepts the Bot Account as an ACI in any case, with or without dashes", async () => {
    const botAci = "abcdef01-2345-4678-9abc-def012345678";
    for (const account of [botAci, botAci.toUpperCase(), botAci.replaceAll("-", "").toUpperCase()]) {
      const fake = await FakeSignalCli.start();
      fake.accounts = [{ number: null, aci: botAci }];
      const { adapter, nextDirectMessage } = await bot({ fake, config: { account, transport: { type: "http", url: fake.url } } });
      fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: `to ${account}` }));

      expect(adapter.botUserId, account).toBe(botAci);
      expect(fake.requests.find((request) => request.path.startsWith("/api/v1/events"))?.path).toBe(
        `/api/v1/events?account=${botAci}`,
      );
      expect((await nextDirectMessage()).message.text).toBe(`to ${account}`);
    }
  });
});

describe("transport headers", () => {
  it("sends the configured headers on JSON-RPC requests, the health check and the event stream", async () => {
    const fake = await FakeSignalCli.start();
    const headers = { Authorization: "Bearer proxy-token", "X-Proxy-Tenant": "bots" };
    const { chat } = await bot({ fake, config: { account: BOT_ACCOUNT, transport: { type: "http", url: fake.url, headers } } });
    await chat.thread(`signal:dm:${ALICE_ACI}`).post("hello");

    const paths = fake.requests.map((request) => request.path.split("?")[0]);
    expect(new Set(paths)).toEqual(new Set(["/api/v1/check", "/api/v1/rpc", "/api/v1/events"]));
    for (const request of fake.requests) {
      expect(request.headers.authorization).toBe("Bearer proxy-token");
      expect(request.headers["x-proxy-tenant"]).toBe("bots");
    }
  });
});

describe("initialize", () => {
  it("throws a clear network error when signal-cli is unreachable", async () => {
    const fake = await FakeSignalCli.start();
    const url = fake.url;
    await fake.stop();
    const { chat } = await bot({ fake, initialize: false, config: { account: BOT_ACCOUNT, transport: { type: "http", url } } });

    const failure = chat.initialize();
    await expect(failure).rejects.toBeInstanceOf(NetworkError);
    await expect(failure).rejects.toThrow(`signal-cli is unreachable: health check at ${url} failed`);
  });

  it("throws an authentication error when a proxy in front of signal-cli rejects the credentials", async () => {
    const fake = await FakeSignalCli.start();
    fake.httpStatus = 401;
    const { chat } = await bot({ fake, initialize: false });

    await expect(chat.initialize()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("throws an authentication error when the daemon does not serve the Bot Account", async () => {
    const fake = await FakeSignalCli.start();
    fake.accounts = [{ number: "+15550000002", aci: BOB_ACI }];
    const { chat } = await bot({ fake, initialize: false });

    await expect(chat.initialize()).rejects.toThrow(
      expect.objectContaining({ name: "AuthenticationError", message: expect.stringContaining(BOT_ACCOUNT) }),
    );
  });

  it.each(["0.13.22", "0.14.8"])("warns when signal-cli %s is below the tested minimum", async (version) => {
    const fake = await FakeSignalCli.start();
    fake.version = version;
    const { logger } = await bot({ fake });

    const warnings = logger.entries.filter((entry) => entry.level === "warn");
    expect(warnings).toEqual([
      expect.objectContaining({ message: `signal-cli ${version} is older than 0.14.9, the oldest version this adapter is tested with; update signal-cli` }),
    ]);
  });

  it.each([
    { case: "unparseable", result: { version: "unknown" } },
    { case: "missing", result: {} },
    { case: "null", result: null },
  ])("warns that a $case version cannot be checked", async ({ result }) => {
    const fake = await FakeSignalCli.start();
    fake.replyRpcRaw("version", { jsonrpc: "2.0", id: 1, result });
    const { logger } = await bot({ fake });

    const warnings = logger.entries.filter((entry) => entry.level === "warn").map((entry) => entry.message);
    expect(warnings).toEqual([
      "signal-cli reported an unrecognised version; cannot check it against 0.14.9, the oldest version this adapter is tested with",
    ]);
  });

  it.each([
    { case: "a null JSON body", method: "version", body: null, expected: NetworkError },
    { case: "listAccounts not returning an array", method: "listAccounts", body: { jsonrpc: "2.0", id: 1, result: {} }, expected: NetworkError },
    { case: "a null listAccounts entry", method: "listAccounts", body: { jsonrpc: "2.0", id: 1, result: [null] }, expected: NetworkError },
    {
      case: "the Bot Account listed without a valid ACI",
      method: "listAccounts",
      body: { jsonrpc: "2.0", id: 1, result: [{ number: BOT_ACCOUNT, aci: "not-an-aci" }] },
      expected: AuthenticationError,
    },
  ])("rejects $case with $expected.name", async ({ method, body, expected }) => {
    const fake = await FakeSignalCli.start();
    fake.replyRpcRaw(method, body);
    const { chat } = await bot({ fake, initialize: false });

    await expect(chat.initialize()).rejects.toBeInstanceOf(expected);
  });

  it("does not warn for the tested minimum or newer", async () => {
    for (const version of ["0.14.9", "0.14.10", "0.15.0", "1.0.0-SNAPSHOT"]) {
      const fake = await FakeSignalCli.start();
      fake.version = version;
      const { logger } = await bot({ fake });
      expect(logger.entries.filter((entry) => entry.level === "warn"), version).toEqual([]);
    }
  });
});

describe("inbound 1:1 messages", () => {
  it("delivers a 1:1 text envelope to onDirectMessage keyed by ACI", async () => {
    const { fake, nextDirectMessage } = await bot();
    fake.injectEnvelope(
      directTextEnvelope({ aci: ALICE_ACI, number: "+15551230001", name: "Alice", text: "Hello bot", timestamp: 1_700_000_000_123 }),
    );

    const { thread, message } = await nextDirectMessage();
    expect(thread.id).toBe(`signal:dm:${ALICE_ACI}`);
    expect(thread.isDM).toBe(true);
    expect(message.id).toBe(`${ALICE_ACI}:1700000000123`);
    expect(message.text).toBe("Hello bot");
    expect(message.metadata.dateSent).toEqual(new Date(1_700_000_000_123));
    expect(message.author).toEqual({ userId: ALICE_ACI, userName: ALICE_ACI, fullName: "Alice", isBot: "unknown", isMe: false });
  });

  it("falls back to the phone number, then the ACI, as display name only", async () => {
    const { fake, nextDirectMessage } = await bot();
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, number: "+15551230001", text: "one" }));
    fake.injectEnvelope(directTextEnvelope({ aci: BOB_ACI, text: "two" }));

    const authors = [(await nextDirectMessage()).message.author, (await nextDirectMessage()).message.author];
    const byUser = Object.fromEntries(authors.map((author) => [author.userId, author.fullName]));
    expect(byUser).toEqual({ [ALICE_ACI]: "+15551230001", [BOB_ACI]: BOB_ACI });
  });

  it("ignores envelopes outside 1:1 text without stopping the stream", async () => {
    const { fake, nextDirectMessage } = await bot();
    const base = directTextEnvelope({ aci: ALICE_ACI, text: "ignored" });
    const { dataMessage, ...withoutData } = base;
    fake.injectEnvelope({ ...base, dataMessage: { ...dataMessage, groupInfo: { groupId: "Z3JvdXA=", type: "DELIVER" } } });
    fake.injectEnvelope({ ...base, dataMessage: { ...dataMessage, message: null, reaction: { emoji: "👍" } } });
    fake.injectEnvelope({ ...base, dataMessage: { ...dataMessage, remoteDelete: { timestamp: 1 } } });
    fake.injectEnvelope({ ...base, dataMessage: { ...dataMessage, storyContext: { authorNumber: null, authorUuid: BOB_ACI, sentTimestamp: 1 } } });
    fake.injectEnvelope({ ...base, dataMessage: { message: "no timestamp" } });
    fake.injectEnvelope({ ...base, dataMessage: { ...dataMessage, timestamp: 1.5 } });
    fake.injectEnvelope({ ...withoutData, syncMessage: { sentMessage: { destinationUuid: ALICE_ACI, message: "own" } } });
    fake.injectEnvelope({ ...withoutData, editMessage: { targetSentTimestamp: 1, dataMessage } });
    fake.injectEnvelope({ ...withoutData, receiptMessage: { when: 1, isDelivery: true, timestamps: [1] } });
    fake.injectEnvelope({ ...withoutData, typingMessage: { action: "STARTED", timestamp: 1 } });
    fake.injectEnvelope({ ...withoutData, sourceUuid: null });
    fake.injectEnvelope(directTextEnvelope({ aci: BOT_ACI, text: "from my own ACI" }));
    fake.injectEnvelope(directTextEnvelope({ aci: BOB_ACI, text: "delivered" }));

    const { message } = await nextDirectMessage();
    expect(message.text).toBe("delivered");
  });

  it("reassembles an event that arrives in pieces, including split multi-byte characters", async () => {
    const { fake, nextDirectMessage } = await bot();
    const text = "Grüße 👋 aus Köln";
    await fake.injectEnvelopeInPieces(directTextEnvelope({ aci: ALICE_ACI, text }), 7);

    expect((await nextDirectMessage()).message.text).toBe(text);
  });
});

describe("event stream robustness", () => {
  // Real delay on purpose: separate writes must reach the adapter's socket as separate chunks.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

  it("handles other Conversations while one handler is still running", async () => {
    const { fake, chat, nextDirectMessage } = await bot();
    let release!: () => void;
    const aliceBlocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let aliceDone = false;
    chat.onDirectMessage(async (_thread, message) => {
      if (message.author.userId === ALICE_ACI) {
        await aliceBlocked;
        aliceDone = true;
      }
    });

    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "slow" }));
    expect((await nextDirectMessage()).message.text).toBe("slow");
    fake.injectEnvelope(directTextEnvelope({ aci: BOB_ACI, text: "fast" }));

    expect((await nextDirectMessage()).message.text).toBe("fast");
    expect(aliceDone).toBe(false);
    release();
    await expect.poll(() => aliceDone).toBe(true);
  });

  it("shutdown waits for a running handler to send its reply", async () => {
    const { fake, chat, logger, nextDirectMessage } = await bot();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    chat.onDirectMessage(async (thread) => {
      await gate;
      await thread.post("late reply");
    });
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "hi" }));
    await nextDirectMessage();

    let shutDown = false;
    let sentWhenShutDown: unknown[] | undefined;
    const shutdown = chat.shutdown().then(() => {
      shutDown = true;
      sentWhenShutDown = fake.rpcRequests("send").map((request) => request.params?.message);
    });
    await fake.eventStreamsClosed();
    // Real wait on purpose: shutdown must still be pending well after the stream closed.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(shutDown).toBe(false);
    release();
    await shutdown;

    expect(sentWhenShutDown).toEqual(["late reply"]);
    expect(logger.entries.filter((entry) => entry.level === "error")).toEqual([]);
  });

  it("shutdown called from a handler resolves after the drain timeout", async () => {
    const fake = await FakeSignalCli.start();
    const { chat, logger, nextDirectMessage } = await bot({
      fake,
      config: { account: BOT_ACCOUNT, transport: { type: "http", url: fake.url }, drainTimeoutMs: 50 },
    });
    let shutdownFromHandler: Promise<void> | undefined;
    chat.onDirectMessage(async () => {
      shutdownFromHandler = chat.shutdown();
      await shutdownFromHandler;
    });
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "stop" }));
    await nextDirectMessage();
    // Poll a boolean: expect.poll would await a returned promise.
    await expect.poll(() => shutdownFromHandler !== undefined).toBe(true);

    await shutdownFromHandler;
    expect(fake.openEventStreams).toBe(0);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({ level: "warn", message: "Stopped waiting for 1 Signal message handler(s) after 50 ms" }),
    );
  });

  it("shutdown during startup leaves no event stream open", async () => {
    const { fake, chat, logger } = await bot({ initialize: false });
    const received: string[] = [];
    chat.onDirectMessage((_thread, message) => {
      received.push(message.text);
    });

    const starting = chat.initialize().catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    await chat.shutdown();
    await starting;
    // Real wait on purpose: a late stream would be opened by the startup still in flight.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(fake.openEventStreams).toBe(0);
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "after shutdown" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toEqual([]);
    expect(logger.entries.filter((entry) => entry.level === "error")).toEqual([]);
  });

  it("shutdown while the event stream is connecting closes it once it opens", async () => {
    const { fake, chat } = await bot({ initialize: false });
    const release = fake.holdEventStreams();

    const starting = chat.initialize().catch(() => {});
    await expect.poll(() => fake.requests.some((request) => request.path.startsWith("/api/v1/events"))).toBe(true);
    await chat.shutdown();
    release();
    await starting;

    await expect.poll(() => fake.openEventStreams).toBe(0);
  });

  it("shutdown stops waiting for a handler that never finishes after the drain timeout", async () => {
    const fake = await FakeSignalCli.start();
    const { chat, logger, nextDirectMessage } = await bot({
      fake,
      // Real 50 ms bound: the adapter talks to a real HTTP server, so fake timers are not an option.
      config: { account: BOT_ACCOUNT, transport: { type: "http", url: fake.url }, drainTimeoutMs: 50 },
    });
    chat.onDirectMessage(() => new Promise<void>(() => {}));
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "stuck" }));
    await nextDirectMessage();

    await chat.shutdown();

    expect(logger.entries).toContainEqual(
      expect.objectContaining({ level: "warn", message: "Stopped waiting for 1 Signal message handler(s) after 50 ms" }),
    );
  });

  it("keeps receiving after a handler throws", async () => {
    const { fake, chat, nextDirectMessage } = await bot();
    chat.onDirectMessage((_thread, message) => {
      if (message.author.userId === ALICE_ACI) {
        throw new Error("handler bug");
      }
    });

    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "boom" }));
    await nextDirectMessage();
    fake.injectEnvelope(directTextEnvelope({ aci: BOB_ACI, text: "after" }));

    expect((await nextDirectMessage()).message.text).toBe("after");
    expect(fake.openEventStreams).toBe(1);
  });

  it.each(["null", "[]", '"text"'])("skips an event whose data is %s, reports it, and keeps the stream open", async (data) => {
    const { fake, logger, nextDirectMessage } = await bot();
    fake.injectRaw(`event:receive\ndata:${data}\n\n`);
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "after" }));

    expect((await nextDirectMessage()).message.text).toBe("after");
    expect(fake.openEventStreams).toBe(1);
    const errors = logger.entries.filter((entry) => entry.level === "error");
    expect(JSON.stringify(errors, (_key, value) => (value instanceof Error ? value.message : value))).toContain(
      "Ignoring signal-cli event that is not a JSON object",
    );
  });

  it.each([
    { case: "truncated", data: '{"envelope":{"sourceNumber":"+4366012345","dataMessage":{"message":"secret PIN 1234"' },
    // V8 quotes the input in this parse error: `Unexpected token 's', "{"m":secret PIN"... is not valid JSON`.
    { case: "unexpected-token", data: '{"m":secret PIN 1234, "n":"+4366012345"}' },
  ])("never logs the content of a $case event", async ({ data }) => {
    const { fake, logger, nextDirectMessage } = await bot();
    fake.injectRaw(`event:receive\ndata:${data}\n\n`);
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "next" }));
    await nextDirectMessage();

    const logged = JSON.stringify(logger.entries, (_key, value) => (value instanceof Error ? value.message : value));
    expect(logged).toContain("not valid JSON");
    expect(logged).not.toContain("secret PIN");
    expect(logged).not.toContain("+4366012345");
  });

  it("dispatches a CR-framed event without waiting for more bytes", async () => {
    const { fake, nextDirectMessage } = await bot();
    const data = JSON.stringify({ account: BOT_ACCOUNT, envelope: directTextEnvelope({ aci: ALICE_ACI, text: "cr" }) });
    fake.injectRaw(`event:receive\rdata:${data}\r\r`);

    expect((await nextDirectMessage()).message.text).toBe("cr");
  });

  it("treats a CRLF split across chunks as one line end", async () => {
    const { fake, nextDirectMessage } = await bot();
    const data = JSON.stringify({ account: BOT_ACCOUNT, envelope: directTextEnvelope({ aci: ALICE_ACI, text: "crlf" }) });
    fake.injectRaw("event:receive\r");
    await tick();
    fake.injectRaw(`\ndata:${data}\r\n\r\n`);

    expect((await nextDirectMessage()).message.text).toBe("crlf");
  });

  it.each([
    { case: "typed", exception: { message: "Untrusted identity: +4366012345", type: "UntrustedIdentityException" }, type: "UntrustedIdentityException" },
    { case: "untyped", exception: { message: "Untrusted identity: +4366012345" }, type: "unknown" },
    { case: "non-string type", exception: { message: "Untrusted identity: +4366012345", type: 7 }, type: "unknown" },
  ])("warns about a $case receive failure with type and sender ACI only", async ({ exception, type }) => {
    const { fake, logger, nextDirectMessage } = await bot();
    const { dataMessage: _lost, ...envelope } = directTextEnvelope({ aci: ALICE_ACI, number: "+4366012345", text: "lost" });
    fake.injectRaw(`event:receive\ndata:${JSON.stringify({ account: BOT_ACCOUNT, envelope, exception })}\n\n`);
    fake.injectEnvelope(directTextEnvelope({ aci: BOB_ACI, text: "next" }));
    await nextDirectMessage();

    const warnings = logger.entries.filter((entry) => entry.level === "warn");
    expect(warnings).toEqual([
      { level: "warn", message: "signal-cli could not receive a message", args: [{ type, sender: ALICE_ACI }] },
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain("+4366012345");
  });

  it("warns when signal-cli closes the event stream", async () => {
    const { fake, logger } = await bot();
    fake.closeEventStreams();

    await expect
      .poll(() => logger.entries.find((entry) => entry.message.startsWith("signal-cli event stream closed")))
      .toMatchObject({ level: "warn" });
  });
});

describe("thread IDs", () => {
  const adapter = createSignalAdapter({ account: BOT_ACCOUNT, transport: { type: "http", url: "http://signal-cli:8080" } });

  it("encodes and decodes 1:1 thread IDs and reports them as DMs", () => {
    const threadId = adapter.encodeThreadId({ type: "dm", aci: ALICE_ACI });
    expect(threadId).toBe(`signal:dm:${ALICE_ACI}`);
    expect(adapter.decodeThreadId(threadId)).toEqual({ type: "dm", aci: ALICE_ACI });
    expect(adapter.isDM(threadId)).toBe(true);
    expect(adapter.channelIdFromThreadId(threadId)).toBe(threadId);
  });

  it.each([
    "",
    "signal:dm:",
    "signal:dm:+15551230001",
    `signal:dm:${ALICE_ACI.toUpperCase()}`,
    `signal:dm:${ALICE_ACI}:extra`,
    `telegram:dm:${ALICE_ACI}`,
    "signal:group:Z3JvdXA",
  ])("rejects invalid thread ID %j", (threadId) => {
    expect(() => adapter.decodeThreadId(threadId)).toThrow(ValidationError);
    expect(() => adapter.isDM(threadId)).toThrow(ValidationError);
  });

  it("refuses to encode a non-ACI user", () => {
    expect(() => adapter.encodeThreadId({ type: "dm", aci: "+15551230001" })).toThrow(ValidationError);
  });
});

describe("outbound", () => {
  it("thread.post sends plain text to the 1:1 recipient as the Bot Account", async () => {
    const { fake, chat } = await bot();
    const sent = await chat.thread(`signal:dm:${ALICE_ACI}`).post("Hello Alice");

    expect(fake.rpcRequests("send")).toEqual([
      {
        jsonrpc: "2.0",
        id: expect.any(Number),
        method: "send",
        params: { account: BOT_ACCOUNT, recipient: [ALICE_ACI], message: "Hello Alice" },
      },
    ]);
    expect(sent.id).toBe(`${BOT_ACI}:1700000000000`);
  });

  it("sends markdown as its plain text", async () => {
    const { fake, chat } = await bot();
    await chat.thread(`signal:dm:${ALICE_ACI}`).post({ markdown: "Hello **Alice**" });

    expect(fake.rpcRequests("send")[0]?.params?.message).toBe("Hello Alice");
  });
});

describe("lifecycle", () => {
  it("handleWebhook answers 501", async () => {
    const { chat } = await bot();
    const response = await chat.webhooks.signal(new Request("http://host-app/webhooks/signal", { method: "POST", body: "{}" }));

    expect(response.status).toBe(501);
  });

  it("disconnect closes the event stream", async () => {
    const { fake, chat } = await bot();
    expect(fake.openEventStreams).toBe(1);

    await chat.shutdown();
    await fake.eventStreamsClosed();

    expect(fake.openEventStreams).toBe(0);
  });
});

describe("errors", () => {
  const post = (chat: Bot["chat"]) => chat.thread(`signal:dm:${ALICE_ACI}`).post("hi");

  it.each([
    {
      kind: "authentication",
      error: { code: -32602, message: "Specified account does not exist" },
      expected: AuthenticationError,
    },
    {
      kind: "rate limit",
      error: {
        code: -5,
        message: "Failed to send message due to rate limiting",
        data: { response: { timestamp: 1, results: [{ type: "RATE_LIMIT_FAILURE", retryAfterSeconds: 42 }] } },
      },
      expected: AdapterRateLimitError,
      fields: { retryAfter: 42 },
    },
    {
      kind: "not found",
      error: { code: -1, message: `The user ${ALICE_ACI} is not registered.` },
      expected: ResourceNotFoundError,
      fields: { resourceType: "user", resourceId: ALICE_ACI },
    },
    {
      kind: "not found (per-recipient result)",
      error: {
        code: -1,
        message: "Failed to send message",
        data: { response: { timestamp: 1, results: [{ type: "UNREGISTERED_FAILURE", recipientAddress: { uuid: ALICE_ACI } }] } },
      },
      expected: ResourceNotFoundError,
      fields: { resourceType: "user", resourceId: ALICE_ACI },
    },
    {
      kind: "validation (invalid params)",
      error: { code: -32602, message: "Invalid params" },
      expected: ValidationError,
    },
    {
      kind: "validation (user error)",
      error: { code: -1, message: "Invalid textStyle syntax" },
      expected: ValidationError,
    },
    {
      kind: "network (I/O error)",
      error: { code: -3, message: "Failed to send: connection reset" },
      expected: NetworkError,
    },
    {
      kind: "network (every recipient failed on the network)",
      error: {
        code: -1,
        message: "Failed to send message",
        data: { response: { timestamp: 1, results: [{ type: "NETWORK_FAILURE", recipientAddress: { uuid: ALICE_ACI } }] } },
      },
      expected: NetworkError,
    },
  ] as Array<{ kind: string; error: JsonRpcError; expected: new (...args: never[]) => Error; fields?: object }>)(
    "maps a signal-cli $kind error to $expected.name",
    async ({ error, expected, fields }) => {
      const { fake, chat } = await bot();
      fake.failRpc("send", error);

      const failure = post(chat);
      await expect(failure).rejects.toBeInstanceOf(expected);
      await expect(failure).rejects.toMatchObject(fields ?? {});
    },
  );

  it("surfaces signal-cli going away after startup as a network error", async () => {
    const { fake, chat } = await bot();
    await fake.stop();

    await expect(post(chat)).rejects.toBeInstanceOf(NetworkError);
  });

  it("rejects a send result without a message timestamp as a network error", async () => {
    const { fake, chat } = await bot();
    fake.replyRpcRaw("send", { jsonrpc: "2.0", id: 1, result: { results: [] } });

    await expect(post(chat)).rejects.toBeInstanceOf(NetworkError);
  });

  it("rejects a JSON-RPC reply with neither result nor error as a network error", async () => {
    const fake = await FakeSignalCli.start();
    fake.replyRpcRaw("version", {});
    const { chat } = await bot({ fake, initialize: false });

    await expect(chat.initialize()).rejects.toThrow(
      expect.objectContaining({ name: "NetworkError", message: expect.stringContaining("malformed response") }),
    );
  });

  it("maps HTTP 429 with Retry-After to a rate-limit error", async () => {
    const fake = await FakeSignalCli.start();
    fake.httpStatus = 429;
    fake.httpHeaders = { "Retry-After": "30" };
    const { chat } = await bot({ fake, initialize: false });

    const failure = chat.initialize();
    await expect(failure).rejects.toBeInstanceOf(AdapterRateLimitError);
    await expect(failure).rejects.toMatchObject({ retryAfter: 30 });
  });

  it("explains a single-account daemon, which cannot report the Bot Account's ACI", async () => {
    const fake = await FakeSignalCli.start();
    fake.failRpc("listAccounts", { code: -32601, message: "Method not implemented" });
    const { chat } = await bot({ fake, initialize: false });

    await expect(chat.initialize()).rejects.toThrow(
      expect.objectContaining({ name: "ValidationError", message: expect.stringContaining("single-account mode") }),
    );
  });
});
