import { AdapterError, AuthenticationError, NetworkError, ValidationError } from "@chat-adapter/shared";
import {
  NotImplementedError,
  type Adapter,
  type AdapterPostableMessage,
  type ChatInstance,
  type EmojiValue,
  type FetchResult,
  type FormattedContent,
  type Logger,
  type Message,
  type RawMessage,
  type ThreadInfo,
} from "chat";
import {
  parseDirectTextMessage,
  type ReceiveEvent,
  type SignalRawMessage,
  type SignalSendResult,
} from "./envelope.js";
import { ADAPTER_NAME } from "./errors.js";
import { SignalFormatConverter } from "./format.js";
import { HttpTransport, type HttpTransportOptions } from "./transport/http.js";
import type { EventSubscription, SignalTransport } from "./transport/types.js";
import {
  decodeThreadId,
  encodeMessageId,
  encodeThreadId,
  isAci,
  normalizeAci,
  type SignalThreadId,
} from "./thread-id.js";

/** Oldest signal-cli release this adapter is tested against. */
export const MIN_SIGNAL_CLI_VERSION = "0.14.9";

/** How the adapter reaches signal-cli, by `type`. Only the HTTP daemon is supported so far. */
export type SignalTransportConfig = HttpTransportOptions;

export interface SignalAdapterConfig {
  /** The Bot Account's phone number (or ACI) as registered in signal-cli. Falls back to `SIGNAL_ACCOUNT`. */
  account?: string;
  /** Falls back to `SIGNAL_CLI_URL`, which implies the HTTP transport. */
  transport?: SignalTransportConfig;
  /** Bot display name; defaults to the Chat instance's `userName`. */
  userName?: string;
  /** Defaults to the Chat instance's logger. */
  logger?: Logger;
  /** How long `disconnect()` waits for running message handlers to finish. Default: 10 000 ms. */
  drainTimeoutMs?: number;
}

interface SignalAccount {
  number?: string | null;
  aci?: string | null;
}

export class SignalAdapter implements Adapter<SignalThreadId, SignalRawMessage> {
  readonly name = ADAPTER_NAME;

  private readonly account: string;
  private readonly transport: SignalTransport;
  private readonly formatConverter = new SignalFormatConverter();
  private readonly explicitUserName: string | undefined;
  private logger: Logger | undefined;
  private chat: ChatInstance | undefined;
  private readonly drainTimeoutMs: number;
  /** Message handlers still running; `disconnect()` waits for them, bounded by `drainTimeoutMs`. */
  private readonly inFlight = new Set<Promise<void>>();
  private subscription: EventSubscription | undefined;
  private _userName: string;
  private _botUserId: string | undefined;

  constructor(config: SignalAdapterConfig = {}) {
    const account = config.account ?? process.env.SIGNAL_ACCOUNT;
    if (!account) {
      throw new ValidationError(ADAPTER_NAME, "account is required. Set SIGNAL_ACCOUNT or pass `account`.");
    }
    const envUrl = process.env.SIGNAL_CLI_URL;
    const transport = config.transport ?? (envUrl ? { type: "http" as const, url: envUrl } : undefined);
    if (!transport) {
      throw new ValidationError(
        ADAPTER_NAME,
        'transport is required. Set SIGNAL_CLI_URL or pass `transport: { type: "http", url }`.',
      );
    }

    // signal-cli normalises an ACI on JSON-RPC but not in the events query, so send its canonical form everywhere.
    this.account = normalizeAci(account) ?? account;
    this.transport = createTransport(transport, this.account);
    this.drainTimeoutMs = config.drainTimeoutMs ?? 10_000;
    this.explicitUserName = config.userName;
    this._userName = config.userName ?? "bot";
    this.logger = config.logger;
  }

  get userName(): string {
    return this._userName;
  }

  /** The Bot Account's ACI, known after `initialize()`. */
  get botUserId(): string | undefined {
    return this._botUserId;
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger ??= chat.getLogger(ADAPTER_NAME);
    this._userName = this.explicitUserName ?? chat.getUserName();

    await this.transport.checkReachable();
    await this.checkVersion();
    this._botUserId = await this.resolveBotAci();
    this.subscription = await this.transport.subscribe({
      onEvent: (event) => this.handleEvent(event),
      onError: (error) => this.logger?.error("signal-cli event stream error", { error }),
      onClosed: () => this.logger?.warn("signal-cli event stream closed; no further messages will be received"),
    });
  }

