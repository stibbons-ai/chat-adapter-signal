import {
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  ValidationError,
  type AdapterError,
} from "@chat-adapter/shared";
import type { ReceiveEvent } from "../envelope.js";
import { ADAPTER_NAME, fromJsonRpcError, unreachable, type JsonRpcErrorObject } from "../errors.js";
import { parseEventStream } from "./sse.js";
import type { EventListener, EventSubscription, SignalTransport } from "./types.js";

export interface HttpTransportOptions {
  type: "http";
  /** Base URL of the signal-cli HTTP daemon, e.g. `http://signal-cli:8080`. */
  url: string;
  /** Sent on every request, including the event stream, e.g. for a reverse proxy's auth. */
  headers?: Record<string, string>;
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
  private nextRequestId = 1;

  constructor(
    options: HttpTransportOptions,
    private readonly account: string,
  ) {
    this.endpoint = options.url.replace(/\/+$/, "");
    this.headers = options.headers ?? {};
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
      throw new NetworkError(ADAPTER_NAME, `signal-cli JSON-RPC ${method} returned a malformed response`);
    }
    if (payload.error) {
      throw fromJsonRpcError(payload.error, method);
    }
    return payload.result as T;
  }

  async subscribe(listener: EventListener): Promise<EventSubscription> {
    const abort = new AbortController();
    const response = await this.fetchPath(
      `/api/v1/events?account=${encodeURIComponent(this.account)}`,
      { method: "GET", headers: { Accept: "text/event-stream" }, signal: abort.signal },
      "event stream",
    );
    if (!response.ok || !response.body) {
      throw fromHttpStatus(response, `signal-cli event stream at ${this.endpoint}`);
    }

    const body = response.body;
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
          if (typeof parsed !== "object" || parsed === null) {
            listener.onError(new ValidationError(ADAPTER_NAME, "Ignoring signal-cli event that is not a JSON object"));
            continue;
          }
          try {
            listener.onEvent(parsed as ReceiveEvent);
          } catch (error) {
            listener.onError(error);
          }
        }
      } catch (error) {
        if (abort.signal.aborted) {
          return;
        }
        listener.onError(unreachable(`event stream at ${this.endpoint}`, error));
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
