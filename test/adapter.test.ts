import {
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  ResourceNotFoundError,
  ValidationError,
} from "@chat-adapter/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignalAdapter } from "../src/index.js";
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

  it("warns when signal-cli is older than the tested minimum", async () => {
    const fake = await FakeSignalCli.start();
    fake.version = "0.13.22";
    const { logger } = await bot({ fake });

    const warnings = logger.entries.filter((entry) => entry.level === "warn");
    expect(warnings).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/signal-cli 0\.13\.22 is older than 0\.14\.9/) }),
    ]);
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

    const first = (await nextDirectMessage()).message.author;
    const second = (await nextDirectMessage()).message.author;
    expect([first.userId, first.fullName]).toEqual([ALICE_ACI, "+15551230001"]);
    expect([second.userId, second.fullName]).toEqual([BOB_ACI, BOB_ACI]);
  });

  it("ignores envelopes outside 1:1 text without stopping the stream", async () => {
    const { fake, nextDirectMessage } = await bot();
    const base = directTextEnvelope({ aci: ALICE_ACI, text: "ignored" });
    const { dataMessage, ...withoutData } = base;
    fake.injectEnvelope({ ...base, dataMessage: { ...dataMessage, groupInfo: { groupId: "Z3JvdXA=", type: "DELIVER" } } });
    fake.injectEnvelope({ ...base, dataMessage: { ...dataMessage, message: null, reaction: { emoji: "👍" } } });
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
      kind: "network",
      error: { code: -3, message: "Failed to send: connection reset" },
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
});
