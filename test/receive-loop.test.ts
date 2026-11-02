import { createMemoryState } from "@chat-adapter/state-memory";
import type { StateAdapter } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReceiveEvent } from "../src/envelope.js";
import { ReceiveLoop } from "../src/receive-loop.js";
import type { EventListener, SignalTransport, SubscribeOptions } from "../src/transport/types.js";
import { recordingLogger } from "./helpers.js";

// Every transport implements this seam, so the loop is tested against a scripted one,
// which makes its timing deterministic where the HTTP fake cannot.

const KEY = "cursor";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/** A transport whose `subscribe` calls are recorded and answered by `behaviour`. */
class ScriptedTransport implements SignalTransport {
  readonly endpoint = "scripted";
  readonly subscribes: SubscribeOptions[] = [];
  listener: EventListener | undefined;
  closes = 0;
  /** When false, a held subscribe resolves even after its signal aborted, like a transport that connected just in time. */
  honourAbort = true;
  /** Decides each subscribe by its 0-based index: resolve (default), reject, or hold. */
  behaviour: (index: number, listener: EventListener) => "ok" | Error | Promise<void> = () => "ok";

  async checkReachable(): Promise<void> {}

  async request<T>(): Promise<T> {
    throw new Error("not used");
  }

  async close(): Promise<void> {}

  async subscribe(listener: EventListener, options: SubscribeOptions = {}) {
    const index = this.subscribes.push(options) - 1;
    this.listener = listener;
    const outcome = this.behaviour(index, listener);
    if (outcome instanceof Error) {
      throw outcome;
    }
    if (outcome instanceof Promise) {
      await outcome;
      if (this.honourAbort && options.signal?.aborted) {
        throw new Error("aborted");
      }
    }
    return {
      close: async () => {
        this.closes++;
      },
    };
  }

  emit(id: string | undefined): void {
    this.listener?.onEvent({} as ReceiveEvent, id);
  }
}

const loops: ReceiveLoop[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(loops.splice(0).map((loop) => loop.stop()));
});

function makeLoop(
  options: {
    transport?: ScriptedTransport;
    state?: StateAdapter;
    dispatch?: (event: ReceiveEvent) => Promise<void>;
    minDelayMs?: number;
    maxDelayMs?: number;
  } = {},
) {
  const transport = options.transport ?? new ScriptedTransport();
  const state = options.state ?? createMemoryState();
  const logger = recordingLogger();
  const loop = new ReceiveLoop({
    transport,
    state,
    cursorKey: KEY,
    logger,
    reconnect: { minDelayMs: options.minDelayMs ?? 1, maxDelayMs: options.maxDelayMs ?? 8 },
    dispatch: options.dispatch ?? (async () => {}),
  });
  loops.push(loop);
  return { loop, transport, state, logger };
}

async function connectedState(): Promise<StateAdapter> {
  const state = createMemoryState();
  await state.connect();
  return state;
}

/** Logged reconnect delays, in order. */
function delays(logger: ReturnType<typeof recordingLogger>): number[] {
  return logger.entries.flatMap((entry) => {
    const match = /reconnecting in (\d+) ms/.exec(entry.message);
    return match ? [Number(match[1])] : [];
  });
}

