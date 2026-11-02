import { Message } from "chat";
import type { SignalFormatConverter } from "./format.js";
import { encodeMessageId, encodeThreadId, isAci, isGroupId } from "./thread-id.js";

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
    reaction?: unknown;
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
 * legacy groups) maps to `null` and is ignored. Once `botAci` is known, group
 * messages carry a definite `isMention`: true only for a native @mention of the
 * Bot Account or a quote-reply to one of its messages, never for its name as
 * plain text.
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
    !Number.isSafeInteger(data.timestamp) ||
    typeof data.message !== "string" ||
    data.reaction ||
    data.remoteDelete ||
    data.storyContext
  ) {
    return null;
  }

  let threadId: string;
  let isMention: boolean | undefined;
  if (data.groupInfo) {
    const groupId = data.groupInfo.groupId;
    if (!isGroupId(groupId)) {
      return null;
    }
    threadId = encodeThreadId({ type: "group", groupId });
    // Before the Bot Account's ACI is known (parseMessage before initialize), a Mention can't be decided.
    if (botAci !== undefined) {
      isMention =
        (Array.isArray(data.mentions) && data.mentions.some((mention) => mention?.uuid === botAci)) ||
        data.quote?.authorUuid === botAci;
    }
  } else {
    threadId = encodeThreadId({ type: "dm", aci });
  }

  const displayName = envelope.sourceName || envelope.sourceNumber || aci;
  return new Message<SignalRawMessage>({
    id: encodeMessageId(aci, data.timestamp),
    threadId,
    text: data.message,
    formatted: formatConverter.toAst(data.message),
    raw: envelope,
    author: {
      userId: aci,
      userName: aci,
      fullName: displayName,
      isBot: "unknown",
      isMe: aci === botAci,
    },
    metadata: { dateSent: new Date(data.timestamp), edited: false },
    attachments: [],
    ...(isMention === undefined ? {} : { isMention }),
  });
}
