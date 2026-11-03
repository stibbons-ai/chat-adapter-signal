import { Message } from "chat";
import { isSignalStyle, type SignalFormatConverter, type SignalMention, type SignalStyleRange } from "./format.js";
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
    /** Native @mentions; `uuid` is the mentioned user's ACI, `start`/`length` its placeholder in `message` (UTF-16). */
    mentions?: Array<{ uuid?: unknown; start?: unknown; length?: unknown } | null> | null;
    /** Styled ranges of `message`, offsets in UTF-16 code units. */
    textStyles?: Array<{ style?: unknown; start?: unknown; length?: unknown } | null> | null;
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
 * legacy groups) maps to `null` and is ignored. Once the Bot Account's ACI is
 * known, group messages carry a definite `isMention`: true only for a native
 * @mention of the Bot Account or a quote-reply to one of its messages, never
 * for its name as plain text. Text styles become markdown; a native @mention
 * reads `@<userName>` for the Bot Account and `@<ACI>` for anyone else.
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
  const { text, ast } = formatConverter.parseSignal(data.message, styles, mentions);

  const displayName = envelope.sourceName || envelope.sourceNumber || aci;
  return new Message<SignalRawMessage>({
    id: encodeMessageId(aci, data.timestamp),
    threadId,
    text,
    formatted: ast,
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

function isOffset(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
