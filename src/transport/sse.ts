export interface ServerSentEvent {
  event: string;
  data: string;
}

/**
 * Parses a `text/event-stream` body per the WHATWG SSE spec: fields `event`
 * and `data` (multi-line joined by "\n"), comments ignored, an empty line
 * dispatches. Node 20 has no global EventSource, and custom headers must
 * reach the request, so the stream is read from `fetch` directly.
 */
export async function* parseEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ServerSentEvent> {
  // Per stream, not module-level: the generator suspends at `yield` while another stream may run.
  const lineEnd = /\r\n|\r|\n/g;
  let buffer = "";
  let event = "";
  let data: string[] = [];

  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let start = 0;
    lineEnd.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = lineEnd.exec(buffer)) !== null) {
      // A trailing "\r" may be the first half of a "\r\n" split across chunks.
      if (match[0] === "\r" && match.index === buffer.length - 1) {
        break;
      }
      const line = buffer.slice(start, match.index);
      start = match.index + match[0].length;

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
