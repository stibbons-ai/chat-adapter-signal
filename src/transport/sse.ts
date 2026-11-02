export interface ServerSentEvent {
  event: string;
  data: string;
}

/**
 * Parses a `text/event-stream` body per the WHATWG SSE spec: fields `event`
 * and `data` (multi-line joined by "\n"), comments ignored, an empty line
 * dispatches. Node 24 has no global EventSource without an experimental
 * flag, and custom headers must reach the request, so the stream is read
 * from `fetch` directly.
 */
export async function* parseEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ServerSentEvent> {
  // Per stream, not module-level: the generator suspends at `yield` while another stream may run.
  const lineEnd = /\r\n|\r|\n/g;
  let buffer = "";
  let event = "";
  let data: string[] = [];
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
          yield { event: event || "message", data: data.join("\n") };
        }
        event = "";
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
      }
    }
    buffer = buffer.slice(start);
  }
}
