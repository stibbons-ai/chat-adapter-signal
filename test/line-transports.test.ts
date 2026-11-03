import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthenticationError, NetworkError, ValidationError } from "@chat-adapter/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignalAdapter, type SignalTransportConfig } from "../src/index.js";
import { ALICE_ACI, BOT_ACCOUNT, BOT_ACI, directTextEnvelope, FakeSignalCli } from "./fake-signal-cli.js";
import { LineTransport } from "../src/transport/line.js";
import { fakeSignalCliOnPath, startBot, type Bot } from "./helpers.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

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

async function bot(fake: FakeSignalCli, transport: SignalTransportConfig, initialize = true): Promise<Bot> {
  const started = await startBot({ fake, config: { account: BOT_ACCOUNT, transport }, initialize });
  cleanups.push(() => started.chat.shutdown());
  return started;
}

async function socketPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "signal-line-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "signal-cli.sock");
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("spawn transport", () => {
  it("spawns `signal-cli -a <account> jsonRpc` from PATH by default", async () => {
    const fake = await startFake();
    await fakeSignalCliOnPath(fake);
    const { adapter } = await bot(fake, { type: "spawn" });

    expect(fake.spawns.map((spawn) => spawn.argv)).toEqual([["-a", BOT_ACCOUNT, "jsonRpc"]]);
    expect(adapter.botUserId).toBe(BOT_ACI);
  });

  it("runs the configured command with extra arguments before `-a <account> jsonRpc`", async () => {
    const fake = await startFake();
    await fakeSignalCliOnPath(fake);
    await bot(fake, {
      type: "spawn",
      command: process.execPath,
      args: [join(FIXTURES, "fake-signal-cli.mjs"), "--config", "/var/lib/signal-cli"],
    });

    expect(fake.spawns.map((spawn) => spawn.argv)).toEqual([
      ["--config", "/var/lib/signal-cli", "-a", BOT_ACCOUNT, "jsonRpc"],
    ]);
  });

  it("disconnect terminates the spawned process", async () => {
    const fake = await startFake();
    await fakeSignalCliOnPath(fake);
    const { chat } = await bot(fake, { type: "spawn" });
    const pid = fake.spawns[0]?.pid ?? 0;
    expect(isRunning(pid)).toBe(true);

    await chat.shutdown();

    expect(isRunning(pid)).toBe(false);
    await fake.lineConnectionsClosed();
    expect(fake.openLineConnections).toBe(0);
  });

  it("shutdown lets a running handler reply over the same process, then terminates it", async () => {
    const fake = await startFake();
    await fakeSignalCliOnPath(fake);
    const { chat, nextDirectMessage } = await bot(fake, { type: "spawn" });
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

    const shutdown = chat.shutdown();
    // Real wait on purpose: the drain must have begun before the handler replies.
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await shutdown;

    expect(fake.rpcRequests("send").map((request) => request.params?.message)).toEqual(["late reply"]);
    expect(fake.spawns).toHaveLength(1);
    expect(isRunning(fake.spawns[0]?.pid ?? 0)).toBe(false);
  });

  it("disconnect kills a process that ignores SIGTERM and stdin EOF", { timeout: 15_000 }, async () => {
    const fake = await startFake();
    await fakeSignalCliOnPath(fake);
    vi.stubEnv("FAKE_SIGNAL_CLI_STUBBORN", "1");
    const { chat } = await bot(fake, { type: "spawn" });
    const pid = fake.spawns[0]?.pid ?? 0;

    const started = Date.now();
    await chat.shutdown();

    expect(isRunning(pid)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
  });

  it("surfaces a process that exits after startup as a clear error, and fails requests in flight", async () => {
    const fake = await startFake();
    await fakeSignalCliOnPath(fake);
    const { chat, logger, nextDirectMessage } = await bot(fake, { type: "spawn" });
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "hi" }));
    const { thread } = await nextDirectMessage();
    const releaseSend = fake.hold("send");
    const post = thread.post("reply");
    await expect.poll(() => fake.rpcRequests("send").length).toBe(1);

    fake.dropLineConnections();

    const exited = expect.stringMatching(
      /^signal-cli \(signal-cli\) exited unexpectedly with code 3: ERROR fake signal-cli: lost connection to the daemon$/,
    );
    await expect(post).rejects.toThrow(expect.objectContaining({ name: "NetworkError", message: exited }));
    await expect.poll(() => logger.entries.find((entry) => entry.level === "error")?.args).toEqual([
      { error: expect.objectContaining({ name: "NetworkError", message: exited }) },
    ]);
    expect(logger.entries).toContainEqual(expect.objectContaining({ level: "warn", message: expect.stringMatching(/stream closed/) }));
    releaseSend();
    await chat.shutdown();
  });

  it("surfaces a process that exits during startup with its last stderr line", async () => {
    const fake = await startFake();
    await fakeSignalCliOnPath(fake);
    vi.stubEnv("FAKE_SIGNAL_CLI_FAIL", `User ${BOT_ACCOUNT} is not registered.`);
    const { chat } = await bot(fake, { type: "spawn" }, false);

    await expect(chat.initialize()).rejects.toThrow(
      expect.objectContaining({
        name: "NetworkError",
        message: `signal-cli (signal-cli) exited unexpectedly with code 1: User ${BOT_ACCOUNT} is not registered.`,
      }),
    );
  });

  it("terminates the spawned process when startup fails after it started", async () => {
    const fake = await startFake();
    await fakeSignalCliOnPath(fake);
    fake.accounts = [{ number: "+15559999999", aci: ALICE_ACI }];
    const { chat } = await bot(fake, { type: "spawn" }, false);

    await expect(chat.initialize()).rejects.toBeInstanceOf(AuthenticationError);

    const pid = fake.spawns[0]?.pid ?? 0;
    await expect.poll(() => isRunning(pid)).toBe(false);
    await chat.shutdown();
  });

  it("fails startup clearly when the command cannot be started", async () => {
    const fake = await startFake();
    const { chat } = await bot(fake, { type: "spawn", command: "/nonexistent/signal-cli" }, false);

    const failure = chat.initialize();
    await expect(failure).rejects.toBeInstanceOf(NetworkError);
    await expect(failure).rejects.toThrow(/starting \/nonexistent\/signal-cli failed \(spawn \/nonexistent\/signal-cli ENOENT\)/);
  });
});

