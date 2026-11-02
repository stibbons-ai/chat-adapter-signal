import {
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  ValidationError,
  type AdapterError,
} from "@chat-adapter/shared";
import type { ReceiveEvent } from "../envelope.js";
import { ADAPTER_NAME, assertTimeoutMs, fromJsonRpcError, malformedResponse, unreachable, type JsonRpcErrorObject } from "../errors.js";
import { parseEventStream } from "./sse.js";
import type { EventListener, EventSubscription, SignalTransport, SubscribeOptions } from "./types.js";

export interface HttpTransportOptions {
  type: "http";
  /** Base URL of the signal-cli HTTP daemon, e.g. `http://signal-cli:8080`. */
  url: string;
  /** Sent on every request, including the event stream, e.g. for a reverse proxy's auth. */
  headers?: Record<string, string>;
  /**
   * The event stream counts as dropped (and is reconnected) after this long without any data,
   * which catches connections that died without closing. signal-cli sends a keep-alive every
   * `--sse-keepalive-interval` seconds (default 15); keep this well above it. Default: 60 000 ms.
   */
  idleTimeoutMs?: number;
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: JsonRpcErrorObject;
}

/** Maps a non-2xx HTTP status from signal-cli (or a reverse proxy in front of it) to a shared error class. */
function fromHttpStatus(response: Response, what: string): AdapterError {
  const detail = `${what} returned HTTP ${response.status}`;
  if (response.status === 401 || response.status === 403) {
    return new AuthenticationError(ADAPTER_NAME, `${detail}; check the transport headers`);
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    return new AdapterRateLimitError(ADAPTER_NAME, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
  }
  return new NetworkError(ADAPTER_NAME, detail);
}

/** signal-cli's HTTP daemon (`signal-cli daemon --http`): JSON-RPC, SSE events, health check. */
export class HttpTransport implements SignalTransport {
  readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly idleTimeoutMs: number;
  private nextRequestId = 1;

  constructor(
    options: HttpTransportOptions,
    private readonly account: string,
  ) {
    this.endpoint = options.url.replace(/\/+$/, "");
    this.headers = options.headers ?? {};
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
    assertTimeoutMs("transport.idleTimeoutMs", this.idleTimeoutMs, 1);
  }

  async checkReachable(): Promise<void> {
    const response = await this.fetchPath("/api/v1/check", { method: "GET" }, "health check");
    if (!response.ok) {
      throw fromHttpStatus(response, `signal-cli health check at ${this.endpoint}`);
    }
  }

  async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const response = await this.fetchPath(
      "/api/v1/rpc",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextRequestId++, method, params }),
      },
      `JSON-RPC ${method}`,
    );
    if (!response.ok) {
      throw fromHttpStatus(response, `signal-cli JSON-RPC ${method}`);
    }
    let payload: JsonRpcResponse<T> | null;
    try {
      payload = (await response.json()) as JsonRpcResponse<T> | null;
    } catch (error) {
      throw new NetworkError(ADAPTER_NAME, `signal-cli JSON-RPC ${method} returned an unreadable response`, error as Error);
    }
    if (typeof payload !== "object" || payload === null || !("result" in payload || "error" in payload)) {
      throw malformedResponse(method);
    }
    if (payload.error) {
      throw fromJsonRpcError(payload.error, method);
    }
    return payload.result as T;
  }

  async subscribe(listener: EventListener, options: SubscribeOptions = {}): Promise<EventSubscription> {
    const abort = new AbortController();
    const signal = options.signal ? AbortSignal.any([abort.signal, options.signal]) : abort.signal;
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (options.lastEventId) {
      // signal-cli replays the events it buffered after this ID (all of them for an ID it doesn't know).
      headers["Last-Event-ID"] = options.lastEventId;
    }
    // Response headers, and then any bytes (keep-alive comments included), must arrive within
    // idleTimeoutMs: a connection that died without closing would otherwise hang until undici gives up.
    let idle = false;
    let timer: NodeJS.Timeout | undefined;
    const resetIdleTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        idle = true;
        abort.abort();
      }, this.idleTimeoutMs);
      timer.unref();
    };
    const idleError = () =>
      new NetworkError(ADAPTER_NAME, `No data on the event stream at ${this.endpoint} for ${this.idleTimeoutMs} ms`);
    resetIdleTimer();
    let response: Response;
    try {
      response = await this.fetchPath(
        `/api/v1/events?account=${encodeURIComponent(this.account)}`,
        { method: "GET", headers, signal },
        "event stream",
      );
    } catch (error) {
      clearTimeout(timer);
      throw idle ? idleError() : error;
    }
    if (!response.ok || !response.body) {
      clearTimeout(timer);
      // Release the connection now: the receive loop retries, possibly for a long time.
      await response.body?.cancel().catch(() => {});
      throw fromHttpStatus(response, `signal-cli event stream at ${this.endpoint}`);
    }
    resetIdleTimer(); // the body gets its own idleTimeoutMs after the headers
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          resetIdleTimer();
          controller.enqueue(chunk);
        },
      }),
    );
    const done = (async () => {
      try {
        for await (const event of parseEventStream(body)) {
          if (event.event !== "receive") {
            continue;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(event.data);
          } catch {
            // Never log the payload or the parse error (V8 quotes the input): both carry message text and phone numbers.
            listener.onError(
              new ValidationError(ADAPTER_NAME, `Ignoring signal-cli event that is not valid JSON (${event.data.length} chars)`),
            );
            continue;
          }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            listener.onError(new ValidationError(ADAPTER_NAME, "Ignoring signal-cli event that is not a JSON object"));
            continue;
          }
          try {
            listener.onEvent(parsed as ReceiveEvent, event.id);
          } catch (error) {
            listener.onError(error);
          }
        }
      } catch (error) {
        if (idle) {
          listener.onError(idleError());
        } else if (signal.aborted) {
          return;
        } else {
          listener.onError(unreachable(`event stream at ${this.endpoint}`, error));
        }
      } finally {
        clearTimeout(timer);
      }
      listener.onClosed();
    })();

    return {
      async close() {
        abort.abort();
        await done;
      },
    };
  }

  /** Nothing to release: every request is its own HTTP exchange, and `subscribe()` returns its own `close()`. */
  async close(): Promise<void> {}

  private async fetchPath(path: string, init: RequestInit, what: string): Promise<Response> {
    try {
      return await fetch(this.endpoint + path, {
        ...init,
        headers: { ...this.headers, ...(init.headers as Record<string, string> | undefined) },
      });
    } catch (error) {
      throw unreachable(`${what} at ${this.endpoint}`, error);
    }
  }
}
