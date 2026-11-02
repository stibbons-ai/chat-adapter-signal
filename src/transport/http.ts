import { NetworkError, ValidationError } from "@chat-adapter/shared";
import { fromHttpStatus, fromJsonRpcError, unreachable, type JsonRpcErrorObject } from "../errors.js";
import { ADAPTER_NAME } from "../thread-id.js";
import { parseEventStream } from "./sse.js";
import type { EventListener, EventSubscription, ReceiveEvent, SignalTransport } from "./types.js";

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

/** signal-cli's HTTP daemon (`signal-cli daemon --http`): JSON-RPC, SSE events, health check. */
export class HttpTransport implements SignalTransport {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private nextRequestId = 1;

  constructor(
    options: HttpTransportOptions,
    private readonly account: string,
  ) {
    this.baseUrl = options.url.replace(/\/+$/, "");
    this.headers = options.headers ?? {};
  }

  async checkReachable(): Promise<void> {
    const response = await this.fetch("/api/v1/check", { method: "GET" }, "health check");
    if (!response.ok) {
      throw fromHttpStatus(response, `signal-cli health check at ${this.baseUrl}`);
    }
  }

  async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextRequestId++;
    const response = await this.fetch(
      "/api/v1/rpc",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
      },
      `JSON-RPC ${method}`,
    );
    if (!response.ok) {
      throw fromHttpStatus(response, `signal-cli JSON-RPC ${method}`);
    }
    let payload: JsonRpcResponse<T>;
    try {
      payload = (await response.json()) as JsonRpcResponse<T>;
    } catch (error) {
      throw new NetworkError(ADAPTER_NAME, `signal-cli JSON-RPC ${method} returned an unreadable response`, error as Error);
    }
    if (payload.error) {
      throw fromJsonRpcError(payload.error, method);
    }
    return payload.result as T;
  }

  async subscribe(listener: EventListener): Promise<EventSubscription> {
    const abort = new AbortController();
    const response = await this.fetch(
      `/api/v1/events?account=${encodeURIComponent(this.account)}`,
      { method: "GET", headers: { Accept: "text/event-stream" }, signal: abort.signal },
      "event stream",
    );
    if (!response.ok || !response.body) {
      throw fromHttpStatus(response, `signal-cli event stream at ${this.baseUrl}`);
    }

    const body = response.body;
    const done = (async () => {
      try {
        for await (const event of parseEventStream(body)) {
          if (event.event !== "receive") {
            continue;
          }
          let parsed: ReceiveEvent;
          try {
            parsed = JSON.parse(event.data) as ReceiveEvent;
          } catch {
            listener.onError(new ValidationError(ADAPTER_NAME, `Ignoring malformed signal-cli event: ${event.data}`));
            continue;
          }
          await listener.onEvent(parsed);
        }
      } catch (error) {
        if (abort.signal.aborted) {
          return;
        }
        listener.onError(unreachable(`event stream at ${this.baseUrl}`, error));
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

  private async fetch(path: string, init: RequestInit, what: string): Promise<Response> {
    try {
      return await fetch(this.baseUrl + path, {
        ...init,
        headers: { ...this.headers, ...(init.headers as Record<string, string> | undefined) },
      });
    } catch (error) {
      throw unreachable(`${what} at ${this.baseUrl}`, error);
    }
  }
}
