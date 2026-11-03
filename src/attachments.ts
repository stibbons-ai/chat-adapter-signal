import { MIMEType } from "node:util";
import { extractFiles, extractPostableAttachments, ValidationError } from "@chat-adapter/shared";
import type { AdapterPostableMessage, Attachment } from "chat";
import { ADAPTER_NAME, malformedResponse } from "./errors.js";
import type { SignalTransport } from "./transport/types.js";
import { decodeThreadId } from "./thread-id.js";

/** An entry of a receive envelope's `dataMessage.attachments` (`JsonAttachment` in signal-cli 0.14.9). */
export interface SignalAttachment {
  contentType?: unknown;
  filename?: unknown;
  /** Name of the downloaded file in signal-cli's attachment store; what `getAttachment` takes as `id`. */
  id?: unknown;
  size?: unknown;
  width?: unknown;
  height?: unknown;
}

/** A received attachment's `fetchMetadata`: its ID in signal-cli and the Conversation it arrived in. */
type AttachmentLocator = { id: string; threadId: string };

const DEFAULT_MIME_TYPE = "application/octet-stream";

/** Whether an outgoing message carries files or attachments. */
export function hasAttachments(message: AdapterPostableMessage): boolean {
  return extractFiles(message).length > 0 || extractPostableAttachments(message).length > 0;
}

/**
 * The files and attachments of an outgoing message as RFC 2397 data URIs, the
 * form signal-cli's `send` takes them in from a remote Host App:
 * `data:<mime>;filename=<name>;base64,<data>`. signal-cli fetches no URLs, so
 * an attachment needs its `data`.
 */
export async function outboundAttachments(message: AdapterPostableMessage): Promise<string[]> {
  const uploads = [
    ...extractFiles(message).map((file) => ({ data: file.data, name: file.filename, mimeType: file.mimeType })),
    ...extractPostableAttachments(message).map((attachment) => {
      if (attachment.data === undefined) {
        throw new ValidationError(ADAPTER_NAME, "A Signal attachment needs `data`; signal-cli cannot fetch a URL");
      }
      return { data: attachment.data, name: attachment.name, mimeType: attachment.mimeType };
    }),
  ];
  return Promise.all(uploads.map(async ({ data, name, mimeType }) => dataUri(await bytesOf(data), mimeType, name)));
}

async function bytesOf(data: Buffer | Blob | ArrayBuffer): Promise<Buffer> {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (data instanceof Blob) {
    return Buffer.from(await data.arrayBuffer());
  }
  throw new ValidationError(ADAPTER_NAME, "A Signal attachment's data must be a Buffer, Blob or ArrayBuffer");
}

function dataUri(data: Buffer, mimeType: string | undefined, name: string | undefined): string {
  // signal-cli reads `data:…;base64,` with nothing after it as a file path instead.
  if (data.length === 0) {
    throw new ValidationError(ADAPTER_NAME, `Signal cannot send the empty attachment ${JSON.stringify(name ?? "")}`);
  }
  // Only the essence: signal-cli's data URI pattern takes a single parameter, the filename.
  let type: string;
  try {
    type = new MIMEType(mimeType || DEFAULT_MIME_TYPE).essence;
  } catch {
    throw new ValidationError(ADAPTER_NAME, `Invalid MIME type ${JSON.stringify(mimeType)} for a Signal attachment`);
  }
  // signal-cli URL-decodes the value; an empty one would not match its pattern. Lone surrogates become U+FFFD,
  // which encodeURIComponent would reject.
  const filename = name ? `;filename=${encodeURIComponent(name.replace(/\p{Cs}/gu, "\uFFFD"))}` : "";
  return `data:${type}${filename};base64,${data.toString("base64")}`;
}

/**
 * The attachments of a data message received in Conversation `threadId`,
 * without content: `withFetchData` (the adapter's `rehydrateAttachment`) adds
 * `fetchData`, which asks signal-cli for it, so it works with
 * signal-cli on another host. Entries without an ID (nothing signal-cli could
 * return) are left out.
 */
export function parseAttachments(attachments: unknown, threadId: string): Attachment[] {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments.flatMap((entry: SignalAttachment | null) => {
    if (typeof entry?.id !== "string" || !entry.id) {
      return [];
    }
    const mimeType = typeof entry.contentType === "string" && entry.contentType ? entry.contentType : undefined;
    const fetchMetadata: AttachmentLocator = { id: entry.id, threadId };
    return [
      {
        type: attachmentType(mimeType),
        ...(typeof entry.filename === "string" && entry.filename ? { name: entry.filename } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(isCount(entry.size) ? { size: entry.size } : {}),
        ...(isCount(entry.width) && entry.width > 0 ? { width: entry.width } : {}),
        ...(isCount(entry.height) && entry.height > 0 ? { height: entry.height } : {}),
        fetchMetadata,
      },
    ];
  });
}

function attachmentType(mimeType: string | undefined): Attachment["type"] {
  const kind = mimeType?.split("/", 1)[0]?.toLowerCase();
  return kind === "image" || kind === "video" || kind === "audio" ? kind : "file";
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * The attachment with `fetchData` rebuilt from its `fetchMetadata`, or unchanged when this adapter did not parse it.
 * `fetchData` asks signal-cli's `getAttachment` for the content (base64), never reads a local file.
 */
export function withFetchData(attachment: Attachment, transport: SignalTransport, account: string): Attachment {
  const id = attachment.fetchMetadata?.id;
  const threadId = attachment.fetchMetadata?.threadId;
  if (typeof id !== "string" || !id || typeof threadId !== "string") {
    return attachment;
  }
  return { ...attachment, fetchData: () => fetchAttachment(transport, account, { id, threadId }) };
}

/** signal-cli wants the sender of a 1:1 message or the Group. */
async function fetchAttachment(transport: SignalTransport, account: string, { id, threadId }: AttachmentLocator): Promise<Buffer> {
  const conversation = decodeThreadId(threadId);
  const result = await transport.request<{ data?: unknown } | null>("getAttachment", {
    account,
    id,
    ...(conversation.type === "dm" ? { recipient: conversation.aci } : { groupId: conversation.groupId }),
  });
  if (typeof result?.data !== "string") {
    throw malformedResponse("getAttachment");
  }
  return Buffer.from(result.data, "base64");
}