describe("socket and TCP transports", () => {
  it("disconnect closes the Unix socket", async () => {
    const fake = await startFake();
    const path = await socketPath();
    await fake.listenSocket(path);
    const { chat } = await bot(fake, { type: "socket", path });
    expect(fake.openLineConnections).toBe(1);

    await chat.shutdown();

    await fake.lineConnectionsClosed();
    expect(fake.openLineConnections).toBe(0);
  });

  it("disconnect closes the TCP connection", async () => {
    const fake = await startFake();
    const port = await fake.listenTcp();
    const { chat } = await bot(fake, { type: "tcp", host: "127.0.0.1", port });
    expect(fake.openLineConnections).toBe(1);

    await chat.shutdown();

    await fake.lineConnectionsClosed();
    expect(fake.openLineConnections).toBe(0);
  });

  it("closes the connection when startup fails after connecting", async () => {
    const fake = await startFake();
    const port = await fake.listenTcp();
    fake.accounts = [{ number: "+15559999999", aci: ALICE_ACI }];
    const { chat } = await bot(fake, { type: "tcp", host: "127.0.0.1", port }, false);

    await expect(chat.initialize()).rejects.toBeInstanceOf(AuthenticationError);

    await expect.poll(() => fake.openLineConnections).toBe(0);
  });

  it("fails startup with a network error when nothing listens", async () => {
    const fake = await startFake();
    const path = await socketPath();
    const { chat } = await bot(fake, { type: "socket", path }, false);

    await expect(chat.initialize()).rejects.toThrow(
      expect.objectContaining({ name: "NetworkError", message: expect.stringContaining(`connecting to unix:${path} failed`) }),
    );
  });

  it("ignores events for other accounts on a multi-account daemon", async () => {
    const fake = await startFake();
    const port = await fake.listenTcp();
    const { nextDirectMessage } = await bot(fake, { type: "tcp", host: "127.0.0.1", port });

    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "for someone else" }), "+15559999999");
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "for the bot" }));

    expect((await nextDirectMessage()).message.text).toBe("for the bot");
  });

  it("keeps a message that arrives before the event stream is subscribed", async () => {
    const fake = await startFake();
    const port = await fake.listenTcp();
    const releaseVersion = fake.hold("version");
    const { chat, nextDirectMessage } = await bot(fake, { type: "tcp", host: "127.0.0.1", port }, false);
    const started = chat.initialize();
    await expect.poll(() => fake.rpcRequests("version").length).toBe(1);

    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "early" }));
    releaseVersion();
    await started;

    expect((await nextDirectMessage()).message.text).toBe("early");
  });

  it("skips malformed lines and keeps receiving", async () => {
    const fake = await startFake();
    const port = await fake.listenTcp();
    const { logger, nextDirectMessage } = await bot(fake, { type: "tcp", host: "127.0.0.1", port });

    fake.injectLine('{"jsonrpc":"2.0","method":"receive","params":{"envelope":{"secret":"+15550001111"');
    fake.injectLine([1, 2]);
    fake.injectLine({ jsonrpc: "2.0", method: "receive" });
    fake.injectLine({ jsonrpc: "2.0", method: "callEvent", params: {} });
    fake.injectLine({ jsonrpc: "2.0", id: 999, result: {} });
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "still here" }));

    expect((await nextDirectMessage()).message.text).toBe("still here");
    const errors = logger.entries.filter((entry) => entry.level === "error");
    expect(errors.map((entry) => (entry.args[0] as { error: Error }).error)).toEqual([
      expect.any(ValidationError),
      expect.any(ValidationError),
      expect.any(ValidationError),
    ]);
    expect(JSON.stringify(errors.map((entry) => String((entry.args[0] as { error: Error }).error)))).not.toContain("+1555");
  });

  it("maps JSON-RPC errors from a line connection to shared error classes", async () => {
    const fake = await startFake();
    const port = await fake.listenTcp();
    fake.failRpc("send", { code: -32602, message: "Specified account does not exist" });
    const { nextDirectMessage } = await bot(fake, { type: "tcp", host: "127.0.0.1", port });
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "hi" }));
    const { thread } = await nextDirectMessage();

    await expect(thread.post("reply")).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("fails requests in flight and reports the error when the connection is reset", async () => {
    const fake = await startFake();
    const port = await fake.listenTcp();
    const { logger, nextDirectMessage } = await bot(fake, { type: "tcp", host: "127.0.0.1", port });
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "hi" }));
    const { thread } = await nextDirectMessage();
    const releaseSend = fake.hold("send");
    const post = thread.post("reply");
    await expect.poll(() => fake.rpcRequests("send").length).toBe(1);

    fake.resetLineConnections();

    const reset = expect.stringMatching(new RegExp(`^signal-cli closed the connection \\(tcp://127\\.0\\.0\\.1:${port}\\): .*ECONNRESET`));
    await expect(post).rejects.toThrow(expect.objectContaining({ name: "NetworkError", message: reset }));
    await expect.poll(() => logger.entries.find((entry) => entry.level === "error")?.args).toEqual([
      { error: expect.objectContaining({ message: reset }) },
    ]);
    releaseSend();
  });

  it("rejects startup cancelled by shutdown with STARTUP_CANCELLED, not the closed connection", async () => {
    const fake = await startFake();
    const port = await fake.listenTcp();
    const releaseAccounts = fake.hold("listAccounts");
    const { chat } = await bot(fake, { type: "tcp", host: "127.0.0.1", port }, false);
    const started = chat.initialize();
    await expect.poll(() => fake.rpcRequests("listAccounts").length).toBe(1);

    await chat.shutdown();
    releaseAccounts();

    await expect(started).rejects.toMatchObject({ code: "STARTUP_CANCELLED" });
    await expect.poll(() => fake.openLineConnections).toBe(0);
  });

  it("fails requests that signal-cli answers with an id-less error instead of hanging", async () => {
    const fake = await startFake();
    const port = await fake.listenTcp();
    fake.replyRpcRaw("version", { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    const { chat } = await bot(fake, { type: "tcp", host: "127.0.0.1", port }, false);

    await expect(chat.initialize()).rejects.toThrow(
      expect.objectContaining({ code: "SIGNAL_CLI_ERROR", message: expect.stringContaining("Parse error") }),
    );
  });

  it("matches replies to requests by id when signal-cli answers out of order", async () => {
    const fake = await startFake();
    const port = await fake.listenTcp();
    const { nextDirectMessage } = await bot(fake, { type: "tcp", host: "127.0.0.1", port });
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "hi" }));
    const { thread } = await nextDirectMessage();

    const releaseFirst = fake.holdNext("send");
    const first = thread.post("first");
    await expect.poll(() => fake.rpcRequests("send").length).toBe(1);
    const second = await thread.post("second");
    releaseFirst();

    expect(second.id).toBe(`${BOT_ACI}:1700000000000`);
    expect((await first).id).toBe(`${BOT_ACI}:1700000000001`);
  });

  it("drops messages on a connection a late reply reopened after shutdown, instead of replaying them", async () => {
    const fake = await startFake();
    const port = await fake.listenTcp();
    const started = await startBot({
      fake,
      config: { account: BOT_ACCOUNT, transport: { type: "tcp", host: "127.0.0.1", port }, drainTimeoutMs: 0 },
    });
    cleanups.push(() => started.chat.shutdown());
    const { chat, adapter, nextDirectMessage } = started;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Through the adapter: after shutdown, `thread.post` would fail recording the post in Chat's
    // (now disconnected) history, after signal-cli sent it.
    const replied = new Promise<void>((resolve) => {
      chat.onDirectMessage(async (thread) => {
        await gate;
        await adapter.postMessage(thread.id, "late reply");
        resolve();
      });
    });
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "hi" }));
    const { thread } = await nextDirectMessage();
    await chat.shutdown();
    release();
    await replied;

    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "while nobody listens" }));
    // The fake writes in order: once this reply is back, the message above has reached the adapter.
    await adapter.postMessage(thread.id, "barrier");
    await chat.initialize();
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "after restart" }));

    expect((await nextDirectMessage()).message.text).toBe("after restart");
  });

  it("reconnects for the next request after the daemon dropped the connection", async () => {
    const fake = await startFake();
    const port = await fake.listenTcp();
    const { logger, nextDirectMessage } = await bot(fake, { type: "tcp", host: "127.0.0.1", port });
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "hi" }));
    const { thread } = await nextDirectMessage();

    fake.dropLineConnections();
    await expect.poll(() => logger.entries.some((entry) => /stream closed/.test(entry.message))).toBe(true);
    const sent = await thread.post("after the drop");

    expect(sent.id).toBe(`${BOT_ACI}:1700000000000`);
    expect(fake.openLineConnections).toBe(1);
  });
});

