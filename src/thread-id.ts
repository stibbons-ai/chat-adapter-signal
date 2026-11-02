import { ValidationError } from "@chat-adapter/shared";
import { ADAPTER_NAME } from "./errors.js";

/**
 * A Signal Conversation as the Chat SDK addresses it. A Conversation is both
 * Thread and Channel, so one ID serves as both (ADR-0002). `groupId` is a
 * Groups v2 ID in standard base64, the form signal-cli prints and accepts.
 */
export type SignalThreadId = { type: "dm"; aci: string } | { type: "group"; groupId: string };

const ACI_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DM_PREFIX = `${ADAPTER_NAME}:dm:`;
const GROUP_PREFIX = `${ADAPTER_NAME}:group:`;
/** Groups v2 IDs are 32 bytes; legacy (v1) groups have 16-byte IDs and are not supported. */
const GROUP_ID_BYTES = 32;

/** signal-cli prints ACIs in canonical lowercase UUID form; only that form is accepted, so every user has exactly one ID. */
export function isAci(value: unknown): value is string {
  return typeof value === "string" && ACI_PATTERN.test(value);
}

/** The canonical ACI for a UUID in any case, with or without dashes (as signal-cli accepts it); `undefined` otherwise. */
export function normalizeAci(value: string): string | undefined {
  if (!/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(value)) {
    return undefined;
  }
  const hex = value.replaceAll("-", "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** True for a Groups v2 ID in canonical standard base64, as signal-cli prints it. */
export function isGroupId(value: unknown): value is string {
  return typeof value === "string" && groupIdBytes(value, "base64") !== undefined;
}

/**
 * The group ID's bytes when `value` is exactly their canonical encoding and they
 * form a Groups v2 ID, so every Group has exactly one thread ID.
 */
function groupIdBytes(value: string, encoding: "base64" | "base64url"): Buffer | undefined {
  const bytes = Buffer.from(value, encoding);
  return bytes.length === GROUP_ID_BYTES && bytes.toString(encoding) === value ? bytes : undefined;
}

export function encodeThreadId(data: SignalThreadId): string {
  if (data?.type === "dm" && isAci(data.aci)) {
    return DM_PREFIX + data.aci;
  }
  const groupBytes = data?.type === "group" && typeof data.groupId === "string" ? groupIdBytes(data.groupId, "base64") : undefined;
  if (groupBytes) {
    return GROUP_PREFIX + groupBytes.toString("base64url");
  }
  throw new ValidationError(ADAPTER_NAME, `Cannot encode Signal thread ID from ${JSON.stringify(data)}`);
}

export function decodeThreadId(threadId: string): SignalThreadId {
  if (typeof threadId === "string" && threadId.startsWith(DM_PREFIX)) {
    const aci = threadId.slice(DM_PREFIX.length);
    if (isAci(aci)) {
      return { type: "dm", aci };
    }
  } else if (typeof threadId === "string" && threadId.startsWith(GROUP_PREFIX)) {
    const bytes = groupIdBytes(threadId.slice(GROUP_PREFIX.length), "base64url");
    if (bytes) {
      return { type: "group", groupId: bytes.toString("base64") };
    }
  }
  throw new ValidationError(
    ADAPTER_NAME,
    `Invalid Signal thread ID ${JSON.stringify(threadId)}; expected "signal:dm:<ACI>" or "signal:group:<base64url group ID>"`,
  );
}

export function encodeMessageId(authorAci: string, timestamp: number): string {
  return `${authorAci}:${timestamp}`;
}
