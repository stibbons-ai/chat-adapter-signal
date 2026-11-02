import { setTimeout as sleep } from "node:timers/promises";
import { ValidationError } from "@chat-adapter/shared";
import type { Logger, StateAdapter } from "chat";
import type { ReceiveEvent } from "./envelope.js";
import { ADAPTER_NAME, assertTimeoutMs } from "./errors.js";
import { isHeaderSafeEventId } from "./transport/sse.js";
import type { EventListener, EventSubscription, SignalTransport } from "./transport/types.js";

/**
 * Events signal-cli 0.14.9 keeps for replay (`SseEventBuffer.MAX_EVENTS`); more
 * processed IDs than this are never worth storing, since none of them can be replayed.
 */
const REPLAY_BUFFER_EVENTS = 1000;

export interface ReconnectOptions {
  /** Delay before the first reconnect attempt; doubles per failed attempt. Default: 1 000 ms. */
  minDelayMs?: number;
  /** Upper bound for the reconnect delay. Default: 30 000 ms. */
  maxDelayMs?: number;
}

/** What the cursor key in the Chat state adapter holds. */
interface StoredCursor {
  /** The newest event that was processed together with every event before it. */
  lastEventId?: string | undefined;
  /** Events after `lastEventId` that were already processed, so a replay skips them. */
  processed: string[];
}

interface Entry {
  id: string | undefined;
  task: Promise<void>;
  settled: boolean;
}

export interface ReceiveLoopOptions {
  transport: SignalTransport;
  /** The Chat state adapter and the key the cursor is stored under. */
  state: StateAdapter;
  cursorKey: string;
  logger: Logger | undefined;
  reconnect: Required<ReconnectOptions>;
  /** Handles one event; the returned promise settles once `chat.processMessage` completes. */
  dispatch(event: ReceiveEvent): Promise<void>;
}

/**
 * Keeps the event stream open: reconnects with exponential backoff after a
 * drop, and on HTTP resumes from the last processed event ID (stored in the Chat
 * state adapter, so it survives a Host App restart; line transports have no IDs). The cursor advances only once
 * an event and every event before it were processed; replayed events that
 * were already processed or are still running are skipped.
 */
export class ReceiveLoop {
  /** Events still running, or processed after one that still runs, in arrival order. */
  private readonly entries: Entry[] = [];
  /** Processed event IDs loaded from state: skipped if signal-cli replays them. */
  private skip = new Set<string>();
  /**
   * IDs that left `entries` behind the cursor, newest last: a reconnect sends the cursor of the
   * moment it connects, so signal-cli may replay events that settled while it was connecting.
   */
  private readonly passed = new Set<string>();
  private cursor: string | undefined;
  /** Newest event ID received by this loop, to resume from while `cursor` is still unset. */
  private lastReceivedId: string | undefined;
  /** The running cursor write; `dirty` asks it to write once more when it is done. */
  private saving: Promise<void> | undefined;
  private dirty = false;
  /** Set once `drain()` returned: handlers that settle later no longer write the cursor. */
  private drained = false;
  private subscription: EventSubscription | undefined;
  private reconnecting: Promise<void> | undefined;
  /** Set by every unexpected close; the reconnect loop runs until it stays clear. */
  private streamClosed = false;
  private readonly stopping = new AbortController();
  private readonly listener: EventListener;

  constructor(private readonly options: ReceiveLoopOptions) {
    this.listener = {
      onEvent: (event, eventId) => this.onEvent(event, eventId),
      onError: (error) => this.options.logger?.error("signal-cli event stream error", { error }),
      onClosed: () => {
        if (!this.stopping.signal.aborted) {
          this.streamClosed = true;
          this.reconnecting ??= this.reconnect();
        }
      },
    };
  }

  /** Loads the stored cursor and opens the event stream; rejects if the first connection fails. */
  async start(): Promise<void> {
    await this.loadCursor();
    await this.connect();
  }

