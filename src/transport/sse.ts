export interface ServerSentEvent {
  id?: string;
  event: string;
  data: string;
}

/**
 * Parses a `text/event-stream` body per the WHATWG SSE spec: fields `id`,
 * `event`, `data` (multi-line joined by "\n"), comments ignored, an empty
 * line dispatches. Node 20 has no global EventSource, and custom headers
 * must reach the request, so the stream is read from `fetch` directly.
 */
export async function* parseEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ServerSentEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | undefined;
  let event = "";
  let data: string[] = [];

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let lineEnd: number;
    while ((lineEnd = buffer.search(/\r\n|\r|\n/)) !== -1) {
      // A trailing "\r" may be the first half of a "\r\n" split across chunks.
      if (lineEnd === buffer.length - 1 && buffer[lineEnd] === "\r") {
        break;
      }
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + (buffer.startsWith("\r\n", lineEnd) ? 2 : 1));

      if (line === "") {
        if (data.length > 0) {
          yield { ...(id === undefined ? {} : { id }), event: event || "message", data: data.join("\n") };
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
      } else if (field === "id" && !value.includes("\0")) {
        id = value;
      }
    }
  }
}
