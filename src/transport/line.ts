import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { NetworkError, ValidationError } from "@chat-adapter/shared";
import type { ReceiveEvent } from "../envelope.js";
import { ADAPTER_NAME, fromJsonRpcError, malformedResponse, unreachable, type JsonRpcErrorObject } from "../errors.js";
import type { EventListener, EventSubscription, SignalTransport, SubscribeOptions } from "./types.js";

export interface SpawnTransportOptions {
  type: "spawn";
  /** The signal-cli executable you installed. Default: `signal-cli` from `PATH`. */
  command?: string;
  /** Extra arguments placed before `-a <account> jsonRpc`, e.g. `["--config", "/var/lib/signal-cli"]`. */
  args?: string[];
}

export interface SocketTransportOptions {
  type: "socket";
  /** Unix socket of `signal-cli daemon --socket <path>`. */
  path: string;
}

export interface TcpTransportOptions {
  type: "tcp";
  /** Host and port of `signal-cli daemon --tcp <host:port>`. */
  host: string;
  port: number;
}

export type LineTransportOptions = SpawnTransportOptions | SocketTransportOptions | TcpTransportOptions;

/** How long `close()` waits for a spawned signal-cli to exit after SIGTERM before sending SIGKILL. */
const KILL_AFTER_MS = 5_000;
/** Most notifications kept for a subscriber that has not (re)subscribed yet. */
const EARLY_EVENTS_MAX = 1_000;
/** Longest stderr excerpt quoted in an unexpected-exit error. */
const STDERR_EXCERPT_CHARS = 300;

interface Connection {
  input: Readable;
  output: Writable;
  /** Resolves once the connection is gone, with the reason when it ended on its own. */
  ended: Promise<NetworkError | undefined>;
  /** Ends the connection on purpose and resolves once it is gone. */
  close(): Promise<void>;
}

interface Pending {
  method: string;
  /** The connection the request went out on: its end, or an id-less error on it, rejects the request. */
  connection: Promise<Connection>;
  resolve(result: unknown): void;
  reject(error: unknown): void;
}

interface JsonRpcLine {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

/**
 * signal-cli's line-delimited JSON-RPC (one JSON object per `\n`-terminated
 * line), shared by a spawned `signal-cli jsonRpc` (stdio) and a daemon's Unix
 * socket or TCP port. One connection carries both requests and `receive`
 * notifications; it is opened on first use and again after it ended, so a
 * fresh `subscribe()` after a drop reconnects (or respawns signal-cli).
 */
export class LineTransport implements SignalTransport {
  readonly endpoint: string;
  private readonly open: () => Promise<Connection>;
  private connection: Promise<Connection> | undefined;
  private listener: EventListener | undefined;
  /**
   * Notifications that arrived before `subscribe()`: signal-cli starts pushing as soon as it is
   * connected. Armed by `checkReachable()` (startup), `subscribe()`, and a drop while subscribed
   * (the receive loop subscribes again after its backoff, and a reply sent meanwhile reopens the
   * connection). `null` otherwise, so a connection reopened by a late reply after `close()` or
   * an unsubscribe drops its notifications instead of piling them up. At most `EARLY_EVENTS_MAX`.
   */
  private early: ReceiveEvent[] | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextRequestId = 1;

  /** Validates `options` (they may come from untyped JavaScript) and prepares, but does not open, the connection. */
  constructor(options: LineTransportOptions, account: string) {
    validate(options);
    switch (options.type) {
      case "spawn": {
        const command = options.command ?? "signal-cli";
        const args = [...(options.args ?? []), "-a", account, "jsonRpc"];
        this.endpoint = `spawned ${command}`;
        this.open = () => spawnSignalCli(command, args);
        break;
      }
      case "socket":
        this.endpoint = `unix:${options.path}`;
        this.open = () => connectSocket(createConnection({ path: options.path }), this.endpoint);
        break;
      case "tcp":
        this.endpoint = `tcp://${options.host}:${options.port}`;
        this.open = () => connectSocket(createConnection({ host: options.host, port: options.port }), this.endpoint);
        break;
    }
  }

  async checkReachable(): Promise<void> {
    this.early ??= [];
    await this.connect();
  }

  async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const connecting = this.connect();
    const connection = await connecting;
    const id = this.nextRequestId++;
    const result = new Promise<unknown>((resolve, reject) =>
      this.pending.set(id, { method, connection: connecting, resolve, reject }),
    );
    connection.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return (await result) as T;
  }