describe("ReceiveLoop backoff", () => {
  it("doubles the delay per failed attempt up to maxDelayMs and resets after a successful connect", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1); // no jitter: every delay is its nominal value
    const transport = new ScriptedTransport();
    // Subscribe 0 is the start; 1-5 fail; 6 connects; 7 (after the next drop) connects.
    transport.behaviour = (index) => (index >= 1 && index <= 5 ? new Error("down") : "ok");
    const { loop, logger } = makeLoop({ transport, state: await connectedState(), minDelayMs: 1, maxDelayMs: 8 });
    await loop.start();

    transport.listener?.onClosed();
    await expect.poll(() => transport.subscribes.length).toBe(7);
    expect(delays(logger)).toEqual([1, 2, 4, 8, 8, 8]);

    transport.listener?.onClosed();
    await expect.poll(() => transport.subscribes.length).toBe(8);
    expect(delays(logger).at(-1)).toBe(1);
    expect(logger.entries.filter((entry) => entry.message.includes("Reconnecting to the signal-cli event stream failed"))).toHaveLength(5);
  });

  it("applies up to 50 % jitter", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const transport = new ScriptedTransport();
    const { loop, logger } = makeLoop({ transport, state: await connectedState(), minDelayMs: 40, maxDelayMs: 40 });
    await loop.start();
    transport.listener?.onClosed();
    await expect.poll(() => transport.subscribes.length).toBe(2);
    expect(delays(logger)).toEqual([20]);
  });

  it("reconnects again when the new stream closes before the reconnect has finished", async () => {
    const transport = new ScriptedTransport();
    // The first reconnected stream closes at once, while the loop is still inside its reconnect.
    transport.behaviour = (index, listener) => {
      if (index === 1) {
        listener.onClosed();
      }
      return "ok";
    };
    const { loop } = makeLoop({ transport, state: await connectedState() });
    await loop.start();

    transport.listener?.onClosed();
    await expect.poll(() => transport.subscribes.length).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transport.subscribes).toHaveLength(3);
    // Each reconnect closes the subscription it replaces.
    expect(transport.closes).toBe(2);
  });

  it("closes a stream that connects after stop() before stop() resolves, and makes no further attempts", async () => {
    const transport = new ScriptedTransport();
    transport.honourAbort = false;
    const held = deferred();
    transport.behaviour = (index) => (index === 1 ? held.promise : "ok");
    const { loop } = makeLoop({ transport, state: await connectedState() });
    await loop.start();
    transport.listener?.onClosed();
    await expect.poll(() => transport.subscribes.length).toBe(2);

    const stopped = loop.stop();
    held.resolve();
    await stopped;
    expect(transport.closes).toBe(2); // the start stream and the one that connected during stop()
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(transport.subscribes).toHaveLength(2);
  });
});

