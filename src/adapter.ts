import { AdapterError, AuthenticationError, NetworkError, ResourceNotFoundError, ValidationError } from "@chat-adapter/shared";
import {
  NotImplementedError,
  type Adapter,
  type AdapterPostableMessage,
  type ChatInstance,
  type EmojiValue,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  type Logger,
  type Message,
  type RawMessage,
  ThreadHistoryCache,
  type ThreadInfo,
  type UserInfo,
} from "chat";
import {
  parseTextMessage,
  type ReceiveEvent,
  type SignalRawMessage,
  type SignalSendResult,
} from "./envelope.js";
import { contactDisplayName, findContact, findGroup } from "./directory.js";
import { ADAPTER_NAME, assertTimeoutMs, malformedResponse } from "./errors.js";
import { SignalFormatConverter } from "./format.js";
import { historyPage } from "./history.js";
import { ReceiveLoop, reconnectOptions, type ReconnectOptions } from "./receive-loop.js";
import { HttpTransport, type HttpTransportOptions } from "./transport/http.js";
import { LineTransport, type LineTransportOptions } from "./transport/line.js";
import type { SignalTransport } from "./transport/types.js";
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

/** How the adapter reaches signal-cli, by `type`: HTTP daemon, spawned process, Unix socket, or TCP. */
export type SignalTransportConfig = HttpTransportOptions | LineTransportOptions;

export interface SignalAdapterConfig {
  /** The Bot Account's phone number (or ACI) as registered in signal-cli. Falls back to `SIGNAL_ACCOUNT`. */
  account?: string;
  /** Falls back to `SIGNAL_CLI_URL`, which implies the HTTP transport. */
  transport?: SignalTransportConfig;
  /** Bot display name; defaults to the Chat instance's `userName`. */
  userName?: string;
  /** Defaults to the Chat instance's logger. */
  logger?: Logger;
  /** How long `disconnect()` waits for running message handlers and the final receive-cursor write. Default: 10 000 ms. */
  drainTimeoutMs?: number;
  /** Backoff for reconnecting a dropped event stream; see {@link ReconnectOptions}. */
  reconnect?: ReconnectOptions;
}

/** An entry of `listAccounts`; `listContacts` entries carry the ACI as `uuid` instead. */
interface SignalAccount {
  number?: string | null;
  aci?: string | null;
  uuid?: string | null;
}

export class SignalAdapter implements Adapter<SignalThreadId, SignalRawMessage> {
  readonly name = ADAPTER_NAME;
  /** Signal has no server-side history: Chat records every message in its state adapter instead (`fetchMessages`). */
  readonly persistThreadHistory = true;

  private readonly account: string;
  private readonly transport: SignalTransport;
  private readonly formatConverter = new SignalFormatConverter();
  private readonly explicitUserName: string | undefined;
  private logger: Logger | undefined;
  private chat: ChatInstance | undefined;
  private readonly drainTimeoutMs: number;
  /** Bumped by every `initialize()` and `disconnect()`, so a startup can tell it was cancelled. */
  private generation = 0;
  /** The generation of the latest `initialize()`; `disconnect()` does not bump it. */
  private latestStartup = 0;
  private loop: ReceiveLoop | undefined;
  private readonly reconnect: Required<ReconnectOptions>;
  private _userName: string;
  private _botUserId: string | undefined;
  /** The Bot Account's phone number, if it has one; signal-cli labels its events with it. */
  private botNumber: string | undefined;

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
    const drainTimeoutMs = config.drainTimeoutMs ?? 10_000;
    assertTimeoutMs("drainTimeoutMs", drainTimeoutMs, 0);
    this.drainTimeoutMs = drainTimeoutMs;
    this.reconnect = reconnectOptions(config.reconnect);
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
    // A `disconnect()` during the startup round trips bumps the generation; startup then rejects
    // instead of opening an event stream that nothing would close. Rejecting (not returning)
    // keeps Chat from marking itself initialized, so a later `chat.initialize()` starts afresh.
    const generation = ++this.generation;
    this.latestStartup = generation;
    const throwIfCancelled = () => {
      if (generation !== this.generation) {
        throw new AdapterError("Signal adapter startup was cancelled by disconnect()", ADAPTER_NAME, "STARTUP_CANCELLED");
      }
    };
    this.chat = chat;
    this.logger ??= chat.getLogger(ADAPTER_NAME);
    this._userName = this.explicitUserName ?? chat.getUserName();