  /**
   * One subscriber at a time: a second `subscribe()` replaces the first. signal-cli's line protocol
   * has no event IDs or replay, so `options.lastEventId` is ignored and events carry no ID.
   */
  async subscribe(listener: EventListener, options: SubscribeOptions = {}): Promise<EventSubscription> {
    const { signal } = options;
    signal?.throwIfAborted();
    this.early ??= [];
    // ponytail: an abort stops waiting for the connect, not the connect itself; `close()` still
    // awaits it, which for a TCP host that never answers is the OS connect timeout.
    await abortable(this.connect(), signal);
    // Its own identity, so closing an older subscription of the same listener (a reconnect) leaves this one alone.
    const own: EventListener = {
      onEvent: (event) => listener.onEvent(event),
      onError: (error) => listener.onError(error),
      onClosed: () => listener.onClosed(),
    };
    this.listener = own;
    const early = this.early ?? [];
    this.early = [];
    for (const event of early) {
      this.deliver(event);
    }
    // Only stops delivery: running handlers may still reply over this connection while the
    // adapter drains them; `close()` releases the connection afterwards.
    const stop = async () => {
      signal?.removeEventListener("abort", stop);
      if (this.listener === own) {
        this.listener = undefined;
        this.early = null;
      }
    };
    signal?.addEventListener("abort", stop, { once: true });
    return { close: stop };
  }

  async close(): Promise<void> {
    const connecting = this.connection;
    this.connection = undefined;
    this.listener = undefined;
    this.early = null;
    const connection = await connecting?.catch(() => undefined);
    await connection?.close();
  }

  private connect(): Promise<Connection> {
    if (!this.connection) {
      const connecting = this.open().then((connection) => {
        this.read(connection, connecting);
        return connection;
      });
      // A failed connect is not cached: the next call tries again.
      connecting.catch(() => {
        if (this.connection === connecting) {
          this.connection = undefined;
        }
      });
      this.connection = connecting;
    }
    return this.connection;
  }

  private read(connection: Connection, current: Promise<Connection>): void {
    const lines = createInterface({ input: connection.input, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line, current));
    // readline re-emits input errors; the connection's own error handling reports them via `ended`.
    lines.on("error", () => {});
    void connection.ended.then((reason) => {
      lines.close();
      const error = reason ?? new NetworkError(ADAPTER_NAME, `signal-cli connection (${this.endpoint}) was closed`);
      this.rejectPending(current, () => error);
      // After close() a newer connection may be current; this one's end must not touch its subscriber.
      if (this.connection !== current) {
        return;
      }
      this.connection = undefined;
      const listener = this.listener;
      this.listener = undefined;
      // A drop of a connection a reply reopened (no listener yet) keeps what is already buffered.
      this.early = listener ? [] : this.early;
      if (reason && listener) {
        listener.onError(reason);
        listener.onClosed();
      }
    });
  }

  private rejectPending(connection: Promise<Connection>, error: (pending: Pending) => unknown): void {
    for (const [id, pending] of this.pending) {
      if (pending.connection === connection) {
        this.pending.delete(id);
        pending.reject(error(pending));
      }
    }
  }

  private handleLine(line: string, connection: Promise<Connection>): void {
    if (line.trim() === "") {
      return;
    }
    let message: JsonRpcLine;
    try {
      message = JSON.parse(line) as JsonRpcLine;
    } catch {
      // Never log the line or the parse error (V8 quotes the input): both can carry message text and phone numbers.
      this.listener?.onError(
        new ValidationError(ADAPTER_NAME, `Ignoring a signal-cli line that is not valid JSON (${line.length} chars)`),
      );
      return;
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      this.listener?.onError(new ValidationError(ADAPTER_NAME, "Ignoring a signal-cli line that is not a JSON object"));
      return;
    }

    if (message.method === "receive") {
      if (this.connection !== connection) {
        return; // A connection being closed may still flush notifications; nobody subscribed to it.
      }
      const params = message.params;
      if (typeof params !== "object" || params === null || Array.isArray(params)) {
        this.listener?.onError(new ValidationError(ADAPTER_NAME, "Ignoring a signal-cli receive notification without params"));
      } else if (this.listener) {
        this.deliver(params as ReceiveEvent);
      } else if (this.early && this.early.length < EARLY_EVENTS_MAX) {
        // ponytail: drops the newest past the cap; nobody is subscribed to tell. 1 000 as signal-cli 0.14.9's HTTP replay buffer (SseEventBuffer.MAX_EVENTS).
        this.early.push(params as ReceiveEvent);
      }
      return;
    }
    if (message.method !== undefined) {
      return; // Other notifications (e.g. callEvent) are outside this adapter.
    }

    // signal-cli answers a request it could not parse with `"id": null`; it cannot say which one, so all fail.
    if (message.id === null && message.error) {
      const error = message.error;
      this.rejectPending(connection, (pending) => fromJsonRpcError(error, pending.method));
      return;
    }
    const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
    if (!pending) {
      return;
    }
    this.pending.delete(message.id as number);
    if (message.error) {
      pending.reject(fromJsonRpcError(message.error, pending.method));
    } else if ("result" in message) {
      pending.resolve(message.result);
    } else {
      pending.reject(malformedResponse(pending.method));
    }
  }

