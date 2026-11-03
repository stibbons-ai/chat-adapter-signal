import { setTimeout as sleep } from "node:timers/promises";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat, type StateAdapter } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignalAdapter, type SignalAdapterConfig } from "../src/index.js";
import { BOT_ACCOUNT, directTextEnvelope, FakeSignalCli } from "./fake-signal-cli.js";
import { recordingLogger } from "./helpers.js";

const CURSOR_KEY = `signal:receive-cursor:${BOT_ACCOUNT}`;
const ALICE = "11111111-1111-4111-8111-111111111111";

/** Resolves once `check` holds; fails after 2 s. */
const until = (check: () => boolean | Promise<boolean>, what: string) =>
  expect.poll(check, { timeout: 2_000, message: `waiting for ${what}` }).toBe(true);

interface HostApp {
  chat: Chat;
  state: StateAdapter;
  logger: ReturnType<typeof recordingLogger>;
  /** Texts handed to `onDirectMessage`, in call order. */
  handled: string[];
  /** Texts whose handler finished. */
  finished: string[];
  /** Makes the handler for `text` wait until the returned function is called. */
  block(text: string): () => void;
}

const running: Chat[] = [];
const fakes: FakeSignalCli[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(running.splice(0).map((chat) => chat.shutdown()));
  await Promise.all(fakes.splice(0).map((fake) => fake.stop()));
});

async function startFake(): Promise<FakeSignalCli> {
  const fake = await FakeSignalCli.start();
  fakes.push(fake);
  return fake;
}

/**
 * A Host App process: a real `Chat` with the Signal adapter. Pass the same
 * `state` to a second Host App to simulate a restart against a persistent state store.
 */
async function startHostApp(
  fake: FakeSignalCli,
  options: { state?: StateAdapter; config?: Partial<SignalAdapterConfig>; dedupeTtlMs?: number } = {},
): Promise<HostApp> {
  const state = options.state ?? createMemoryState();
  const logger = recordingLogger();
  const adapter = createSignalAdapter({
    account: BOT_ACCOUNT,
    transport: { type: "http", url: fake.url },
    reconnect: { minDelayMs: 5, maxDelayMs: 20 },
    ...options.config,
  });
  const chat = new Chat({
    userName: "bot",
    adapters: { signal: adapter },
    state,
    logger,
    concurrency: "concurrent",
    ...(options.dedupeTtlMs === undefined ? {} : { dedupeTtlMs: options.dedupeTtlMs }),
  });
  const handled: string[] = [];
  const finished: string[] = [];
  const blocks = new Map<string, Promise<void>>();
  chat.onDirectMessage(async (_thread, message) => {
    handled.push(message.text);
    await blocks.get(message.text);
    finished.push(message.text);
  });
  await chat.initialize();
  running.push(chat);
  return {
    chat,
    state,
    logger,
    handled,
    finished,
    block(text) {
      let release!: () => void;
      blocks.set(text, new Promise((resolve) => (release = resolve)));
      return release;
    },
  };
}

function send(fake: FakeSignalCli, text: string): string {
  fake.injectEnvelope(directTextEnvelope({ aci: ALICE, text }));
  return fake.lastEventId;
}

function eventRequests(fake: FakeSignalCli) {
  return fake.requests.filter((request) => request.path.startsWith("/api/v1/events"));
}

async function cursor(app: HostApp): Promise<unknown> {
  return app.state.get(CURSOR_KEY);
}

async function shutdown(app: HostApp): Promise<void> {
  running.splice(running.indexOf(app.chat), 1);
  await app.chat.shutdown();
}