describe("ReceiveLoop cursor", () => {
  it("resumes from the newest received event while the first one still runs and no cursor exists", async () => {
    const transport = new ScriptedTransport();
    const first = deferred();
    const { loop } = makeLoop({ transport, state: await connectedState(), dispatch: () => first.promise });
    await loop.start();
    transport.emit("run-1");
    transport.emit("run-2");

    transport.listener?.onClosed();
    await expect.poll(() => transport.subscribes.length).toBe(2);
    expect(transport.subscribes[1]?.lastEventId).toBe("run-2");
    first.resolve();
  });

  it("warns that nothing is replayed when it reconnects before any event ID is known", async () => {
    const transport = new ScriptedTransport();
    const { loop, logger } = makeLoop({ transport, state: await connectedState() });
    await loop.start();
    transport.listener?.onClosed();
    await expect.poll(() => transport.subscribes.length).toBe(2);

    await expect.poll(() => logger.entries.some((entry) => entry.level === "warn" && entry.message.includes("without an event ID"))).toBe(true);
    expect(transport.subscribes[1]?.lastEventId).toBeUndefined();
  });

  it("stores the newest cursor when events settle while a write is in flight, one write at a time", async () => {
    const state = await connectedState();
    const writes: unknown[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const gates: Deferred[] = [];
    state.set = async (_key, value) => {
      writes.push(structuredClone(value));
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      inFlight--;
    };
    const transport = new ScriptedTransport();
    const { loop } = makeLoop({ transport, state });
    await loop.start();

    transport.emit("run-1");
    await expect.poll(() => gates.length).toBe(1);
    transport.emit("run-2");
    transport.emit("run-3");
    await new Promise((resolve) => setTimeout(resolve, 5));
    gates[0]?.resolve();
    await expect.poll(() => gates.length).toBe(2);
    gates[1]?.resolve();
    await expect.poll(async () => (await loop.drain(100)) === 0 && inFlight === 0).toBe(true);

    expect(maxInFlight).toBe(1);
    expect(writes.at(-1)).toEqual({ lastEventId: "run-3", processed: [] });
    expect(writes).toHaveLength(2);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8])("stores the cursor of an event that settles %i microtasks after another", async (gap) => {
    const state = await connectedState();
    const writes: unknown[] = [];
    state.set = async (_key, value) => {
      writes.push(structuredClone(value));
    };
    const transport = new ScriptedTransport();
    const gates = [deferred(), deferred()];
    let next = 0;
    const { loop } = makeLoop({ transport, state, dispatch: () => (gates[next++] as Deferred).promise });
    await loop.start();
    transport.emit("run-1");
    transport.emit("run-2");

    gates[0]?.resolve();
    for (let tick = 0; tick < gap; tick++) {
      await Promise.resolve();
    }
    gates[1]?.resolve();
    expect(await loop.drain(100)).toBe(0);

    expect(writes.at(-1)).toEqual({ lastEventId: "run-2", processed: [] });
  });

  it("advances past an event whose dispatch rejects or throws, and logs it", async () => {
    const transport = new ScriptedTransport();
    const state = await connectedState();
    let calls = 0;
    const { loop, logger } = makeLoop({
      transport,
      state,
      dispatch: () => {
        calls++;
        if (calls === 1) {
          return Promise.reject(new Error("boom"));
        }
        if (calls === 2) {
          throw new Error("sync boom");
        }
        return Promise.resolve();
      },
    });
    await loop.start();
    transport.emit("run-1");
    transport.emit("run-2");
    transport.emit("run-3");

    expect(await loop.drain(100)).toBe(0);
    expect(await state.get(KEY)).toEqual({ lastEventId: "run-3", processed: [] });
    expect(logger.entries.filter((entry) => entry.message === "Signal event dispatch failed")).toHaveLength(2);
  });

  it("keeps running when the cursor cannot be read or stored, with warnings", async () => {
    const state = await connectedState();
    state.get = async () => {
      throw new Error("state down");
    };
    state.set = async () => {
      throw new Error("state down");
    };
    const transport = new ScriptedTransport();
    const handled: string[] = [];
    const { loop, logger } = makeLoop({
      transport,
      state,
      dispatch: async () => {
        handled.push("x");
      },
    });
    await loop.start();
    transport.emit("run-1");
    transport.emit("run-2");

    expect(await loop.drain(100)).toBe(0);
    expect(handled).toHaveLength(2);
    expect(transport.subscribes[0]?.lastEventId).toBeUndefined();
    expect(logger.entries.some((entry) => entry.message.startsWith("Could not read the Signal receive cursor"))).toBe(true);
    expect(logger.entries.some((entry) => entry.message === "Could not store the Signal receive cursor")).toBe(true);
  });

  it("stores at most 1000 processed IDs beyond a stuck event", async () => {
    const state = await connectedState();
    const transport = new ScriptedTransport();
    const stuck = deferred();
    let calls = 0;
    const { loop } = makeLoop({ transport, state, dispatch: () => (++calls === 1 ? stuck.promise : Promise.resolve()) });
    await loop.start();
    for (let index = 1; index <= 1005; index++) {
      transport.emit(`run-${index}`);
    }

    await loop.drain(50);
    const stored = (await state.get(KEY)) as { lastEventId?: string; processed: string[] };
    expect(stored.lastEventId).toBeUndefined();
    expect(stored.processed).toHaveLength(1000);
    expect(stored.processed[0]).toBe("run-6");
    expect(stored.processed.at(-1)).toBe("run-1005");
    stuck.resolve();
  });

  it("bounds drain by its timeout even when the cursor write hangs", async () => {
    const state = await connectedState();
    state.set = () => new Promise(() => {});
    const transport = new ScriptedTransport();
    const { loop } = makeLoop({ transport, state });
    await loop.start();
    transport.emit("run-1");
    await Promise.resolve();

    const started = Date.now();
    expect(await loop.drain(30)).toBe(0);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("stops writing the cursor once drain returned, so a later loop owns it", async () => {
    const state = await connectedState();
    const transport = new ScriptedTransport();
    const slow = deferred();
    const { loop } = makeLoop({ transport, state, dispatch: () => slow.promise });
    await loop.start();
    transport.emit("old-1");
    await loop.stop();
    expect(await loop.drain(0)).toBe(1);
    await state.set(KEY, { lastEventId: "new-7", processed: [] });

    slow.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(await state.get(KEY)).toEqual({ lastEventId: "new-7", processed: [] });
  });
});

describe("ReceiveLoop cursor edge cases", () => {
  it("skips events replayed from an older cursor that settled while the reconnect was connecting", async () => {
    const transport = new ScriptedTransport();
    const held = deferred();
    transport.behaviour = (index) => (index === 1 ? held.promise : "ok");
    const first = deferred();
    const dispatched: number[] = [];
    let calls = 0;
    const { loop } = makeLoop({
      transport,
      state: await connectedState(),
      dispatch: () => {
        dispatched.push(++calls);
        return calls === 1 ? first.promise : Promise.resolve();
      },
    });
    await loop.start();
    transport.emit("run-1");
    transport.emit("run-2");
    transport.listener?.onClosed();
    await expect.poll(() => transport.subscribes.length).toBe(2);
    // run-1 settles while the reconnect is still connecting, so run-1 and run-2 leave `entries`.
    first.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    held.resolve();
    // signal-cli replays what followed the older ID the reconnect was sent with.
    transport.emit("run-1");
    transport.emit("run-2");
    expect(await loop.drain(100)).toBe(0);

    expect(dispatched).toEqual([1, 2]);
  });

  it("keeps writing after a state adapter whose set throws synchronously once", async () => {
    const state = await connectedState();
    let sets = 0;
    state.set = ((..._args: unknown[]) => {
      if (++sets === 1) {
        throw new Error("sync");
      }
      return Promise.resolve();
    }) as StateAdapter["set"];
    const transport = new ScriptedTransport();
    const { loop } = makeLoop({ transport, state });
    await loop.start();
    transport.emit("run-1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    transport.emit("run-2");
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(sets).toBe(2);
  });

  it("drain waits for the final cursor write", async () => {
    const state = await connectedState();
    let written = false;
    state.set = async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      written = true;
    };
    const transport = new ScriptedTransport();
    const { loop } = makeLoop({ transport, state });
    await loop.start();
    transport.emit("run-1");

    expect(await loop.drain(1_000)).toBe(0);
    expect(written).toBe(true);
  });

  it("keeps processed IDs loaded from state in later writes until they are replayed", async () => {
    const state = await connectedState();
    await state.set(KEY, { lastEventId: "run-1", processed: ["run-3"] });
    const transport = new ScriptedTransport();
    const { loop } = makeLoop({ transport, state });
    await loop.start();
    transport.emit("run-9");
    await loop.drain(100);

    expect(await state.get(KEY)).toEqual({ lastEventId: "run-9", processed: ["run-3"] });
  });

  it("stores the cursor when an event without ID settles and lets the cursor pass a later event", async () => {
    const state = await connectedState();
    const transport = new ScriptedTransport();
    const first = deferred();
    let calls = 0;
    const { loop } = makeLoop({ transport, state, dispatch: () => (++calls === 1 ? first.promise : Promise.resolve()) });
    await loop.start();
    transport.emit(undefined);
    transport.emit("run-1");
    await expect.poll(async () => (await state.get(KEY)) !== null).toBe(true);

    first.resolve();
    await expect.poll(async () => state.get(KEY)).toEqual({ lastEventId: "run-1", processed: [] });
  });

  it("does not write again after drain timed out while a write was in flight", async () => {
    const state = await connectedState();
    const writes: unknown[] = [];
    const gate = deferred();
    state.set = async (_key, value) => {
      writes.push(structuredClone(value));
      await gate.promise;
    };
    const transport = new ScriptedTransport();
    const { loop } = makeLoop({ transport, state });
    await loop.start();
    transport.emit("run-1");
    await expect.poll(() => writes.length).toBe(1);
    transport.emit("run-2"); // settles while write 1 hangs: asks for a second write

    await loop.stop();
    expect(await loop.drain(0)).toBe(0);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(writes).toHaveLength(1);
  });
});