  /** Closes the event stream and stops reconnecting. Running handlers keep running; see `drain()`. */
  async stop(): Promise<void> {
    this.stopping.abort();
    await this.reconnecting;
    const subscription = this.subscription;
    this.subscription = undefined;
    await subscription?.close();
  }

  /**
   * Waits for running events and then for the cursor write, together bounded
   * by `timeoutMs`. Resolves with the number of events still running at the
   * timeout. Handlers that settle later no longer write the cursor, so a loop
   * started after this one owns it alone.
   */
  async drain(timeoutMs: number): Promise<number> {
    const tasks = this.entries.flatMap((entry) => (entry.settled ? [] : [entry.task]));
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref();
    });
    // `this.saving` is read once the tasks settled, when their last advance has started its write.
    await Promise.race([Promise.allSettled(tasks).then(() => this.saving), expired]);
    clearTimeout(timer);
    this.drained = true;
    return this.entries.filter((entry) => !entry.settled).length;
  }

  /** Subscribes from the cursor; a subscription that connects after `stop()` is closed right away. */
  private async connect(): Promise<void> {
    const signal = this.stopping.signal;
    // Before the first event settles there is no cursor yet; resuming after the newest received
    // event still replays what arrived meanwhile, and every earlier one is tracked in `entries`.
    const lastEventId = this.cursor ?? this.lastReceivedId;
    const subscription = await this.options.transport.subscribe(this.listener, { lastEventId, signal });
    if (signal.aborted) {
      await subscription.close();
      return;
    }
    const previous = this.subscription;
    this.subscription = subscription;
    await previous?.close();
  }

  private async loadCursor(): Promise<void> {
    let stored: unknown;
    try {
      stored = await this.options.state.get<unknown>(this.options.cursorKey);
    } catch (error) {
      // Without the cursor the stream starts at live events: messages received while the Host App was down are not replayed.
      this.options.logger?.warn("Could not read the Signal receive cursor; resuming from live events", { error });
      return;
    }
    if (stored === null || stored === undefined) {
      return;
    }
    if (!isStoredCursor(stored)) {
      this.options.logger?.warn("Ignoring a malformed Signal receive cursor; resuming from live events");
      return;
    }
    this.cursor = stored.lastEventId;
    this.skip = new Set(stored.processed);
  }

  private onEvent(event: ReceiveEvent, id: string | undefined): void {
    let task: Promise<void>;
    if (id !== undefined && this.skip.delete(id)) {
      this.options.logger?.debug("Skipping a replayed Signal event that was already processed");
      task = Promise.resolve();
    } else if (id !== undefined && (this.passed.has(id) || this.entries.some((entry) => entry.id === id))) {
      this.options.logger?.debug("Skipping a replayed Signal event that is running or already processed");
      return;
    } else {
      // A dispatch that throws or rejects must still settle its entry, or the cursor would stop for good.
      task = Promise.resolve()
        .then(() => this.options.dispatch(event))
        .catch((error: unknown) => this.options.logger?.error("Signal event dispatch failed", { error }));
    }
    if (id !== undefined) {
      this.lastReceivedId = id;
    }
    const entry: Entry = { id, task, settled: false };
    this.entries.push(entry);
    void task.then(() => {
      entry.settled = true;
      this.advance(entry);
    });
  }

  /** Drops settled entries from the head, moving the cursor to the newest of them, and stores the result. */
  private advance(settled: Entry): void {
    const before = this.cursor;
    while (this.entries[0]?.settled) {
      const head = this.entries.shift() as Entry;
      if (head.id !== undefined) {
        this.cursor = head.id;
        this.passed.add(head.id);
        if (this.passed.size > REPLAY_BUFFER_EVENTS) {
          // ponytail: Set iteration is insertion order, so this drops the oldest.
          this.passed.delete(this.passed.values().next().value as string);
        }
      }
    }
    if ((settled.id !== undefined || this.cursor !== before) && !this.drained) {
      this.dirty = true;
      this.saving ??= this.flush();
    }
  }

  /** Writes the latest cursor until nothing changed meanwhile: one write in flight, never an older one after a newer one. */
  private async flush(): Promise<void> {
    // Never finish synchronously (a `set` that throws at once): `saving` must be assigned before `finally` clears it.
    await undefined;
    try {
      while (this.dirty && !this.drained) {
        this.dirty = false;
        const processed = [...this.skip];
        for (const entry of this.entries) {
          if (entry.settled && entry.id !== undefined) {
            processed.push(entry.id);
          }
        }
        const value: StoredCursor = { lastEventId: this.cursor, processed: processed.slice(-REPLAY_BUFFER_EVENTS) };
        try {
          await this.options.state.set(this.options.cursorKey, value);
        } catch (error) {
          this.options.logger?.warn("Could not store the Signal receive cursor", { error });
        }
      }
    } finally {
      // In the same step as the last `dirty` check, so an advance right after it starts a new flush.
      this.saving = undefined;
    }
  }

  /** Reconnects until the newest stream did not close meanwhile, so a close during a reconnect is never lost. */
  private async reconnect(): Promise<void> {
    try {
      while (this.streamClosed && !this.stopping.signal.aborted) {
        this.streamClosed = false;
        await this.reconnectWithBackoff();
      }
    } finally {
      // In the same step as the last `streamClosed` check, so a later close starts a new reconnect.
      this.reconnecting = undefined;
    }
  }

  private async reconnectWithBackoff(): Promise<void> {
    const { minDelayMs, maxDelayMs } = this.options.reconnect;
    const signal = this.stopping.signal;
    for (let attempt = 0; !signal.aborted; attempt++) {
      // Each delay is 50-100 % of its nominal value, so many bots don't hammer a restarted daemon in lockstep.
      const base = Math.min(maxDelayMs, minDelayMs * 2 ** attempt);
      const delay = Math.round(base * (0.5 + Math.random() / 2));
      this.options.logger?.warn(`signal-cli event stream closed; reconnecting in ${delay} ms`, { attempt: attempt + 1 });
      try {
        await sleep(delay, undefined, { signal });
        // ponytail: backoff resets on every successful connect; a daemon that accepts and drops at once is retried every 0.5-1x minDelayMs.
        await this.connect();
        if (signal.aborted) {
          return;
        }
        if (this.cursor === undefined && this.lastReceivedId === undefined) {
          // No ID yet (HTTP before the first event) or none at all (line transports): signal-cli replays nothing.
          // An unknown ID would make the HTTP daemon replay its whole buffer, from before this start.
          this.options.logger?.warn(
            "Reconnected to the signal-cli event stream without an event ID to resume from; signal-cli replays nothing it pushed while disconnected",
          );
        } else {
          this.options.logger?.info("Reconnected to the signal-cli event stream");
        }
        return;
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        this.options.logger?.warn("Reconnecting to the signal-cli event stream failed", { error });
      }
    }
  }
}

function isStoredCursor(value: unknown): value is StoredCursor {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { lastEventId, processed } = value as Partial<StoredCursor>;
  return (
    // The ID becomes an HTTP header: one that is not header-safe would make every start fail.
    (lastEventId === undefined || (typeof lastEventId === "string" && isHeaderSafeEventId(lastEventId))) &&
    Array.isArray(processed) &&
    processed.every((id) => typeof id === "string")
  );
}

/** Applies defaults and rejects values `setTimeout` would not honour. */
export function reconnectOptions(options: ReconnectOptions = {}): Required<ReconnectOptions> {
  const minDelayMs = options.minDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  assertTimeoutMs("reconnect.minDelayMs", minDelayMs, 1);
  assertTimeoutMs("reconnect.maxDelayMs", maxDelayMs, 1);
  if (maxDelayMs < minDelayMs) {
    throw new ValidationError(ADAPTER_NAME, "reconnect.maxDelayMs must not be smaller than reconnect.minDelayMs");
  }
  return { minDelayMs, maxDelayMs };
}