describe("reconnect on line transports", () => {
  /** Each line transport, wired to the fake, with a way to bring a stopped daemon back. */
  const variants: Record<string, (fake: FakeSignalCli) => Promise<{ transport: SignalTransportConfig; restart(): Promise<unknown> }>> = {
    socket: async (fake) => {
      const path = await socketPath();
      await fake.listenSocket(path);
      return { transport: { type: "socket", path }, restart: () => fake.listenSocket(path) };
    },
    tcp: async (fake) => {
      const port = await fake.listenTcp();
      return { transport: { type: "tcp", host: "127.0.0.1", port }, restart: () => fake.listenTcp(port) };
    },
    spawn: async (fake) => {
      await fakeSignalCliOnPath(fake);
      const port = Number(process.env.FAKE_SIGNAL_CLI_PORT);
      return { transport: { type: "spawn" }, restart: () => fake.listenTcp(port) };
    },
  };

  it.each(Object.keys(variants))(
    "%s: reconnects with backoff while signal-cli is down, then handles each new message once",
    async (type) => {
      const fake = await startFake();
      const { transport, restart } = await (variants[type] as (typeof variants)[string])(fake);
      const started = await startBot({
        fake,
        config: { account: BOT_ACCOUNT, transport, reconnect: { minDelayMs: 5, maxDelayMs: 20 } },
      });
      cleanups.push(() => started.chat.shutdown());
      const { logger, nextDirectMessage } = started;
      fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "before" }));
      expect((await nextDirectMessage()).message.text).toBe("before");

      await fake.stopLineServers();
      const attempts = () => logger.entries.filter((entry) => /reconnecting in \d+ ms/.test(entry.message)).length;
      // At least two attempts failed while the daemon was down: the backoff kept retrying.
      await expect.poll(attempts).toBeGreaterThanOrEqual(3);
      await restart();
      await expect.poll(() => fake.openLineConnections).toBe(1);
      await expect.poll(() => logger.entries.some((entry) => /^Reconnected to the signal-cli event stream/.test(entry.message))).toBe(true);

      fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "after" }));
      expect((await nextDirectMessage()).message.text).toBe("after");
      // No second "after" was handled in between: the next message is the sentinel.
      fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "sentinel" }));
      expect((await nextDirectMessage()).message.text).toBe("sentinel");
      // Line transports have no event IDs: nothing is resumed, and no cursor is written.
      expect(await started.chat.getState().get(`signal:receive-cursor:${BOT_ACCOUNT}`)).toBeNull();
      if (type === "spawn") {
        expect(fake.spawns.length).toBeGreaterThanOrEqual(2);
      }
    },
  );

  it("subscribe rejects for an aborted signal, and an abort afterwards stops delivery without onClosed", async () => {
    const fake = await startFake();
    const port = await fake.listenTcp();
    const transport = new LineTransport({ type: "tcp", host: "127.0.0.1", port }, BOT_ACCOUNT, 60_000);
    cleanups.push(() => transport.close());
    const events: unknown[] = [];
    const listener = { onEvent: (event: unknown) => events.push(event), onError: () => {}, onClosed: vi.fn() };

    await expect(transport.subscribe(listener, { signal: AbortSignal.abort() })).rejects.toThrow();

    const abort = new AbortController();
    await transport.subscribe(listener, { signal: abort.signal });
    await expect.poll(() => fake.openLineConnections).toBe(1);
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "one" }));
    await expect.poll(() => events.length).toBe(1);
    abort.abort();
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "two" }));
    fake.dropLineConnections();
    await expect.poll(() => fake.openLineConnections).toBe(0);
    expect(events).toHaveLength(1);
    expect(listener.onClosed).not.toHaveBeenCalled();
  });

  it("an abort while still connecting rejects subscribe at once with the abort reason", async () => {
    const transport = new LineTransport({ type: "tcp", host: "127.0.0.1", port: 1 }, BOT_ACCOUNT, 60_000);
    // A connect that never answers (a TCP host that drops SYNs), released only by the cleanup.
    let fail!: (error: Error) => void;
    Object.assign(transport, { open: () => new Promise((_, reject) => (fail = reject)) });
    cleanups.push(async () => {
      fail(new Error("released"));
      await transport.close();
    });
    const abort = new AbortController();
    const subscribing = transport.subscribe({ onEvent: () => {}, onError: () => {}, onClosed: () => {} }, { signal: abort.signal });

    const reason = new Error("stopping");
    abort.abort(reason);

    await expect(subscribing).rejects.toBe(reason);
  });

  it("keeps events pushed on a connection a reply reopened after a drop, for the next subscribe", async () => {
    const fake = await startFake();
    const port = await fake.listenTcp();
    const transport = new LineTransport({ type: "tcp", host: "127.0.0.1", port }, BOT_ACCOUNT, 60_000);
    cleanups.push(() => transport.close());
    const events: unknown[] = [];
    const closed = vi.fn();
    const listener = { onEvent: (event: unknown) => events.push(event), onError: () => {}, onClosed: closed };
    await transport.subscribe(listener);
    await expect.poll(() => fake.openLineConnections).toBe(1);

    fake.dropLineConnections();
    await expect.poll(() => closed.mock.calls.length).toBe(1);
    await transport.request("version"); // a handler's reply during the receive loop's backoff
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "pushed meanwhile" }));
    await transport.request("version"); // the fake answers in order, so the notification is in by now
    await transport.subscribe(listener);

    expect(events).toHaveLength(1);
  });

  it("keeps the buffered events through a second drop before the next subscribe, at most 1 000", async () => {
    const fake = await startFake();
    const port = await fake.listenTcp();
    const transport = new LineTransport({ type: "tcp", host: "127.0.0.1", port }, BOT_ACCOUNT, 60_000);
    cleanups.push(() => transport.close());
    const events: unknown[] = [];
    const closed = vi.fn();
    const listener = { onEvent: (event: unknown) => events.push(event), onError: () => {}, onClosed: closed };
    await transport.subscribe(listener);
    await expect.poll(() => fake.openLineConnections).toBe(1);
    fake.dropLineConnections();
    await expect.poll(() => closed.mock.calls.length).toBe(1);

    await transport.request("version");
    for (let i = 0; i < 1_001; i++) {
      fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: `m${i}` }));
    }
    await transport.request("version");
    fake.dropLineConnections();
    await expect.poll(() => fake.openLineConnections).toBe(0);
    await transport.subscribe(listener);

    expect(events).toHaveLength(1_000);
  });

  it("closing an older subscription of the same listener leaves the newer one delivering", async () => {
    const fake = await startFake();
    const port = await fake.listenTcp();
    const transport = new LineTransport({ type: "tcp", host: "127.0.0.1", port }, BOT_ACCOUNT, 60_000);
    cleanups.push(() => transport.close());
    const events: unknown[] = [];
    const listener = { onEvent: (event: unknown) => events.push(event), onError: () => {}, onClosed: () => {} };

    const older = await transport.subscribe(listener);
    await transport.subscribe(listener);
    await older.close();
    await expect.poll(() => fake.openLineConnections).toBe(1);
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "still here" }));

    await expect.poll(() => events.length).toBe(1);
  });
});

describe("line transport configuration", () => {
  it.each([
    [{ type: "spawn", command: "" }, "transport.command must be a non-empty string"],
    [{ type: "spawn", args: "--config /x" }, "transport.args must be an array of strings"],
    [{ type: "spawn", args: [1] }, "transport.args must be an array of strings"],
    [{ type: "socket" }, "transport.path is required"],
    [{ type: "socket", path: "" }, "transport.path is required"],
    [{ type: "tcp", port: 7583 }, "transport.host is required"],
    [{ type: "tcp", host: "localhost" }, "transport.port must be an integer from 1 to 65535"],
    [{ type: "tcp", host: "localhost", port: 0 }, "transport.port must be an integer from 1 to 65535"],
    [{ type: "tcp", host: "localhost", port: 65_536 }, "transport.port must be an integer from 1 to 65535"],
    [{ type: "tcp", host: "localhost", port: "7583" }, "transport.port must be an integer from 1 to 65535"],
  ])("rejects %j", (transport, message) => {
    expect(() =>
      createSignalAdapter({ account: BOT_ACCOUNT, transport: transport as unknown as SignalTransportConfig }),
    ).toThrow(expect.objectContaining({ name: "ValidationError", message: expect.stringContaining(message) }));
  });
});