    try {
      await this.transport.checkReachable();
      throwIfCancelled();
      await this.checkVersion();
      throwIfCancelled();
      const self = await this.resolveBotAccount();
      this._botUserId = self.aci;
      this.botNumber = self.number;
      throwIfCancelled();
      // Set before starting, so a `disconnect()` during startup stops this loop (aborting its connect).
      const loop = new ReceiveLoop({
        transport: this.transport,
        state: chat.getState(),
        cursorKey: `signal:receive-cursor:${this.account}`,
        logger: this.logger,
        reconnect: this.reconnect,
        dispatch: (event) => this.handleEvent(event),
      });
      this.loop = loop;
      try {
        await loop.start();
      } catch (error) {
        if (generation === this.generation) {
          this.loop = undefined;
        }
        throw error;
      }
      throwIfCancelled();
    } catch (error) {
      // A failed or cancelled startup must not leave a socket open or a spawned signal-cli running,
      // unless a newer initialize() owns the transport by now.
      if (generation === this.latestStartup) {
        await this.transport.close();
      }
      // disconnect() also fails requests still in flight on a line transport; report the cause, not the symptom.
      throwIfCancelled();
      throw error;
    }
  }

  /**
   * Closes the event stream and stops reconnecting (or stops a startup still in
   * progress), then waits for running handlers so their replies, lock releases
   * and receive-cursor writes complete before Chat disconnects its state, then
   * closes the socket or terminates the spawned signal-cli. The wait is bounded
   * by `drainTimeoutMs`: a handler that never settles cannot hold shutdown
   * forever. A handler that itself calls `chat.shutdown()` waits for itself, so
   * that shutdown always takes the full `drainTimeoutMs`.
   */
  async disconnect(): Promise<void> {
    this.generation++;
    const loop = this.loop;
    this.loop = undefined;
    if (loop) {
      await loop.stop();
      const pending = await loop.drain(this.drainTimeoutMs);
      if (pending > 0) {
        this.logger?.warn(`Stopped waiting for ${pending} Signal message handler(s) after ${this.drainTimeoutMs} ms`);
      }
    }
    // After the drain: running handlers reply through the transport. ponytail: a handler that
    // outlives drainTimeoutMs and sends afterwards reopens the transport; nothing closes that one.
    await this.transport.close();
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

  /** DM: the user's ACI and the name Signal shows for them. Group: its name, description and member ACIs. */
  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const conversation = decodeThreadId(threadId);
    if (conversation.type === "dm") {
      const contact = await findContact(this.transport, this.account, conversation.aci);
      return {
        id: threadId,
        channelId: threadId,
        isDM: true,
        channelName: contact ? contactDisplayName(contact) : conversation.aci,
        metadata: { aci: conversation.aci },
      };
    }
    const group = await findGroup(this.transport, this.account, conversation.groupId);
    if (!group) {
      throw new ResourceNotFoundError(ADAPTER_NAME, "group", conversation.groupId);
    }
    return {
      id: threadId,
      channelId: threadId,
      isDM: false,
      ...(group.name ? { channelName: group.name } : {}),
      metadata: {
        groupId: conversation.groupId,
        description: group.description ?? undefined,
        members: (group.members ?? []).flatMap((member) => (isAci(member?.uuid) ? [member.uuid] : [])),
      },
    };
  }

  /** Looks a user up by ACI; `userName` is the ACI, as on message authors. `null` when signal-cli knows no such user. */
  async getUser(userId: string): Promise<UserInfo | null> {
    const aci = normalizeAci(userId);
    if (!aci) {
      throw new ValidationError(ADAPTER_NAME, `Invalid Signal user ID ${JSON.stringify(userId)}; expected an ACI`);
    }
    const contact = await findContact(this.transport, this.account, aci);
    if (contact?.uuid !== aci) {
      return null;
    }
    return { userId: aci, userName: aci, fullName: contactDisplayName(contact), isBot: aci === this._botUserId };
  }

  /**
   * The 1:1 Conversation with a user given by ACI, phone number, or `u:<username>`.
   * An ACI needs no lookup; signal-cli resolves the others, asking the Signal server
   * for ones it has not seen. A number whose owner hides it from lookup has no ACI to find.
   */
  async openDM(userId: string): Promise<string> {
    const aci = normalizeAci(userId) ?? (await findContact(this.transport, this.account, userId))?.uuid;
    if (!aci) {
      throw new ResourceNotFoundError(ADAPTER_NAME, "user", userId);
    }
    return encodeThreadId({ type: "dm", aci });
  }

  parseMessage(raw: SignalRawMessage): Message<SignalRawMessage> {
    const message = "sourceUuid" in raw ? parseTextMessage(raw, this.formatConverter, this._botUserId) : null;
    if (!message) {
      throw new ValidationError(ADAPTER_NAME, "Only 1:1 and Groups v2 text envelopes can be parsed into messages");
    }
    return message;
  }

  renderFormatted(content: FormattedContent): string {
    return this.formatConverter.fromAst(content);
  }

  async postMessage(threadId: string, message: AdapterPostableMessage): Promise<RawMessage<SignalRawMessage>> {
    const conversation = decodeThreadId(threadId);
    const botAci = this.requireBotAci();
    const result = await this.transport.request<SignalSendResult | null>("send", {
      account: this.account,
      ...(conversation.type === "dm" ? { recipient: [conversation.aci] } : { groupId: conversation.groupId }),
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

  /**
   * The history Chat recorded for this Conversation (`persistThreadHistory`): messages
   * received and posted through Chat since the bot started, up to Chat's
   * `history.thread` limits (default 100 messages, 7 days); `raw` is `null` on them.
   */
  async fetchMessages(threadId: string, options: FetchOptions = {}): Promise<FetchResult<SignalRawMessage>> {
    decodeThreadId(threadId);
    if (!this.chat) {
      throw new ValidationError(ADAPTER_NAME, "The Signal adapter is not initialized; call chat.initialize() first");
    }
    const history = new ThreadHistoryCache(this.chat.getState());
    // Chat stores every message of this thread ID, all from this adapter; it nulls their `raw`.
    const messages = (await history.getMessages(threadId)) as Message<SignalRawMessage>[];
    return historyPage(messages, options);
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
   * The Bot Account's own ACI and number, read from signal-cli's local store
   * without asking the Signal server. A multi-account daemon serves
   * `listAccounts`; a single-account one (`-a`, always so for the spawn
   * transport) answers METHOD_NOT_FOUND, and then the account's own entry in
   * `listContacts` has them (signal-cli 0.14.9 refreshes that one profile and
   * ignores a failed refresh).
   */
  private async resolveBotAccount(): Promise<{ aci: string; number: string | undefined }> {
    let method = "listAccounts";
    let accounts: SignalAccount[] | null;
    try {
      accounts = await this.transport.request<SignalAccount[] | null>(method);
    } catch (error) {
      if (!(error instanceof AdapterError && error.code === "METHOD_NOT_FOUND")) {
        throw error;
      }
      method = "listContacts";
      accounts = await this.transport.request<SignalAccount[] | null>(method, {
        recipient: [this.account],
        allRecipients: true,
      });
    }
    if (!Array.isArray(accounts) || accounts.some((entry) => typeof entry !== "object" || entry === null)) {
      throw malformedResponse(method);
    }
    const found = accounts.find((entry) => entry.number === this.account || (entry.aci ?? entry.uuid) === this.account);
    const self = found && { aci: found.aci ?? found.uuid, number: found.number ?? undefined };
    if (!isAci(self?.aci)) {
      throw new AuthenticationError(
        ADAPTER_NAME,
        `Bot Account ${this.account} is not registered or linked on the signal-cli daemon at ${this.transport.endpoint}`,
      );
    }
    return { aci: self.aci, number: self.number };
  }

  private requireBotAci(): string {
    if (!this._botUserId) {
      throw new ValidationError(ADAPTER_NAME, "The Signal adapter is not initialized; call chat.initialize() first");
    }
    return this._botUserId;
  }

  /** Settles once `processMessage` for the message completes, or at once when the event is ignored. */
  private async handleEvent(event: ReceiveEvent): Promise<void> {
    const { account, envelope, exception } = event;
    // A multi-account daemon pushes every account's events over a socket or TCP connection.
    if (account !== undefined && account !== this.botNumber && account !== this._botUserId) {
      return;
    }
    if (exception) {
      // signal-cli could not decrypt or verify an incoming message, which is then lost. Only the
      // exception type and the sender's ACI are logged: the message can contain a phone number.
      const type = typeof exception === "object" && "type" in exception ? exception.type : undefined;
      const sender = envelope?.sourceUuid;
      this.logger?.warn("signal-cli could not receive a message", {
        type: typeof type === "string" ? type : "unknown",
        ...(isAci(sender) ? { sender } : {}),
      });
      return;
    }
    const message = envelope && parseTextMessage(envelope, this.formatConverter, this._botUserId);
    if (!(message && this.chat)) {
      this.logger?.debug("Ignoring Signal envelope outside the supported message types");
      return;
    }
    // The receive loop does not wait for this before the next event: one slow handler must not
    // hold up other Conversations, and Chat's concurrency strategies need to see overlapping
    // messages. Chat logs handler failures itself; the catch keeps them from being logged twice.
    // A failed handler still advances the receive cursor: replaying it would hit Chat's dedupe,
    // and retrying it forever would block the cursor.
    await this.chat.processMessage(this, message.threadId, message).catch(() => {});
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
    case "spawn":
    case "socket":
    case "tcp":
      return new LineTransport(config, account);
    default: {
      // Unreachable for typed callers; JavaScript callers can still pass any `type`.
      const unsupported: never = config;
      throw new ValidationError(ADAPTER_NAME, `Unsupported transport type ${JSON.stringify((unsupported as { type?: unknown }).type)}`);
    }
  }
}
