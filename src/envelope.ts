import { Message } from "chat";
import type { SignalFormatConverter } from "./format.js";
import { encodeMessageId, encodeThreadId, isAci } from "./thread-id.js";

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
    groupInfo?: unknown;
    reaction?: unknown;
    remoteDelete?: unknown;
    storyContext?: unknown;
  };
  editMessage?: unknown;
  syncMessage?: unknown;
  receiptMessage?: unknown;
  typingMessage?: unknown;
}

/** signal-cli's `send` result. */
export interface SignalSendResult {
  timestamp: number;
  results?: unknown[];
}

export type SignalRawMessage = SignalEnvelope | SignalSendResult;

/**
 * Maps a 1:1 text envelope to a Chat SDK message. Everything else (groups,
 * sync, edits, reactions, deletes, receipts, typing, story replies) maps to
 * `null` and is ignored.
 */
export function parseDirectTextMessage(
  envelope: SignalEnvelope,
  formatConverter: SignalFormatConverter,
  botAci: string | undefined,
): Message<SignalRawMessage> | null {
  const data = envelope.dataMessage;
  const aci = envelope.sourceUuid;
  if (
    !isAci(aci) ||
    !data ||
    typeof data.message !== "string" ||
    data.groupInfo ||
    data.reaction ||
    data.remoteDelete ||
    data.storyContext
  ) {
    return null;
  }

  const displayName = envelope.sourceName || envelope.sourceNumber || aci;
  return new Message<SignalRawMessage>({
    id: encodeMessageId(aci, data.timestamp),
    threadId: encodeThreadId({ type: "dm", aci }),
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
  });
}
