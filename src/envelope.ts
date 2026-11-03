import { defaultEmojiResolver, Message, type Author, type ReactionEvent } from "chat";
import { parseAttachments, type SignalAttachment } from "./attachments.js";
import { isSignalStyle, type SignalFormatConverter, type SignalMention, type SignalStyleRange } from "./format.js";
import { encodeMessageId, encodeThreadId, isAci, isGroupId, isMessageTimestamp } from "./thread-id.js";

/**
 * The subset of signal-cli's receive envelope (`JsonMessageEnvelope` in
 * signal-cli 0.14.9) this adapter reads. Phone number and profile name are
 * display data only; users are keyed by `sourceUuid`, their ACI (ADR-0002).
 */
export interface SignalEnvelope {
  sourceUuid?: string | null;
  sourceNumber?: string | null;
  sourceName?: string | null;
  timestamp: number;
  dataMessage?: {
    timestamp: number;
    /** `null` for a message without text, e.g. attachments only. */
    message?: string | null;
    /** Present for group messages; `groupId` is standard base64 (16 bytes for legacy groups, 32 for Groups v2). */
    groupInfo?: { groupId?: unknown } | null;
    /** Native @mentions; `uuid` is the mentioned user's ACI, `start`/`length` its placeholder in `message` (UTF-16). */
    mentions?: Array<{ uuid?: unknown; start?: unknown; length?: unknown } | null> | null;
    /** Styled ranges of `message`, offsets in UTF-16 code units. */
    textStyles?: Array<{ style?: unknown; start?: unknown; length?: unknown } | null> | null;
    /** The message this one quote-replies to; `authorUuid` is its author's ACI. */
    quote?: { authorUuid?: unknown } | null;
    /** Files sent with the message, already downloaded into signal-cli's attachment store. */
    attachments?: Array<SignalAttachment | null> | null;
    /** A view-once message; the adapter ignores these (out of scope). */
    viewOnce?: unknown;
    /** A reaction to the message `targetAuthorUuid` sent at `targetSentTimestamp`; `message` is then null. */
    reaction?: { emoji?: unknown; targetAuthorUuid?: unknown; targetSentTimestamp?: unknown; isRemove?: unknown } | null;
    remoteDelete?: unknown;
    storyContext?: unknown;
  };
}

/** A receive notification from signal-cli for the Bot Account. */
export interface ReceiveEvent {
  /** The receiving account as signal-cli names it: its number, or its ACI when it has none. */
  account?: string;
  envelope?: SignalEnvelope;
  exception?: unknown;
}

/** signal-cli's `send` result. */
export interface SignalSendResult {
  timestamp: number;
  results?: unknown[];
}

export type SignalRawMessage = SignalEnvelope | SignalSendResult;

/**
 * Maps a 1:1 or Groups v2 message with text or attachments to a Chat SDK
 * message. Everything else (sync messages, edits, reactions, deletes,
 * receipts, typing, story replies, view-once messages, legacy groups) maps to
 * `null` (reactions: see `parseReaction`). Once the Bot Account's ACI is known,
 * group messages carry a definite `isMention`: true only for a native @mention
 * of the Bot Account or a quote-reply to one of its messages, never for its
 * name as plain text. Text styles become markdown; a native @mention reads
 * `@<userName>` for the Bot Account and `@<ACI>` for anyone else. Attachments
 * carry `fetchMetadata` but no `fetchData`; the adapter adds it.
 */
