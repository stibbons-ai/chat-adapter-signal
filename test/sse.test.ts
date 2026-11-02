import { expect, it } from "vitest";
import { parseEventStream, type ServerSentEvent } from "../src/transport/sse.js";

async function parse(...chunks: string[]): Promise<ServerSentEvent[]> {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
  const events: ServerSentEvent[] = [];
  for await (const event of parseEventStream(body)) {
    events.push(event);
  }
  return events;
}

it("reports an event's own id, split across chunks and with CRLF line ends", async () => {
  expect(await parse("id:17", "-3\r\nevent:receive\r\ndata:x\r\n\r\n")).toEqual([{ id: "17-3", event: "receive", data: "x" }]);
});

it("does not carry an id over to the next event", async () => {
  expect(await parse("id:1-1\ndata:a\n\ndata:b\n\n")).toEqual([
    { id: "1-1", event: "message", data: "a" },
    { id: undefined, event: "message", data: "b" },
  ]);
});

it("keeps visible-ASCII ids up to both ends of the range", async () => {
  expect((await parse("id:!a~\ndata:1\n\n")).map((event) => event.id)).toEqual(["!a~"]);
});

it("ignores ids that could not be sent back as a Last-Event-ID header", async () => {
  const ids = (await parse("id:a\0b\ndata:1\n\nid:\ndata:2\n\nid:1-€\ndata:3\n\nid:1 2\ndata:4\n\n")).map((event) => event.id);
  expect(ids).toEqual([undefined, undefined, undefined, undefined]);
});

it("drops the id of a block without data", async () => {
  expect(await parse("id:9-9\n\ndata:x\n\n")).toEqual([{ id: undefined, event: "message", data: "x" }]);
});
