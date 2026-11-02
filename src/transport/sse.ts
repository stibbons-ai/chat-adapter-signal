export interface ServerSentEvent {
  event: string;
  data: string;
  /**
   * The `id` field of this event, if it is header-safe (see `isHeaderSafeEventId`; signal-cli's
   * IDs always are). Unlike the spec's last event ID it is
   * not carried over to later events: the receive loop treats a repeated ID as a replay.
   */
  id: string | undefined;
}

/** Whether an event ID can be sent back as the `Last-Event-ID` header: visible ASCII only, no space or control characters. */
export function isHeaderSafeEventId(id: string): boolean {
  return /^[\x21-\x7e]+$/.test(id);
}

/**
 * Parses a `text/event-stream` body per the WHATWG SSE spec: fields `event`,
 * `data` (multi-line joined by "\n") and `id` (per event, see
 * `ServerSentEvent.id`), comments ignored, an empty line dispatches. Node 24
 * has no global EventSource without an experimental flag, and custom headers
 * must reach the request, so the stream is read from `fetch` directly.
 */
export async function* parseEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ServerSentEvent> {
  // Per stream, not module-level: the generator suspends at `yield` while another stream may run.
  const lineEnd = /\r\n|\r|\n/g;
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let id: string | undefined;
  // The previous chunk ended in "\r": that ended a line, and a "\n" opening this chunk belongs to it.
  let skipLeadingLineFeed = false;

  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    if (buffer === "") {
      continue;
    }
    let start: number = skipLeadingLineFeed && buffer.startsWith("\n") ? 1 : 0;
    skipLeadingLineFeed = false;
    lineEnd.lastIndex = start;
    let match: RegExpExecArray | null;
    while ((match = lineEnd.exec(buffer)) !== null) {
      const line = buffer.slice(start, match.index);
      start = match.index + match[0].length;
      skipLeadingLineFeed = match[0] === "\r" && start === buffer.length;

      if (line === "") {
        if (data.length > 0) {
          yield { event: event || "message", data: data.join("\n"), id };
        }
        event = "";
        id = undefined;
        data = [];
        continue;
      }
      if (line.startsWith(":")) {
        continue;
      }
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) {
        value = value.slice(1);
      }
      if (field === "data") {
        data.push(value);
      } else if (field === "event") {
        event = value;
      } else if (field === "id") {
        id = isHeaderSafeEventId(value) ? value : undefined;
      }
    }
    buffer = buffer.slice(start);
  }
}