export function parseTextMessage(
  envelope: SignalEnvelope,
  formatConverter: SignalFormatConverter,
  bot: { aci: string | undefined; userName: string },
): Message<SignalRawMessage> | null {
  const botAci = bot.aci;
  const data = envelope.dataMessage;
  const aci = envelope.sourceUuid;
  if (
    !isAci(aci) ||
    !data ||
    !isMessageTimestamp(data.timestamp) ||
    data.reaction ||
    data.remoteDelete ||
    data.storyContext ||
    data.viewOnce
  ) {
    return null;
  }

  const threadId = conversationOf(data, aci);
  if (!threadId) {
    return null;
  }
  const attachments = parseAttachments(data.attachments, threadId);
  const body = typeof data.message === "string" ? data.message : attachments.length > 0 ? "" : null;
  if (body === null) {
    return null;
  }
  // Before the Bot Account's ACI is known (parseMessage before initialize), a Mention can't be decided.
  const isMention =
    data.groupInfo && botAci !== undefined
      ? (Array.isArray(data.mentions) && data.mentions.some((mention) => mention?.uuid === botAci)) ||
        data.quote?.authorUuid === botAci
      : undefined;

  const mentions: SignalMention[] = [];
  for (const mention of Array.isArray(data.mentions) ? data.mentions : []) {
    if (isAci(mention?.uuid) && isOffset(mention.start) && isOffset(mention.length)) {
      mentions.push({
        start: mention.start,
        length: mention.length,
        replacement: `@${mention.uuid === botAci ? bot.userName : mention.uuid}`,
      });
    }
  }
  const styles: SignalStyleRange[] = [];
  for (const range of Array.isArray(data.textStyles) ? data.textStyles : []) {
    if (isSignalStyle(range?.style) && isOffset(range.start) && isOffset(range.length)) {
      styles.push({ style: range.style, start: range.start, length: range.length });
    }
  }
  const { text, ast } = formatConverter.parseSignal(body, styles, mentions);

  return new Message<SignalRawMessage>({
    id: encodeMessageId(aci, data.timestamp),
    threadId,
    text,
    formatted: ast,
    raw: envelope,
    author: authorOf(envelope, aci, botAci),
    metadata: { dateSent: new Date(data.timestamp), edited: false },
    attachments,
    ...(isMention === undefined ? {} : { isMention }),
  });
}

function isOffset(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** A reaction as `Chat.processReaction` takes it, without the adapter (the adapter adds itself) and the thread (Chat creates it). */
export type SignalReaction = Omit<ReactionEvent<SignalRawMessage>, "adapter" | "thread">;

/**
 * Maps a 1:1 or Groups v2 reaction envelope to a reaction event on the
 * message it targets, or to `null` (story reactions, legacy groups, malformed
 * reactions).
 */
export function parseReaction(envelope: SignalEnvelope, botAci: string | undefined): SignalReaction | null {
  const data = envelope.dataMessage;
  const reaction = data?.reaction;
  const aci = envelope.sourceUuid;
  if (
    !isAci(aci) ||
    !data ||
    !reaction ||
    data.storyContext ||
    typeof reaction.emoji !== "string" ||
    !reaction.emoji ||
    !isAci(reaction.targetAuthorUuid) ||
    !isMessageTimestamp(reaction.targetSentTimestamp) ||
    typeof reaction.isRemove !== "boolean"
  ) {
    return null;
  }
  const threadId = conversationOf(data, aci);
  if (!threadId) {
    return null;
  }
  return {
    threadId,
    messageId: encodeMessageId(reaction.targetAuthorUuid, reaction.targetSentTimestamp),
    emoji: defaultEmojiResolver.fromGChat(reaction.emoji),
    rawEmoji: reaction.emoji,
    added: !reaction.isRemove,
    user: authorOf(envelope, aci, botAci),
    raw: envelope,
  };
}

/** The Conversation of a 1:1 or Groups v2 data message; `null` for a legacy or malformed group. */
function conversationOf(data: NonNullable<SignalEnvelope["dataMessage"]>, senderAci: string): string | null {
  if (!data.groupInfo) {
    return encodeThreadId({ type: "dm", aci: senderAci });
  }
  const groupId = data.groupInfo.groupId;
  return isGroupId(groupId) ? encodeThreadId({ type: "group", groupId }) : null;
}

/** Keyed by ACI; profile name, else phone number, only as display name (ADR-0002). */
function authorOf(envelope: SignalEnvelope, aci: string, botAci: string | undefined): Author {
  return {
    userId: aci,
    userName: aci,
    fullName: envelope.sourceName || envelope.sourceNumber || aci,
    isBot: "unknown",
    isMe: aci === botAci,
  };
}
