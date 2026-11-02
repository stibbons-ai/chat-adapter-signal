import type { ReceiveEvent } from "../envelope.js";

export interface EventListener {
  /**
   * Called for each event in stream order; must not block the stream (dispatch work asynchronously).
   * `eventId` is the SSE event ID on the HTTP transport; transports without one pass `undefined`.
   */
  onEvent(event: ReceiveEvent, eventId?: string): void;
  /** A malformed event (stream continues) or a stream failure (followed by `onClosed`). */
  onError(error: unknown): void;
  /** The stream ended without `close()` being called or the subscribe `signal` aborting. */
  onClosed(): void;
}

export interface SubscribeOptions {
  /** Resume after this event: sent as `Last-Event-ID`; transports without an event buffer ignore it. */
  lastEventId?: string | undefined;
  /**
   * Aborts a subscribe still connecting (it then rejects) or ends the stream it opened, without
   * calling `onClosed`. Transports must honour it: the receive loop relies on it to stop.
   */
  signal?: AbortSignal | undefined;
}

export interface EventSubscription {
  /** Stops the event stream and resolves once it is closed. */
  close(): Promise<void>;
}

/**
 * Talks to one signal-cli instance on behalf of one Bot Account: over HTTP
 * (`http.ts`) or line-delimited JSON-RPC over stdio, a Unix socket or TCP (`line.ts`).
 * Reconnecting after a dropped stream is the receive loop's job: it calls `subscribe()` again.
 */
export interface SignalTransport {
  /** Where signal-cli is reached, for error messages. */
  readonly endpoint: string;
  /** Resolves when signal-cli is reachable; rejects with a shared adapter error otherwise. */
  checkReachable(): Promise<void>;
  /** Sends one JSON-RPC request and resolves with its `result`. */
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Opens a fresh event stream and resolves once it is connected; rejects when unreachable or aborted. */
  subscribe(listener: EventListener, options?: SubscribeOptions): Promise<EventSubscription>;
  /**
   * Releases whatever the transport holds open (a socket, a spawned signal-cli)
   * and resolves once it is gone. Later calls to the other methods reconnect.
   */
  close(): Promise<void>;
}