describe("reconnect", () => {
  it("reconnects after signal-cli closes the event stream and keeps delivering messages", async () => {
    const fake = await startFake();
    const app = await startHostApp(fake);

    fake.closeEventStreams();
    await until(() => eventRequests(fake).length >= 2 && fake.openEventStreams === 1, "the reconnect");
    send(fake, "after the drop");

    await until(() => app.finished.includes("after the drop"), "the message after the reconnect");
    expect(app.logger.entries.some((entry) => entry.level === "warn" && entry.message.includes("reconnecting in"))).toBe(
      true,
    );
  });

  it("backs off exponentially while signal-cli is unreachable, then reconnects", async () => {
    const fake = await startFake();
    vi.spyOn(Math, "random").mockReturnValue(1); // no jitter: each logged delay is its nominal value
    const app = await startHostApp(fake, { config: { reconnect: { minDelayMs: 5, maxDelayMs: 1_000 } } });
    const before = eventRequests(fake).length;

    fake.httpStatus = 503;
    fake.closeEventStreams();
    await until(() => eventRequests(fake).length >= before + 4, "four reconnect attempts");
    fake.httpStatus = 200;
    await until(() => fake.openEventStreams === 1, "the reconnect once signal-cli is back");

    const delays = app.logger.entries.flatMap((entry) => /reconnecting in (\d+) ms/.exec(entry.message)?.[1] ?? []);
    expect(delays.slice(0, 4).map(Number)).toEqual([5, 10, 20, 40]);
  });

  it("stops reconnecting on shutdown", async () => {
    const fake = await startFake();
    const app = await startHostApp(fake, { config: { reconnect: { minDelayMs: 50, maxDelayMs: 50 } } });

    fake.closeEventStreams();
    await fake.eventStreamsClosed();
    await shutdown(app);
    const after = eventRequests(fake).length;
    await sleep(120);

    expect(eventRequests(fake).length).toBe(after);
    expect(fake.openEventStreams).toBe(0);
  });

  it("aborts a reconnect whose event stream request signal-cli never answers when the Host App shuts down", async () => {
    const fake = await startFake();
    const app = await startHostApp(fake);
    fake.hold("events");
    fake.closeEventStreams();
    await until(() => eventRequests(fake).length >= 2, "the held reconnect request");

    const started = Date.now();
    await shutdown(app);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fake.openEventStreams).toBe(0);
  });

  it("reconnects when the event stream goes silent without closing (no keep-alives within idleTimeoutMs)", async () => {
    const fake = await startFake();
    // Every idleTimeoutMs the stream dies and is replaced, so an event can land on a stream the client is
    // already aborting. A stored cursor makes each reconnect send Last-Event-ID, so the replay delivers it;
    // without one, signal-cli replays nothing and the event would be lost.
    const state = createMemoryState();
    await state.connect();
    await state.set(CURSOR_KEY, { lastEventId: fake.lastEventId, processed: [] });
    const app = await startHostApp(fake, { state, config: { transport: { type: "http", url: fake.url, idleTimeoutMs: 50 } } });

    await until(() => eventRequests(fake).length >= 2, "the reconnect after the idle timeout");
    const idleErrors = app.logger.entries.filter(
      (entry) => entry.level === "error" && String((entry.args[0] as { error?: Error })?.error?.message).includes("No data on the event stream"),
    );
    expect(idleErrors.length).toBeGreaterThan(0);
    send(fake, "after idle reconnect");
    await until(() => app.finished.includes("after idle reconnect"), "a message after the idle reconnect");
  });

  it("retries a reconnect whose event stream request gets no response within idleTimeoutMs", async () => {
    const fake = await startFake();
    const app = await startHostApp(fake, { config: { transport: { type: "http", url: fake.url, idleTimeoutMs: 100 } } });
    const release = fake.hold("events");
    fake.closeEventStreams();

    await until(() => eventRequests(fake).length >= 3, "a retry after the unanswered request");
    release();
    await until(() => fake.openEventStreams >= 1, "the reconnect once signal-cli answers");
    expect(
      app.logger.entries.some((entry) => String((entry.args[0] as { error?: Error })?.error?.message).includes("No data on the event stream")),
    ).toBe(true);
  });

  it("keeps a silent stream open while signal-cli sends keep-alives", async () => {
    const fake = await startFake();
    await startHostApp(fake, { config: { transport: { type: "http", url: fake.url, idleTimeoutMs: 200 } } });
    const keepAlive = setInterval(() => fake.injectRaw(":\n"), 20);
    try {
      await sleep(450);
    } finally {
      clearInterval(keepAlive);
    }
    expect(eventRequests(fake)).toHaveLength(1);
  });

  it("rejects an invalid idleTimeoutMs", () => {
    const make = (idleTimeoutMs: number) => () =>
      createSignalAdapter({ account: BOT_ACCOUNT, transport: { type: "http", url: "http://x", idleTimeoutMs } });
    expect(make(0)).toThrow(/transport.idleTimeoutMs must be an integer from 1/);
    expect(make(2 ** 31)).toThrow(/idleTimeoutMs/);
    expect(make(1)).not.toThrow();
  });

  it("rejects invalid reconnect delays", () => {
    const make = (reconnect: NonNullable<SignalAdapterConfig["reconnect"]>) => () =>
      createSignalAdapter({ account: BOT_ACCOUNT, transport: { type: "http", url: "http://x" }, reconnect });
    expect(make({ minDelayMs: 0 })).toThrow(/minDelayMs must be an integer from 1/);
    expect(make({ maxDelayMs: 2 ** 31 })).toThrow(/maxDelayMs must be an integer/);
    expect(make({ minDelayMs: 1.5 })).toThrow(/minDelayMs/);
    expect(make({ minDelayMs: 100, maxDelayMs: 50 })).toThrow(/must not be smaller/);
    expect(make({ minDelayMs: 1, maxDelayMs: 1 })).not.toThrow();
  });
});

