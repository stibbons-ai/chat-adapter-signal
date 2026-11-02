import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { NetworkError, ValidationError } from "@chat-adapter/shared";
import type { ReceiveEvent } from "../envelope.js";
import { ADAPTER_NAME, fromJsonRpcError, unreachable, type JsonRpcErrorObject } from "../errors.js";
import type { EventListener, EventSubscription, SignalTransport } from "./types.js";

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
   * connected. `null` once the subscription closed: later notifications are dropped.
   */
  private early: ReceiveEvent[] | null = [];
  private readonly pending = new Map<number, Pending>();
  private nextRequestId = 1;

  constructor(options: LineTransportOptions, account: string) {
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
    await this.connect();
  }

  async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const connection = await this.connect();
    const id = this.nextRequestId++;
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { method, resolve, reject }));
    connection.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return (await result) as T;
  }

  async subscribe(listener: EventListener): Promise<EventSubscription> {
    await this.connect();
    this.listener = listener;
    const early = this.early ?? [];
    this.early = [];
    for (const event of early) {
      this.deliver(event);
    }
    // Only stops delivery: running handlers may still reply over this connection while the
    // adapter drains them; `close()` releases the connection afterwards.
    return {
      close: async () => {
        if (this.listener === listener) {
          this.listener = undefined;
          this.early = null;
        }
      },
    };
  }

  async close(): Promise<void> {
    const connecting = this.connection;
    this.connection = undefined;
    this.listener = undefined;
    const connection = await connecting?.catch(() => undefined);
    await connection?.close();
  }

  private connect(): Promise<Connection> {
    if (!this.connection) {
      const connecting = this.open().then((connection) => {
        this.early = [];
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
    lines.on("line", (line) => this.handleLine(line));
    void connection.ended.then((reason) => {
      lines.close();
      if (this.connection === current) {
        this.connection = undefined;
      }
      const error = reason ?? new NetworkError(ADAPTER_NAME, `signal-cli connection (${this.endpoint}) was closed`);
      for (const [id, pending] of this.pending) {
        this.pending.delete(id);
        pending.reject(error);
      }
      const listener = this.listener;
      this.listener = undefined;
      this.early = [];
      if (reason && listener) {
        listener.onError(reason);
        listener.onClosed();
      }
    });
  }

  private handleLine(line: string): void {
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
      const params = message.params;
      if (typeof params !== "object" || params === null || Array.isArray(params)) {
        this.listener?.onError(new ValidationError(ADAPTER_NAME, "Ignoring a signal-cli receive notification without params"));
      } else if (this.listener) {
        this.deliver(params as ReceiveEvent);
      } else {
        this.early?.push(params as ReceiveEvent);
      }
      return;
    }
    if (message.method !== undefined) {
      return; // Other notifications (e.g. callEvent) are outside this adapter.
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
      pending.reject(new NetworkError(ADAPTER_NAME, `signal-cli JSON-RPC ${pending.method} returned a malformed response`));
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

async function connectSocket(socket: Socket, endpoint: string): Promise<Connection> {
  try {
    await once(socket, "connect");
  } catch (error) {
    socket.destroy();
    throw unreachable(`connecting to ${endpoint}`, error);
  }
  let closing = false;
  let failure: Error | undefined;
  socket.on("error", (error) => {
    failure = error;
  });
  const ended = once(socket, "close").then(() =>
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
  // Writing to a process that just exited raises EPIPE on stdin; the exit itself is reported below.
  child.stdin.on("error", () => {});
  let closing = false;
  const ended = once(child, "close").then(([code, signal]) => {
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
