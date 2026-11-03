import { ResourceNotFoundError, ValidationError } from "@chat-adapter/shared";
import type { Attachment, Message, Thread } from "chat";
import { afterEach, describe, expect, it } from "vitest";
import { ALICE_ACI, attachmentEnvelope, BOT_ACCOUNT, BOT_ACI, directTextEnvelope } from "./fake-signal-cli.js";
import { startBot, type Bot } from "./helpers.js";

const ALICE_DM = `signal:dm:${ALICE_ACI}`;
/** A Groups v2 ID (32 bytes) whose standard base64 contains `+` and `/`. */
const GROUP_ID = "+Pn6+/z9/v/4+fr7/P3+//j5+vv8/f7/+Pn6+/z9/v8=";
const GROUP_THREAD = "signal:group:-Pn6-_z9_v_4-fr7_P3-__j5-vv8_f7_-Pn6-_z9_v8";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

const bots: Bot[] = [];
afterEach(async () => {
  for (const started of bots.splice(0)) {
    await started.chat.shutdown();
    await started.fake.stop();
  }
});

async function bot(options?: Parameters<typeof startBot>[0]): Promise<Bot> {
  const started = await startBot(options);
  bots.push(started);
  return started;
}

/**
 * Reads a data URI back the way signal-cli 0.14.9 does (`DataURI.of`, `Utils.createStreamDetailsFromDataURI`):
 * the same patterns, parameter values through `URLDecoder` (`+` is a space).
 */
function readAsSignalCli(uri: string): { mediaType: string; filename: string | undefined; data: Buffer } {
  const match = /^data:(?<type>.+?\/.+?)?(?<parameters>;.+?=.+?)?(?<base64>;base64)?,(?<data>.+)$/i.exec(uri);
  if (!match?.groups) {
    throw new Error(`signal-cli would read ${uri} as a file path`);
  }
  const { type, parameters, base64, data } = match.groups;
  const parameter = parameters && /^;(?<key>.+)=(?<value>.+)/i.exec(parameters)?.groups;
  const urlDecode = (value: string) => decodeURIComponent(value.replaceAll("+", " "));
  return {
    mediaType: type ?? "text/plain",
    filename: parameter && parameter.key === "filename" ? urlDecode(parameter.value!) : undefined,
    data: base64 ? Buffer.from(data!, "base64") : Buffer.from(urlDecode(data!)),
  };
}

function sentAttachments(bot: Bot): string[] {
  return bot.fake.rpcRequests("send").at(-1)?.params?.attachments as string[];
}