describe("resume from the stored cursor", () => {
  it("stores the last processed event ID and sends it as Last-Event-ID on reconnect, replaying missed events", async () => {
    const fake = await startFake();
    const app = await startHostApp(fake);
    const id = send(fake, "one");
    await until(async () => JSON.stringify(await cursor(app)) === JSON.stringify({ lastEventId: id, processed: [] }), "the cursor");

    // Close the server side, then queue an event while no stream is open: only the replay can deliver it.
    fake.closeEventStreams();
    await fake.eventStreamsClosed();
    send(fake, "while disconnected");

    await until(() => app.finished.includes("while disconnected"), "the replayed event");
    expect(eventRequests(fake).at(-1)?.headers["last-event-id"]).toBe(id);
    expect(app.handled).toEqual(["one", "while disconnected"]);
  });

  it("sends the stored cursor as Last-Event-ID after a Host App restart", async () => {
    const fake = await startFake();
    const state = createMemoryState();
    const first = await startHostApp(fake, { state });
    const id = send(fake, "before restart");
    await until(() => first.finished.includes("before restart"), "the first message");
    await shutdown(first);
    send(fake, "while the Host App was down");

    const second = await startHostApp(fake, { state });

    expect(eventRequests(fake).at(-1)?.headers["last-event-id"]).toBe(id);
    await until(() => second.finished.includes("while the Host App was down"), "the replayed event");
    expect(second.handled).toEqual(["while the Host App was down"]);
  });

  it("sends no Last-Event-ID before any event was processed", async () => {
    const fake = await startFake();
    await startHostApp(fake);
    expect(eventRequests(fake)[0]?.headers["last-event-id"]).toBeUndefined();
  });

  it("delivers an event without an SSE id and keeps the cursor at the last ID", async () => {
    const fake = await startFake();
    const app = await startHostApp(fake);
    const id = send(fake, "with id");
    const data = JSON.stringify({ account: BOT_ACCOUNT, envelope: directTextEnvelope({ aci: ALICE, text: "without id" }) });
    fake.injectRaw(`event:receive\ndata:${data}\n\n`);

    await until(() => app.finished.includes("without id"), "the event without an id");
    expect(app.handled).toEqual(["with id", "without id"]);
    expect(await cursor(app)).toEqual({ lastEventId: id, processed: [] });
  });

  it("treats an event ID that is not printable ASCII as no ID (it could not be sent back as a header)", async () => {
    const fake = await startFake();
    const app = await startHostApp(fake);
    const id = send(fake, "with id");
    const data = JSON.stringify({ account: BOT_ACCOUNT, envelope: directTextEnvelope({ aci: ALICE, text: "odd id" }) });
    fake.injectRaw(`id:7-\u20ac\nevent:receive\ndata:${data}\n\n`);

    await until(() => app.finished.includes("odd id"), "the event with the odd id");
    expect(await cursor(app)).toEqual({ lastEventId: id, processed: [] });
  });

  it("ignores a malformed stored cursor with a warning", async () => {
    const fake = await startFake();
    const state = createMemoryState();
    await state.connect();
    for (const [index, stored] of [
      { lastEventId: "1-\u20ac\r\n", processed: [] },
      { lastEventId: "1-1", processed: [1] },
      { lastEventId: "1-1", processed: "x" },
      "nope",
    ].entries()) {
      await state.connect(); // chat.shutdown() disconnects it
      await state.set(CURSOR_KEY, stored);
      const app = await startHostApp(fake, { state });

      expect(eventRequests(fake)[index]?.headers["last-event-id"]).toBeUndefined();
      expect(app.logger.entries.some((entry) => entry.message.includes("malformed Signal receive cursor"))).toBe(true);
      await shutdown(app);
    }
  });

  it("resumes from the whole buffer after signal-cli restarted (the stored ID is unknown to the new run)", async () => {
    const fake = await startFake();
    const app = await startHostApp(fake);
    send(fake, "old run");
    await until(() => app.finished.includes("old run"), "the first message");

    fake.restartDaemon();
    send(fake, "new run, before the reconnect");

    await until(() => app.finished.includes("new run, before the reconnect"), "the replayed event");
    expect(app.handled).toEqual(["old run", "new run, before the reconnect"]);
  });
});

