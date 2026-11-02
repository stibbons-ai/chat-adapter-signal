import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { json } from "node:stream/consumers";

export const BOT_ACCOUNT = "+15550000001";
export const BOT_ACI = "00000000-0000-4000-8000-000000000001";

export interface RecordedRequest {
  path: string;
  method: string;
  headers: IncomingHttpHeaders;
  /** Parsed JSON-RPC body, for `/api/v1/rpc`. */
  body?: { jsonrpc: string; id?: number | string; method: string; params?: Record<string, unknown> };
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

type RpcHandler = (params: Record<string, unknown> | undefined) => unknown;

/**
 * A fake signal-cli HTTP daemon (`signal-cli daemon --http`) speaking the
 * 0.14.9 wire protocol: JSON-RPC on `POST /api/v1/rpc`, SSE receive events on
 * `GET /api/v1/events`, health on `GET /api/v1/check`. Records every request
 * and lets tests inject envelopes and JSON-RPC errors.
 */
export class FakeSignalCli {
  readonly requests: RecordedRequest[] = [];
  version = "0.14.9";
  accounts: Array<{ number: string | null; aci: string | null }> = [{ number: BOT_ACCOUNT, aci: BOT_ACI }];
  /** Status for `/api/v1/check` and every other endpoint, e.g. 401 to act like an auth proxy. */
  httpStatus = 200;
  /** Response headers sent with a non-200 `httpStatus`, e.g. `Retry-After`. */
  httpHeaders: Record<string, string> = {};

  private readonly server: Server;
  private readonly eventStreams = new Set<ServerResponse>();
  private readonly rpcHandlers = new Map<string, RpcHandler>();
  private readonly rpcErrors = new Map<string, JsonRpcError>();
  private readonly rawRpcReplies = new Map<string, unknown>();
  private readonly eventIdPrefix = `${Date.now()}-`;
  private nextEventSequence = 1;
  private nextSendTimestamp = 1_700_000_000_000;

  private constructor() {
    this.server = createServer((request, response) => void this.handle(request, response));
    this.rpcHandlers.set("version", () => ({ version: this.version }));
    this.rpcHandlers.set("listAccounts", () => this.accounts);
    this.rpcHandlers.set("send", () => ({
      timestamp: this.nextSendTimestamp++,
      results: [{ type: "SUCCESS" }],
    }));
  }

  static async start(): Promise<FakeSignalCli> {
    const fake = new FakeSignalCli();
    fake.server.listen(0, "127.0.0.1");
    await once(fake.server, "listening");
    return fake;
  }

  get url(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  /** Number of currently open SSE event streams. */
  get openEventStreams(): number {
    return this.eventStreams.size;
  }

  /** JSON-RPC requests seen so far, optionally only those for one method. */
  rpcRequests(method?: string): NonNullable<RecordedRequest["body"]>[] {
    return this.requests.flatMap((request) =>
      request.body && (method === undefined || request.body.method === method) ? [request.body] : [],
    );
  }

  /** Answer every later call of `method` with this JSON-RPC error. */
  failRpc(method: string, error: JsonRpcError): void {
    this.rpcErrors.set(method, error);
  }

  /** Answer every later call of `method` with this exact JSON body, valid JSON-RPC or not (as a broken proxy might). */
  replyRpcRaw(method: string, body: unknown): void {
    this.rawRpcReplies.set(method, body);
  }

  private receiveEvent(envelope: unknown): string {
    const data = JSON.stringify({ account: BOT_ACCOUNT, envelope });
    return `id:${this.eventIdPrefix}${this.nextEventSequence++}\nevent:receive\ndata:${data}\n\n`;
  }

  /** Sends a receive event for the Bot Account to every open event stream. */
  injectEnvelope(envelope: unknown): void {
    const event = this.receiveEvent(envelope);
    for (const stream of this.eventStreams) {
      stream.write(event);
    }
  }

  /** Like `injectEnvelope`, but delivers the event's bytes in separate writes of `size` bytes each, as a slow network would. */
  async injectEnvelopeInPieces(envelope: unknown, size: number): Promise<void> {
    const bytes = Buffer.from(this.receiveEvent(envelope));
    for (let offset = 0; offset < bytes.length; offset += size) {
      for (const stream of this.eventStreams) {
        stream.write(bytes.subarray(offset, offset + size));
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  /** Writes raw bytes to every open event stream, for framing and malformed-data cases. */
  injectRaw(text: string): void {
    for (const stream of this.eventStreams) {
      stream.write(text);
    }
  }

  /** Ends every open event stream from the server side, as a daemon restart would. */
  closeEventStreams(): void {
    for (const stream of this.eventStreams) {
      stream.end();
    }
  }

  /** Resolves once an event stream closes (or immediately if none is open). */
  async eventStreamsClosed(): Promise<void> {
    await Promise.all([...this.eventStreams].map((stream) => (stream.closed ? undefined : once(stream, "close"))));
  }

  async stop(): Promise<void> {
    if (!this.server.listening) {
      return;
    }
    for (const stream of this.eventStreams) {
      stream.end();
    }
    this.server.closeAllConnections();
    this.server.close();
    await once(this.server, "close");
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://fake");
    const recorded: RecordedRequest = { path: url.pathname + url.search, method: request.method ?? "", headers: request.headers };
    this.requests.push(recorded);

    if (this.httpStatus !== 200) {
      response.writeHead(this.httpStatus, this.httpHeaders).end();
      return;
    }

    if (url.pathname === "/api/v1/check" && request.method === "GET") {
      response.writeHead(200).end();
      return;
    }

    if (url.pathname === "/api/v1/events" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.flushHeaders();
      this.eventStreams.add(response);
      response.on("close", () => this.eventStreams.delete(response));
      return;
    }

    if (url.pathname === "/api/v1/rpc" && request.method === "POST") {
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        response.writeHead(415).end();
        return;
      }
      const body = (await json(request)) as NonNullable<RecordedRequest["body"]>;
      recorded.body = body;
      this.respondRpc(body, response);
      return;
    }

    response.writeHead(404).end();
  }

  private respondRpc(body: NonNullable<RecordedRequest["body"]>, response: ServerResponse): void {
    const handler = this.rpcHandlers.get(body.method);
    const error = this.rpcErrors.get(body.method);
    let reply: unknown;
    if (this.rawRpcReplies.has(body.method)) {
      reply = this.rawRpcReplies.get(body.method);
    } else if (error) {
      reply = { jsonrpc: "2.0", id: body.id ?? null, error };
    } else if (handler) {
      reply = { jsonrpc: "2.0", id: body.id ?? null, result: handler(body.params) };
    } else {
      reply = { jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: "Method not implemented" } };
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(reply));
  }
}

let nextTimestamp = 1_700_000_100_000;

/** A 1:1 text envelope as signal-cli 0.14.9 emits it (`JsonMessageEnvelope`). */
export function directTextEnvelope(options: {
  aci: string;
  text: string;
  number?: string | null;
  name?: string | null;
  timestamp?: number;
}) {
  const timestamp = options.timestamp ?? nextTimestamp++;
  return {
    source: options.number ?? options.aci,
    sourceNumber: options.number ?? null,
    sourceUuid: options.aci,
    sourceName: options.name ?? null,
    sourceDevice: 1,
    timestamp,
    serverReceivedTimestamp: timestamp + 50,
    serverDeliveredTimestamp: timestamp + 60,
    dataMessage: {
      timestamp,
      message: options.text,
      expiresInSeconds: 0,
      viewOnce: false,
    },
  };
}