  private deliver(event: ReceiveEvent): void {
    try {
      this.listener?.onEvent(event);
    } catch (error) {
      this.listener?.onError(error);
    }
  }
}

/** `promise`, or a rejection with the abort reason once `signal` aborts first. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function validate(options: LineTransportOptions): void {
  const fail = (message: string) => {
    throw new ValidationError(ADAPTER_NAME, `${message} for \`{ type: "${options.type}" }\`.`);
  };
  const isNonEmptyString = (value: unknown) => typeof value === "string" && value !== "";
  switch (options.type) {
    case "spawn":
      if (options.command !== undefined && !isNonEmptyString(options.command)) {
        fail("transport.command must be a non-empty string");
      }
      if (options.args !== undefined && !(Array.isArray(options.args) && options.args.every((arg) => typeof arg === "string"))) {
        fail("transport.args must be an array of strings");
      }
      break;
    case "socket":
      if (!isNonEmptyString(options.path)) {
        fail("transport.path is required");
      }
      break;
    case "tcp":
      if (!isNonEmptyString(options.host)) {
        fail("transport.host is required");
      }
      if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
        fail("transport.port must be an integer from 1 to 65535");
      }
      break;
  }
}

async function connectSocket(socket: Socket, endpoint: string): Promise<Connection> {
  try {
    await once(socket, "connect");
  } catch (error) {
    socket.destroy();
    throw unreachable(`connecting to ${endpoint}`, error);
  }
  // Without it a TCP connection that died without closing (NAT timeout, a host gone) goes unnoticed
  // for good; the OS then gives up after its keep-alive probes. A no-op on a Unix socket.
  socket.setKeepAlive(true, 30_000);
  let closing = false;
  let failure: Error | undefined;
  socket.on("error", (error) => {
    failure = error;
  });
  // Not `once(socket, "close")`: that rejects when "error" comes first, which is exactly the case to report.
  const ended = new Promise((resolve) => socket.once("close", resolve)).then(() =>
    closing
      ? undefined
      : new NetworkError(
          ADAPTER_NAME,
          `signal-cli closed the connection (${endpoint})${failure ? `: ${failure.message}` : ""}`,
          failure,
        ),
  );
  return {
    input: socket,
    output: socket,
    ended,
    async close() {
      closing = true;
      socket.destroy();
      await ended;
    },
  };
}

async function spawnSignalCli(command: string, args: string[]): Promise<Connection> {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  try {
    await once(child, "spawn");
  } catch (error) {
    throw unreachable(`starting ${command}`, error);
  }
  // Keep only the tail of stderr: it explains an exit (e.g. "User +1555… is not registered.").
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4 * STDERR_EXCERPT_CHARS);
  });
  // Writing to a process that just exited raises EPIPE on stdin, and a failed kill() emits "error"
  // on the child; the exit itself is reported below.
  child.stdin.on("error", () => {});
  child.on("error", () => {});
  let closing = false;
  const ended = new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
    child.once("close", (code, signal) => resolve([code, signal])),
  ).then(([code, signal]) => {
    if (closing) {
      return undefined;
    }
    const lastLine = stderr.trim().split(/\r?\n/).at(-1)?.slice(0, STDERR_EXCERPT_CHARS);
    return new NetworkError(
      ADAPTER_NAME,
      `signal-cli (${command}) exited unexpectedly with ${signal ? `signal ${signal}` : `code ${code}`}` +
        (lastLine ? `: ${lastLine}` : ""),
    );
  });
  return {
    input: child.stdout,
    output: child.stdin,
    ended,
    async close() {
      closing = true;
      child.stdin.end();
      child.kill("SIGTERM");
      const killer = setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS);
      killer.unref();
      await ended;
      clearTimeout(killer);
    },
  };
}
