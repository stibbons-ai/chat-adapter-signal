import { ValidationError } from "@chat-adapter/shared";

export const ADAPTER_NAME = "signal";

/**
 * A Signal Conversation as the Chat SDK addresses it. A Conversation is both
 * Thread and Channel, so one ID serves as both (ADR-0002).
 */
export type SignalThreadId = { type: "dm"; aci: string };

const ACI_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DM_PREFIX = `${ADAPTER_NAME}:dm:`;

/** signal-cli prints ACIs in canonical lowercase UUID form; only that form is accepted, so every user has exactly one ID. */
export function isAci(value: unknown): value is string {
  return typeof value === "string" && ACI_PATTERN.test(value);
}

export function encodeThreadId(data: SignalThreadId): string {
  if (data?.type !== "dm" || !isAci(data.aci)) {
    throw new ValidationError(ADAPTER_NAME, `Cannot encode Signal thread ID from ${JSON.stringify(data)}`);
  }
  return DM_PREFIX + data.aci;
}

export function decodeThreadId(threadId: string): SignalThreadId {
  if (typeof threadId === "string" && threadId.startsWith(DM_PREFIX)) {
    const aci = threadId.slice(DM_PREFIX.length);
    if (isAci(aci)) {
      return { type: "dm", aci };
    }
  }
  throw new ValidationError(
    ADAPTER_NAME,
    `Invalid Signal thread ID ${JSON.stringify(threadId)}; expected "signal:dm:<ACI>"`,
  );
}

export function encodeMessageId(authorAci: string, timestamp: number): string {
  return `${authorAci}:${timestamp}`;
}
