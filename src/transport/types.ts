import type { ReceiveEvent } from "../envelope.js";

export interface EventListener {
  /** Called for each event in stream order; must not block the stream (dispatch work asynchronously). */
  onEvent(event: ReceiveEvent): void;
  /** A malformed event (stream continues) or a stream failure (followed by `onClosed`). */
  onError(error: unknown): void;
  /** The stream ended without `close()` being called. */
  onClosed(): void;
}

export interface EventSubscription {
  /** Stops the event stream and resolves once it is closed. */
  close(): Promise<void>;
}

/**
 * Talks to one signal-cli instance on behalf of one Bot Account: over HTTP
 * (`http.ts`) or line-delimited JSON-RPC over stdio, a Unix socket or TCP (`line.ts`).
 */
export interface SignalTransport {
  /** Where signal-cli is reached, for error messages. */
  readonly endpoint: string;
  /** Resolves when signal-cli is reachable; rejects with a shared adapter error otherwise. */
  checkReachable(): Promise<void>;
  /** Sends one JSON-RPC request and resolves with its `result`. */
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Opens the event stream and resolves once it is connected. */
  subscribe(listener: EventListener): Promise<EventSubscription>;
  /**
   * Releases whatever the transport holds open (a socket, a spawned signal-cli)
   * and resolves once it is gone. Later calls to the other methods reconnect.
   */
  close(): Promise<void>;
}
