import { defaultEmojiResolver, Message, type Author, type ReactionEvent } from "chat";
import type { SignalFormatConverter } from "./format.js";
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
    message?: string | null;
    /** Present for group messages; `groupId` is standard base64 (16 bytes for legacy groups, 32 for Groups v2). */
    groupInfo?: { groupId?: unknown } | null;
    /** Native @mentions; `uuid` is the mentioned user's ACI. */
    mentions?: Array<{ uuid?: unknown } | null> | null;
    /** The message this one quote-replies to; `authorUuid` is its author's ACI. */
    quote?: { authorUuid?: unknown } | null;
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
 * Maps a 1:1 or Groups v2 text envelope to a Chat SDK message. Everything else
 * (sync messages, edits, reactions, deletes, receipts, typing, story replies,
 * legacy groups) maps to `null` (reactions: see `parseReaction`). Once `botAci`
 * is known, group messages carry a definite `isMention`: true only for a native
 * @mention of the Bot Account or a quote-reply to one of its messages, never for
 * its name as plain text.
 */
export function parseTextMessage(
  envelope: SignalEnvelope,
  formatConverter: SignalFormatConverter,
  botAci: string | undefined,
): Message<SignalRawMessage> | null {
  const data = envelope.dataMessage;
  const aci = envelope.sourceUuid;
  if (
    !isAci(aci) ||
    !data ||
    !isMessageTimestamp(data.timestamp) ||
    typeof data.message !== "string" ||
    data.reaction ||
    data.remoteDelete ||
    data.storyContext
  ) {
    return null;
  }

  const threadId = conversationOf(data, aci);
  if (!threadId) {
    return null;
  }
  // Before the Bot Account's ACI is known (parseMessage before initialize), a Mention can't be decided.
  const isMention =
    data.groupInfo && botAci !== undefined
      ? (Array.isArray(data.mentions) && data.mentions.some((mention) => mention?.uuid === botAci)) ||
        data.quote?.authorUuid === botAci
      : undefined;

  return new Message<SignalRawMessage>({
    id: encodeMessageId(aci, data.timestamp),
    threadId,
    text: data.message,
    formatted: formatConverter.toAst(data.message),
    raw: envelope,
    author: authorOf(envelope, aci, botAci),
    metadata: { dateSent: new Date(data.timestamp), edited: false },
    attachments: [],
    ...(isMention === undefined ? {} : { isMention }),
  });
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