  /**
   * Closes the event stream, then waits for running handlers so their replies
   * and lock releases complete before Chat disconnects its state. The wait is
   * bounded: a handler that never settles (or that itself calls
   * `chat.shutdown()`) cannot hold shutdown forever.
   */
  async disconnect(): Promise<void> {
    const subscription = this.subscription;
    this.subscription = undefined;
    await subscription?.close();
    if (this.inFlight.size === 0) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), this.drainTimeoutMs);
    });
    const pending = this.inFlight.size;
    const timedOut = await Promise.race([Promise.allSettled(this.inFlight).then(() => false), expired]);
    clearTimeout(timer);
    if (timedOut) {
      this.logger?.warn(`Stopped waiting for ${pending} Signal message handler(s) after ${this.drainTimeoutMs} ms`);
    }
  }

  async handleWebhook(): Promise<Response> {
    return new Response("The Signal adapter receives messages from signal-cli, not via webhooks.", { status: 501 });
  }

  encodeThreadId(platformData: SignalThreadId): string {
    return encodeThreadId(platformData);
  }

  decodeThreadId(threadId: string): SignalThreadId {
    return decodeThreadId(threadId);
  }

  /** A Conversation is both Thread and Channel (ADR-0002). */
  channelIdFromThreadId(threadId: string): string {
    decodeThreadId(threadId);
    return threadId;
  }

  isDM(threadId: string): boolean {
    return decodeThreadId(threadId).type === "dm";
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { type } = decodeThreadId(threadId);
    return { id: threadId, channelId: threadId, isDM: type === "dm", metadata: {} };
  }

  parseMessage(raw: SignalRawMessage): Message<SignalRawMessage> {
    const message = "sourceUuid" in raw ? parseDirectTextMessage(raw, this.formatConverter, this._botUserId) : null;
    if (!message) {
      throw new ValidationError(ADAPTER_NAME, "Only 1:1 text envelopes can be parsed into messages");
    }
    return message;
  }

  renderFormatted(content: FormattedContent): string {
    return this.formatConverter.fromAst(content);
  }

  async postMessage(threadId: string, message: AdapterPostableMessage): Promise<RawMessage<SignalRawMessage>> {
    const { aci } = decodeThreadId(threadId);
    const botAci = this.requireBotAci();
    const result = await this.transport.request<SignalSendResult | null>("send", {
      account: this.account,
      recipient: [aci],
      message: this.formatConverter.renderPostable(message),
    });
    if (!(result && Number.isSafeInteger(result.timestamp))) {
      throw new NetworkError(ADAPTER_NAME, "signal-cli send returned no message timestamp");
    }
    return { id: encodeMessageId(botAci, result.timestamp), threadId, raw: result };
  }

  async editMessage(): Promise<RawMessage<SignalRawMessage>> {
    throw new NotImplementedError("The Signal adapter does not support editing messages yet", "editMessage");
  }

  async deleteMessage(): Promise<void> {
    throw new NotImplementedError("The Signal adapter does not support deleting messages yet", "deleteMessage");
  }

  async addReaction(_threadId: string, _messageId: string, _emoji: EmojiValue | string): Promise<void> {
    throw new NotImplementedError("The Signal adapter does not support reactions yet", "addReaction");
  }

  async removeReaction(_threadId: string, _messageId: string, _emoji: EmojiValue | string): Promise<void> {
    throw new NotImplementedError("The Signal adapter does not support reactions yet", "removeReaction");
  }

  async startTyping(): Promise<void> {
    throw new NotImplementedError("The Signal adapter does not support typing indicators yet", "startTyping");
  }

  async fetchMessages(): Promise<FetchResult<SignalRawMessage>> {
    throw new NotImplementedError("The Signal adapter does not support fetching messages yet", "fetchMessages");
  }

  private async checkVersion(): Promise<void> {
    const version = (await this.transport.request<{ version?: unknown } | null>("version"))?.version;
    const actual = typeof version === "string" ? parseVersion(version) : undefined;
    if (!actual) {
      this.logger?.warn(
        `signal-cli reported an unrecognised version; cannot check it against ${MIN_SIGNAL_CLI_VERSION}, the oldest version this adapter is tested with`,
        { version },
      );
    } else if (compareVersions(actual, MIN_VERSION_PARTS) < 0) {
      this.logger?.warn(
        `signal-cli ${version} is older than ${MIN_SIGNAL_CLI_VERSION}, the oldest version this adapter is tested with; update signal-cli`,
        { version, minimum: MIN_SIGNAL_CLI_VERSION },
      );
    }
  }

  /**
   * The Bot Account's own ACI comes from `listAccounts`, the only RPC that
   * returns it without asking the Signal server. signal-cli serves it only on
   * a multi-account daemon (`signal-cli daemon` without `-a`); a
   * single-account daemon answers METHOD_NOT_FOUND.
   */
  private async resolveBotAci(): Promise<string> {
    let accounts: SignalAccount[] | null;
    try {
      accounts = await this.transport.request<SignalAccount[] | null>("listAccounts");
    } catch (error) {
      if (error instanceof AdapterError && error.code === "METHOD_NOT_FOUND") {
        throw new ValidationError(
          ADAPTER_NAME,
          `signal-cli at ${this.transport.endpoint} runs in single-account mode; start the daemon without -a/--account`,
        );
      }
      throw error;
    }
    if (!Array.isArray(accounts) || accounts.some((entry) => typeof entry !== "object" || entry === null)) {
      throw new NetworkError(ADAPTER_NAME, "signal-cli JSON-RPC listAccounts returned a malformed response");
    }
    const self = accounts.find((entry) => entry.number === this.account || entry.aci === this.account);
    if (!isAci(self?.aci)) {
      throw new AuthenticationError(
        ADAPTER_NAME,
        `Bot Account ${this.account} is not registered or linked on the signal-cli daemon at ${this.transport.endpoint}`,
      );
    }
    return self.aci;
  }

  private requireBotAci(): string {
    if (!this._botUserId) {
      throw new ValidationError(ADAPTER_NAME, "The Signal adapter is not initialized; call chat.initialize() first");
    }
    return this._botUserId;
  }

  private handleEvent(event: ReceiveEvent): void {
    const { envelope, exception } = event;
    if (exception) {
      // signal-cli could not decrypt or verify an incoming message, which is then lost. Only the
      // exception type is logged: its message can contain the sender's phone number.
      const type = typeof exception === "object" && "type" in exception ? exception.type : undefined;
      this.logger?.warn("signal-cli could not receive a message", { type: typeof type === "string" ? type : "unknown" });
      return;
    }
    const message = envelope && parseDirectTextMessage(envelope, this.formatConverter, this._botUserId);
    if (!(message && this.chat)) {
      this.logger?.debug("Ignoring Signal envelope outside the supported message types");
      return;
    }
    // Not awaited: one slow handler must not hold up other Conversations, and
    // Chat's concurrency strategies need to see overlapping messages. Chat
    // logs handler failures itself; the catch only prevents an unhandled rejection.
    const task = this.chat.processMessage(this, message.threadId, message).catch(() => {});
    this.inFlight.add(task);
    void task.then(() => this.inFlight.delete(task));
  }
}

const MIN_VERSION_PARTS = MIN_SIGNAL_CLI_VERSION.split(".").map(Number);

function parseVersion(version: string): readonly number[] | undefined {
  return /^(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);
}

function compareVersions(actual: readonly number[], required: readonly number[]): number {
  for (let index = 0; index < required.length; index++) {
    const difference = (actual[index] ?? 0) - (required[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function createSignalAdapter(config?: SignalAdapterConfig): SignalAdapter {
  return new SignalAdapter(config);
}

function createTransport(config: SignalTransportConfig, account: string): SignalTransport {
  switch (config.type) {
    case "http":
      if (typeof config.url !== "string" || config.url === "") {
        throw new ValidationError(ADAPTER_NAME, 'transport.url is required for `{ type: "http" }`.');
      }
      return new HttpTransport(config, account);
    default: {
      // Unreachable for typed callers; JavaScript callers can still pass any `type`.
      const unsupported: never = config.type;
      throw new ValidationError(ADAPTER_NAME, `Unsupported transport type ${JSON.stringify(unsupported)}`);
    }
  }
}