describe("isolation", () => {
  it("keeps one cursor per Bot Account when several bots share a state store", async () => {
    const state = createMemoryState();
    const first = await startFake();
    const second = await startFake();
    const otherAccount = "+15550000002";
    second.accounts = [{ number: otherAccount, aci: "00000000-0000-4000-8000-000000000002" }];
    const a = await startHostApp(first, { state });
    const b = await startHostApp(second, { state, config: { account: otherAccount } });
    const idA = send(first, "for bot a");
    const idB = send(second, "for bot b");
    await until(() => a.finished.length === 1 && b.finished.length === 1, "both bots");

    await until(async () => (await state.get<{ lastEventId?: string }>(CURSOR_KEY))?.lastEventId === idA, "bot a's cursor");
    await until(
      async () => (await state.get<{ lastEventId?: string }>(`signal:receive-cursor:${otherAccount}`))?.lastEventId === idB,
      "bot b's cursor",
    );
    expect(a.handled).toEqual(["for bot a"]);
    expect(b.handled).toEqual(["for bot b"]);
  });
});

describe("cursor advances only after processMessage completes", () => {
  it("holds the cursor while the handler runs", async () => {
    const fake = await startFake();
    const app = await startHostApp(fake);
    const release = app.block("slow");
    const id = send(fake, "slow");

    await until(() => app.handled.includes("slow"), "the handler to start");
    await sleep(20);
    expect(await cursor(app)).toBeNull();

    release();
    await until(async () => (await cursor(app) as { lastEventId?: string } | null)?.lastEventId === id, "the cursor");
  });

  it("does not move past an earlier event that is still running", async () => {
    const fake = await startFake();
    const app = await startHostApp(fake);
    const first = send(fake, "first");
    await until(() => app.finished.includes("first"), "the first message");
    const release = app.block("slow");
    send(fake, "slow");
    const fast = send(fake, "fast");

    await until(() => app.finished.includes("fast"), "the fast handler");
    await until(
      async () => JSON.stringify(await cursor(app)) === JSON.stringify({ lastEventId: first, processed: [fast] }),
      "the cursor to record the fast event beyond the slow one",
    );

    release();
    await until(async () => JSON.stringify(await cursor(app)) === JSON.stringify({ lastEventId: fast, processed: [] }), "the cursor");
  });
});

describe("replayed events never trigger a handler twice", () => {
  // Chat's own message-ID dedupe expires after 1 ms here, so only the adapter's replay check can prevent a second call.
  const dedupeTtlMs = 1;

  it("skips replayed events that are still running or already processed after a reconnect", async () => {
    const fake = await startFake();
    const app = await startHostApp(fake, { dedupeTtlMs });
    send(fake, "first");
    await until(() => app.finished.includes("first"), "the first message");
    const release = app.block("slow");
    send(fake, "slow");
    send(fake, "fast");
    await until(() => app.finished.includes("fast"), "the fast handler");

    // The reconnect resumes after "first", so signal-cli replays "slow" (running) and "fast" (done).
    fake.closeEventStreams();
    await until(() => eventRequests(fake).length >= 2 && fake.openEventStreams === 1, "the reconnect");
    send(fake, "after");
    await until(() => app.finished.includes("after"), "the next live message");
    release();
    await until(() => app.finished.includes("slow"), "the slow handler");

    expect(app.handled).toEqual(["first", "slow", "fast", "after"]);
  });

  it("skips events processed before a Host App restart when signal-cli replays them", async () => {
    const fake = await startFake();
    const state = createMemoryState();
    const first = await startHostApp(fake, { state, dedupeTtlMs, config: { drainTimeoutMs: 0 } });
    send(fake, "first");
    await until(() => first.finished.includes("first"), "the first message");
    first.block("cut off");
    send(fake, "cut off");
    send(fake, "done before restart");
    await until(() => first.finished.includes("done before restart"), "the fast handler");
    // A shutdown that does not wait for "cut off" stands in for a crash during its handler.
    await shutdown(first);

    const second = await startHostApp(fake, { state, dedupeTtlMs });
    await until(() => second.finished.includes("cut off"), "the replay of the unfinished event");
    send(fake, "after restart");
    await until(() => second.finished.includes("after restart"), "the next live message");

    expect(second.handled).toEqual(["cut off", "after restart"]);
    await until(
      async () => JSON.stringify(await cursor(second)) === JSON.stringify({ lastEventId: fake.lastEventId, processed: [] }),
      "the cursor to pass the skipped replay",
    );
  });
});
