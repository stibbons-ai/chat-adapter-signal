import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { json } from "node:stream/consumers";

export const BOT_ACCOUNT = "+15550000001";
export const BOT_ACI = "00000000-0000-4000-8000-000000000001";
/** Events the fake keeps for replay, like signal-cli 0.14.9 `SseEventBuffer.MAX_EVENTS`. */
const FAKE_BUFFER_EVENTS = 1000;
/** Makes event IDs differ between fakes started in the same millisecond. */
let fakeInstances = 0;
export const ALICE_ACI = "a1b2c3d4-0000-4000-8000-00000000a11c";
export const BOB_ACI = "b0b0b0b0-0000-4000-8000-000000000b0b";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface RecordedRequest {
  /** HTTP path and query, or `line` for a request over a line-delimited JSON-RPC connection. */
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
 * A fake signal-cli daemon speaking the 0.14.9 wire protocol. HTTP
 * (`daemon --http`): JSON-RPC on `POST /api/v1/rpc`, SSE receive events on
 * `GET /api/v1/events`, health on `GET /api/v1/check`. Line-delimited JSON-RPC
 * (`daemon --socket` / `--tcp`, and `jsonRpc` over stdio through the fake
 * executable): one JSON object per line, `receive` notifications pushed as
 * soon as a connection opens. Records every request and lets tests inject
 * envelopes, JSON-RPC errors and disconnects.
 */
export class FakeSignalCli {
  readonly requests: RecordedRequest[] = [];
  version = "0.14.9";
  accounts: Array<{ number: string | null; aci: string | null }> = [{ number: BOT_ACCOUNT, aci: BOT_ACI }];
  /**
   * Other Signal users the fake can resolve, as `listContacts` entries (`JsonContact`; `uuid` is the ACI,
   * null when only a PNI is known). Found by number, ACI or `u:<username>`, like signal-cli's server lookups.
   */
  contacts: Array<Record<string, unknown> & { number: string | null; uuid: string | null; username: string | null }> = [];
  /** Groups the Bot Account is in, as `listGroups` entries (`JsonGroup`; `id` in standard base64). */
  groups: Array<Record<string, unknown> & { id: string }> = [];
  /** Status for `/api/v1/check` and every other endpoint, e.g. 401 to act like an auth proxy. */
  httpStatus = 200;
  /** Response headers sent with a non-200 `httpStatus`, e.g. `Retry-After`. */
  httpHeaders: Record<string, string> = {};
  /**
   * Act like a daemon started with `-a` (and like `signal-cli -a <account> jsonRpc`): `listAccounts`
   * is not implemented, and `listContacts` finds the account itself.
   */
  singleAccount = false;
  /** The fake executable's runs, one per spawn: its arguments and process ID. */
  readonly spawns: Array<{ argv: string[]; pid: number }> = [];

  private readonly server: Server;
  private readonly eventStreams = new Set<ServerResponse>();
  private readonly rpcHandlers = new Map<string, RpcHandler>();
  private readonly rpcErrors = new Map<string, JsonRpcError>();
  private readonly rawRpcReplies = new Map<string, unknown>();
  private readonly holds = new Map<string, Promise<void>>();
  private readonly nextHolds = new Map<string, Promise<void>>();
  private readonly lineServers: NetServer[] = [];
  private readonly lineConnections = new Set<Socket>();
  /** Like signal-cli 0.14.9 `SseEventBuffer`: IDs `<run>-<sequence>`, a fresh `<run>` per daemon run. */
  private eventIdPrefix = `${Date.now()}i${++fakeInstances}-`;
  private nextEventSequence = 1;
  /** The newest events for `Last-Event-ID` replay. */
  private eventBuffer: Array<{ sequence: number; text: string }> = [];
  private runCount = 0;
  private nextSendTimestamp = 1_700_000_000_000;

  private constructor() {
    this.server = createServer((request, response) => void this.handle(request, response));
    this.rpcHandlers.set("version", () => ({ version: this.version }));
    this.rpcHandlers.set("listAccounts", () => (this.singleAccount ? undefined : this.accounts));
    // signal-cli 0.14.9 ListContactsCommand JSON output: the ACI is `uuid`. Like signal-cli, an ACI it
    // has not seen yet gets a new, empty recipient entry (RecipientStore.resolveRecipientLocked).
    this.rpcHandlers.set("listContacts", (params) => {
      const wanted = (params?.recipient as string[] | undefined) ?? [];
      const own = this.accounts.map((entry) => ({ number: entry.number, uuid: entry.aci, username: null, name: "" }));
      const found = [...own, ...this.contacts].filter(
        (entry) =>
          wanted.includes(entry.number ?? "") ||
          wanted.includes(entry.uuid ?? "") ||
          (entry.username !== null && wanted.includes(`u:${entry.username}`)),
      );
      const unseen = wanted.filter((recipient) => UUID_PATTERN.test(recipient) && !found.some((entry) => entry.uuid === recipient));
      return [...found, ...unseen.map((uuid) => ({ number: null, uuid, username: null, name: "", profile: null }))];
    });
    this.rpcHandlers.set("listGroups", (params) => {
      const wanted = params?.groupId as string[] | undefined;
      return this.groups.filter((group) => !wanted || wanted.includes(group.id));
    });
    // signal-cli 0.14.9 answers each of these with the sent timestamp and per-recipient results.
    for (const method of ["send", "remoteDelete", "sendReaction", "sendReceipt"]) {
      this.rpcHandlers.set(method, () => ({ timestamp: this.nextSendTimestamp++, results: [{ type: "SUCCESS" }] }));
    }
  }

  static async start(): Promise<FakeSignalCli> {
    const fake = new FakeSignalCli();
    fake.server.listen(0, "127.0.0.1");
    await once(fake.server, "listening");
    return fake;
  }

  /** Serves line-delimited JSON-RPC on a Unix socket (`daemon --socket <path>`). */
  async listenSocket(path: string): Promise<void> {
    await this.listenLine(path);
  }

  /** Serves line-delimited JSON-RPC on TCP (`daemon --tcp`), on `port` or a free one; resolves with the port. */
  async listenTcp(port = 0): Promise<number> {
    const server = await this.listenLine(port, "127.0.0.1");
    return (server.address() as AddressInfo).port;
  }

  /** Number of open line-delimited JSON-RPC connections (socket, TCP, or a running fake executable). */
  get openLineConnections(): number {
    return this.lineConnections.size;
  }

  /** Drops every line connection from the server side; the fake executable then exits with code 3. */
  dropLineConnections(): void {
    for (const socket of this.lineConnections) {
      socket.destroy();
    }
  }

  /** Resets every line connection (TCP RST), so the client sees an error (ECONNRESET) before the close. */
  resetLineConnections(): void {
    for (const socket of this.lineConnections) {
      socket.resetAndDestroy();
    }
  }

  /** Stops serving line-delimited JSON-RPC and drops every line connection, as a stopped daemon would; `listenSocket`/`listenTcp` start it again. */
  async stopLineServers(): Promise<void> {
    const servers = this.lineServers.splice(0);
    this.dropLineConnections();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }

  /** Resolves once no line connection is open. */
  // The set loses a socket in its "close" handler, so every member still has that event ahead (`closed` turns true a tick earlier).
  async lineConnectionsClosed(): Promise<void> {
    await Promise.all([...this.lineConnections].map((socket) => once(socket, "close")));
  }

  private async listenLine(...address: [string] | [number, string]): Promise<NetServer> {
    const server = createNetServer((socket) => this.serveLine(socket));
    server.listen(...(address as [number, string]));
    await once(server, "listening");
    this.lineServers.push(server);
    return server;
  }

  private serveLine(socket: Socket): void {
    this.lineConnections.add(socket);
    socket.on("close", () => this.lineConnections.delete(socket));
    socket.on("error", () => {});
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on("line", (line) => void this.handleLine(socket, line));
    lines.on("error", () => {});
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    const message = JSON.parse(line) as { fakeArgv?: string[]; pid?: number } & NonNullable<RecordedRequest["body"]>;
    // The fake executable announces its command line first; that line is not JSON-RPC.
    if (message.fakeArgv) {
      this.spawns.push({ argv: message.fakeArgv, pid: message.pid ?? 0 });
      return;
    }
    this.requests.push({ path: "line", method: "LINE", headers: {}, body: message });
    const next = this.nextHolds.get(message.method);
    this.nextHolds.delete(message.method);
    await next;
    await this.holds.get(message.method);
    if (!socket.destroyed) {
      socket.write(`${JSON.stringify(this.rpcReply(message))}\n`);
    }
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

  /**
   * Delays answering `step` until the returned function is called. `step` is "check",
   * "events", or a JSON-RPC method name. The request is recorded before it is held.
   */
  hold(step: string): () => void {
    let release!: () => void;
    this.holds.set(
      step,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return release;
  }

  /** Never answer later calls of `method` (recorded, then left open), like a wedged signal-cli; `stop()` still closes their connections. */
  swallowRpc(method: string): void {
    this.holds.set(method, new Promise<void>(() => {}));
  }

  /** Like signal-cli's `Manager.getSelfIdentifier()`: the number, or the ACI for an account without one. */
  private get selfIdentifier(): string {
    const self = this.accounts[0];
    return self?.number ?? self?.aci ?? BOT_ACCOUNT;
  }

  /** Like `hold`, but only for the next line-delimited JSON-RPC call of `method`; later calls are answered at once. */
  holdNext(method: string): () => void {
    let release!: () => void;
    this.nextHolds.set(
      method,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return release;
  }

  /** Formats a receive event with the next ID and keeps it in the replay buffer. */
  private receiveEvent(envelope: unknown): string {
    const data = JSON.stringify({ account: this.selfIdentifier, envelope });
    const sequence = this.nextEventSequence++;
    const text = `id:${this.eventIdPrefix}${sequence}\nevent:receive\ndata:${data}\n\n`;
    this.eventBuffer.push({ sequence, text });
    if (this.eventBuffer.length > FAKE_BUFFER_EVENTS) {
      this.eventBuffer.shift();
    }
    return text;
  }

  /** ID of the newest event sent so far. */
  get lastEventId(): string {
    return `${this.eventIdPrefix}${this.nextEventSequence - 1}`;
  }

  /** Like a signal-cli restart: closes every event stream and line connection and forgets the replay buffer; new IDs never match old ones. */
  restartDaemon(): void {
    this.closeEventStreams();
    this.dropLineConnections();
    this.eventBuffer = [];
    this.eventIdPrefix = `${Date.now()}i${++fakeInstances}r${++this.runCount}-`;
    this.nextEventSequence = 1;
  }

  /** Sends a receive event for the Bot Account (or the given `account`) to every open event stream and line connection. */
  injectEnvelope(envelope: unknown, account = this.selfIdentifier): void {
    const event = this.receiveEvent(envelope);
    this.broadcast(event);
    this.injectLine({ jsonrpc: "2.0", method: "receive", params: { account, envelope } });
  }

  /** Writes one JSON value (or a raw string) as a line to every line connection. */
  injectLine(message: unknown): void {
    const line = typeof message === "string" ? message : JSON.stringify(message);
    for (const socket of this.lineConnections) {
      socket.write(`${line}\n`);
    }
  }

  /** Like `injectEnvelope`, but delivers the event's bytes in separate writes of `size` bytes each, as a slow network would. */
  async injectEnvelopeInPieces(envelope: unknown, size: number): Promise<void> {
    const bytes = Buffer.from(this.receiveEvent(envelope));
    for (let offset = 0; offset < bytes.length; offset += size) {
      this.broadcast(bytes.subarray(offset, offset + size));
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  /** Writes raw bytes to every open event stream, for framing and malformed-data cases. */
  injectRaw(text: string): void {
    this.broadcast(text);
  }

  /** Writes to every event stream the server has not ended. */
  private broadcast(chunk: string | Uint8Array): void {
    for (const stream of this.eventStreams) {
      if (!stream.writableEnded) {
        stream.write(chunk);
      }
    }
  }

  /** Ends every open event stream from the server side, as a daemon restart would. */
  closeEventStreams(): void {
    for (const stream of this.eventStreams) {
      stream.end();
    }
  }

  /** Resolves once an event stream closes (or immediately if none is open). */
  // Set membership, not `closed`: a member still has its "close" event ahead.
  async eventStreamsClosed(): Promise<void> {
    await Promise.all([...this.eventStreams].map((stream) => once(stream, "close")));
  }

  async stop(): Promise<void> {
    for (const server of this.lineServers.splice(0)) {
      this.dropLineConnections();
      server.close();
      await once(server, "close");
    }
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
      await this.holds.get("check");
      response.writeHead(200).end();
      return;
    }

    if (url.pathname === "/api/v1/events" && request.method === "GET") {
      // Like signal-cli 0.14.9 (HttpServerHandler.getManagerFromQuery): the account must match a
      // number or the lowercase dashed ACI exactly; this path does not normalise.
      const account = url.searchParams.get("account");
      if (account && !this.accounts.some((entry) => entry.number === account || entry.aci === account)) {
        response.writeHead(400).end();
        return;
      }
      await this.holds.get("events");
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.flushHeaders();
      // signal-cli 0.14.9 replay: after a known ID, the newer buffered events; after an unknown one, all of them; without the header, none.
      const lastEventId = request.headers["last-event-id"];
      if (typeof lastEventId === "string") {
        const after = lastEventId.startsWith(this.eventIdPrefix) ? Number(lastEventId.slice(this.eventIdPrefix.length)) || 0 : 0;
        for (const event of this.eventBuffer) {
          if (event.sequence > after) {
            response.write(event.text);
          }
        }
      }
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
      await this.holds.get(body.method);
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(this.rpcReply(body)));
      return;
    }

    response.writeHead(404).end();
  }

  private rpcReply(body: NonNullable<RecordedRequest["body"]>): unknown {
    if (this.rawRpcReplies.has(body.method)) {
      return this.rawRpcReplies.get(body.method);
    }
    const error = this.rpcErrors.get(body.method);
    if (error) {
      return { jsonrpc: "2.0", id: body.id ?? null, error };
    }
    const result = this.rpcHandlers.get(body.method)?.(body.params);
    if (result !== undefined) {
      return { jsonrpc: "2.0", id: body.id ?? null, result };
    }
    return { jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: "Method not implemented" } };
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

/**
 * A Group text envelope as signal-cli 0.14.9 emits it: `groupInfo.groupId` in
 * standard base64, native @mentions as `mentions[]` (the text holds U+FFFC at
 * each mention), a quote-reply as `quote`.
 */
export function groupTextEnvelope(options: {
  aci: string;
  groupId: string;
  text: string;
  mentions?: Array<{ aci: string; start: number }>;
  quoteAuthor?: string;
  timestamp?: number;
}) {
  const envelope = directTextEnvelope({ aci: options.aci, text: options.text, ...(options.timestamp ? { timestamp: options.timestamp } : {}) });
  return {
    ...envelope,
    dataMessage: {
      ...envelope.dataMessage,
      groupInfo: { groupId: options.groupId, groupName: "Test Group", revision: 3, type: "DELIVER" },
      ...(options.mentions && {
        mentions: options.mentions.map(({ aci, start }) => ({ name: aci, number: null, uuid: aci, start, length: 1 })),
      }),
      ...(options.quoteAuthor && {
        quote: {
          id: 1_700_000_000_000,
          author: options.quoteAuthor,
          authorNumber: null,
          authorUuid: options.quoteAuthor,
          text: "quoted",
          attachments: [],
        },
      }),
    },
  };
}

/**
 * A reaction envelope as signal-cli 0.14.9 emits it (`JsonReaction` in the data
 * message, `message` null), in a 1:1 Conversation or, with `groupId`, a Group.
 */
export function reactionEnvelope(options: {
  aci: string;
  emoji: string;
  targetAuthor: string;
  targetTimestamp: number;
  remove?: boolean;
  groupId?: string;
}) {
  const envelope = directTextEnvelope({ aci: options.aci, text: "" });
  return {
    ...envelope,
    dataMessage: {
      ...envelope.dataMessage,
      message: null,
      reaction: {
        emoji: options.emoji,
        targetAuthor: options.targetAuthor,
        targetAuthorNumber: null,
        targetAuthorUuid: options.targetAuthor,
        targetSentTimestamp: options.targetTimestamp,
        isRemove: options.remove ?? false,
      },
      ...(options.groupId && { groupInfo: { groupId: options.groupId, groupName: "Test Group", revision: 3, type: "DELIVER" } }),
    },
  };
}