describe("outbound attachments", () => {
  it("sends files with the text as RFC 2397 data URIs carrying MIME type and filename", async () => {
    const started = await bot();

    await started.chat.thread(ALICE_DM).post({
      markdown: "**report** attached",
      files: [
        { data: PNG, filename: "chart.png", mimeType: "image/png" },
        { data: Buffer.from("a,b\n1,2\n"), filename: "Q3 report; final+v2,=ü.csv", mimeType: "text/csv; charset=utf-8" },
      ],
    });

    const [request] = started.fake.rpcRequests("send");
    expect(request?.params).toEqual({
      account: BOT_ACCOUNT,
      recipient: [ALICE_ACI],
      message: "report attached",
      textStyle: ["0:6:BOLD"],
      attachments: [
        `data:image/png;filename=chart.png;base64,${PNG.toString("base64")}`,
        `data:text/csv;filename=Q3%20report%3B%20final%2Bv2%2C%3D%C3%BC.csv;base64,${Buffer.from("a,b\n1,2\n").toString("base64")}`,
      ],
    });
    expect(sentAttachments(started).map(readAsSignalCli)).toEqual([
      { mediaType: "image/png", filename: "chart.png", data: PNG },
      { mediaType: "text/csv", filename: "Q3 report; final+v2,=ü.csv", data: Buffer.from("a,b\n1,2\n") },
    ]);
  });

  it("sends attachment-only posts to a Group, from Blob and ArrayBuffer data, defaulting the MIME type", async () => {
    const started = await bot();
    const bytes = new Uint8Array([1, 2, 3, 250]);

    const sent = await started.chat.thread(GROUP_THREAD).post({
      raw: "",
      files: [
        { data: new Blob([bytes], { type: "application/pdf" }), filename: "doc.pdf", mimeType: "application/pdf" },
        { data: bytes.buffer, filename: "blob.bin" },
      ],
    });

    expect(sent.id).toBe(`${BOT_ACI}:1700000000000`);
    expect(started.fake.rpcRequests("send")[0]?.params).toMatchObject({ account: BOT_ACCOUNT, groupId: GROUP_ID, message: "" });
    expect(sentAttachments(started).map(readAsSignalCli)).toEqual([
      { mediaType: "application/pdf", filename: "doc.pdf", data: Buffer.from(bytes) },
      { mediaType: "application/octet-stream", filename: "blob.bin", data: Buffer.from(bytes) },
    ]);
  });

  it("sends postable attachments that carry data, after the files", async () => {
    const started = await bot();

    await started.adapter.postMessage(ALICE_DM, {
      markdown: "photo",
      files: [{ data: Buffer.from("first"), filename: "first.txt", mimeType: "text/plain" }],
      attachments: [{ type: "image", data: PNG, mimeType: "image/png", name: "photo.png" }, { type: "file", data: Buffer.from("x") }],
    });

    expect(sentAttachments(started).map(readAsSignalCli)).toEqual([
      { mediaType: "text/plain", filename: "first.txt", data: Buffer.from("first") },
      { mediaType: "image/png", filename: "photo.png", data: PNG },
      { mediaType: "application/octet-stream", filename: undefined, data: Buffer.from("x") },
    ]);
  });

  it.each([
    ["a URL-only attachment", { markdown: "see", attachments: [{ type: "image" as const, url: "https://example.com/a.png" }] }],
    ["an empty file", { markdown: "see", files: [{ data: Buffer.alloc(0), filename: "empty.txt" }] }],
    ["an invalid MIME type", { markdown: "see", files: [{ data: PNG, filename: "a.png", mimeType: "not a type" }] }],
  ])("rejects %s without sending", async (_case, message) => {
    const started = await bot();

    await expect(started.adapter.postMessage(ALICE_DM, message)).rejects.toBeInstanceOf(ValidationError);
    expect(started.fake.rpcRequests("send")).toEqual([]);
  });

  it("rejects an edit that carries files: Signal edits change only the text", async () => {
    const started = await bot();

    await expect(
      started.adapter.editMessage(ALICE_DM, `${BOT_ACI}:1700000000555`, { markdown: "fixed", files: [{ data: PNG, filename: "a.png" }] }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(started.fake.rpcRequests("send")).toEqual([]);
  });
});

describe("inbound attachments", () => {
  it("delivers an attachment-only DM with name, MIME type and size, fetching the content through getAttachment", async () => {
    const started = await bot();
    started.fake.storedAttachments.set("Xk2pQ9.png", PNG);

    started.fake.injectEnvelope(
      attachmentEnvelope({
        aci: ALICE_ACI,
        attachments: [{ id: "Xk2pQ9.png", contentType: "image/png", filename: "photo.png", size: PNG.length, width: 640, height: 480 }],
      }),
    );
    const { message } = await started.nextDirectMessage();

    expect(message.text).toBe("");
    const [attachment] = message.attachments;
    expect(attachment).toMatchObject({
      type: "image",
      name: "photo.png",
      mimeType: "image/png",
      size: PNG.length,
      width: 640,
      height: 480,
    });
    expect(attachment?.url).toBeUndefined();
    expect(Buffer.from((await attachment!.fetchData!()) as Buffer)).toEqual(PNG);
    expect(started.fake.rpcRequests("getAttachment").map((request) => request.params)).toEqual([
      { account: BOT_ACCOUNT, id: "Xk2pQ9.png", recipient: ALICE_ACI },
    ]);
  });

  it("maps each attachment of a Group message, fetching with the Group ID", async () => {
    const started = await bot();
    started.fake.storedAttachments.set("voice.aac", Buffer.from("aac"));

    const message = started.adapter.parseMessage(
      attachmentEnvelope({
        aci: ALICE_ACI,
        groupId: GROUP_ID,
        text: "listen",
        attachments: [
          { id: "voice.aac", contentType: "audio/aac", isVoiceNote: true, size: 3 },
          { id: "clip.mp4", contentType: "video/mp4", filename: "clip.mp4" },
          { id: "notes.pdf", contentType: "application/pdf", filename: "notes.pdf" },
          { id: null, contentType: "image/png" },
        ],
      }),
    );

    expect(message.threadId).toBe(GROUP_THREAD);
    expect(message.text).toBe("listen");
    expect(message.attachments.map(({ type, name, mimeType }) => ({ type, name, mimeType }))).toEqual([
      { type: "audio", name: undefined, mimeType: "audio/aac" },
      { type: "video", name: "clip.mp4", mimeType: "video/mp4" },
      { type: "file", name: "notes.pdf", mimeType: "application/pdf" },
    ]);
    expect(Buffer.from((await message.attachments[0]!.fetchData!()) as Buffer).toString()).toBe("aac");
    expect(started.fake.rpcRequests("getAttachment")[0]?.params).toEqual({ account: BOT_ACCOUNT, id: "voice.aac", groupId: GROUP_ID });
  });

  it("rejects fetching an attachment signal-cli did not download with ResourceNotFoundError", async () => {
    const started = await bot();

    const message = started.adapter.parseMessage(
      attachmentEnvelope({ aci: ALICE_ACI, attachments: [{ id: "never-downloaded.jpg", contentType: "image/jpeg" }] }),
    );

    await expect(message.attachments[0]!.fetchData!()).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("ignores view-once messages", async () => {
    const started = await bot();

    started.fake.injectEnvelope(
      attachmentEnvelope({ aci: ALICE_ACI, viewOnce: true, attachments: [{ id: "secret.jpg", contentType: "image/jpeg" }] }),
    );
    started.fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "after" }));

    expect((await started.nextDirectMessage()).message.text).toBe("after");
    expect(() => started.adapter.parseMessage(attachmentEnvelope({ aci: ALICE_ACI, viewOnce: true, attachments: [{ id: "s.jpg" }] }))).toThrow(
      ValidationError,
    );
  });

  it("can still fetch attachments of messages read back from history", async () => {
    const started = await bot();
    started.fake.storedAttachments.set("kept.png", PNG);

    started.fake.injectEnvelope(
      attachmentEnvelope({ aci: ALICE_ACI, attachments: [{ id: "kept.png", contentType: "image/png", filename: "kept.png" }] }),
    );
    await started.nextDirectMessage();

    const [stored] = (await started.adapter.fetchMessages(ALICE_DM)).messages;
    const attachment = stored?.attachments[0];
    expect(attachment).toMatchObject({ type: "image", name: "kept.png", mimeType: "image/png" });
    expect(Buffer.from((await attachment!.fetchData!()) as Buffer)).toEqual(PNG);
  });

  it("rebuilds fetchData for a serialized attachment", async () => {
    const started = await bot();
    started.fake.storedAttachments.set("kept.png", PNG);
    const message = started.adapter.parseMessage(attachmentEnvelope({ aci: ALICE_ACI, attachments: [{ id: "kept.png", contentType: "image/png" }] }));

    const serialized = JSON.parse(JSON.stringify(message.toJSON().attachments[0])) as Attachment;
    const rehydrated = started.adapter.rehydrateAttachment(serialized);

    expect(Buffer.from((await rehydrated.fetchData!()) as Buffer)).toEqual(PNG);
    // Not this adapter's attachment: nothing to rebuild from.
    const foreign: Attachment = { type: "file", fetchMetadata: { fileId: "x" } };
    expect(started.adapter.rehydrateAttachment(foreign)).toBe(foreign);
  });
});

describe("walkthrough: a bot that sends a user's picture back", () => {
  it("receives a photo from signal-cli on another host and posts the same bytes back", async () => {
    const started = await bot({ initialize: false });
    const replies: Array<{ thread: Thread; message: Message }> = [];
    started.chat.onDirectMessage(async (thread, message) => {
      const [photo] = message.attachments;
      if (!photo?.fetchData) {
        return;
      }
      const data = await photo.fetchData();
      await thread.post({
        markdown: `Got **${photo.name}**`,
        files: [{ data: Buffer.from(data as Buffer), filename: `copy-${photo.name}`, ...(photo.mimeType && { mimeType: photo.mimeType }) }],
      });
      replies.push({ thread, message });
    });
    await started.chat.initialize();
    started.fake.storedAttachments.set("1700000000-abc.jpg", PNG);

    started.fake.injectEnvelope(
      attachmentEnvelope({ aci: ALICE_ACI, attachments: [{ id: "1700000000-abc.jpg", contentType: "image/jpeg", filename: "cat.jpg" }] }),
    );
    await expect.poll(() => replies.length).toBe(1);

    const [send] = started.fake.rpcRequests("send");
    expect(send?.params).toMatchObject({ account: BOT_ACCOUNT, recipient: [ALICE_ACI], message: "Got cat.jpg", textStyle: ["4:7:BOLD"] });
    expect(sentAttachments(started).map(readAsSignalCli)).toEqual([{ mediaType: "image/jpeg", filename: "copy-cat.jpg", data: PNG }]);
  });
});
