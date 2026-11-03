import { Actions, Button, Card, CardLink, CardText, Divider, Field, Fields, LinkButton, Section, stringifyMarkdown, Table, type AdapterPostableMessage, type Message } from "chat";
import { afterEach, describe, expect, it } from "vitest";
import { ALICE_ACI, BOB_ACI, BOT_ACCOUNT, BOT_ACI, directTextEnvelope, groupTextEnvelope } from "./fake-signal-cli.js";
import { startBot, type Bot } from "./helpers.js";

const GROUP_ID = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
const DM = `signal:dm:${ALICE_ACI}`;

const bots: Bot[] = [];
afterEach(async () => {
  for (const started of bots.splice(0)) {
    await started.chat.shutdown();
    await started.fake.stop();
  }
});

async function bot(): Promise<Bot> {
  const started = await startBot();
  bots.push(started);
  return started;
}

/** Posts through Chat and returns what reached signal-cli's `send`. */
async function send(postable: AdapterPostableMessage): Promise<{ message: unknown; textStyle?: unknown }> {
  const { chat, fake } = await bot();
  await chat.thread(DM).post(postable);
  const [request] = fake.rpcRequests("send");
  const { message, textStyle } = request?.params ?? {};
  return textStyle === undefined ? { message } : { message, textStyle };
}

/** Each `start:length:STYLE` range with the text it covers, counted in UTF-16 code units as Signal does. */
function covered({ message, textStyle }: { message: unknown; textStyle?: unknown }): string[] {
  return (textStyle as string[]).map((range) => {
    const [start, length, style] = range.split(":") as [string, string, string];
    return `${style} ${(message as string).slice(Number(start), Number(start) + Number(length))}`;
  });
}

describe("outbound markdown", () => {
  it("sends bold, italic, strikethrough, inline code and spoilers as UTF-16 text style ranges", async () => {
    const sent = await send({ markdown: "😀 **bold 🎉** _it_ ~~del~~ `x()` ||secret||!" });

    expect(sent).toEqual({
      message: "😀 bold 🎉 it del x() secret!",
      // 😀 and 🎉 are two UTF-16 code units each.
      textStyle: ["3:7:BOLD", "11:2:ITALIC", "14:3:STRIKETHROUGH", "18:3:MONOSPACE", "22:6:SPOILER"],
    });
    expect(covered(sent)).toEqual(["BOLD bold 🎉", "ITALIC it", "STRIKETHROUGH del", "MONOSPACE x()", "SPOILER secret"]);
  });

  it("nests styles and lets a spoiler span styled text", async () => {
    const sent = await send({ markdown: "***both*** ||a **b** `c`||" });

    expect(covered(sent)).toEqual(["BOLD both", "ITALIC both", "BOLD b", "MONOSPACE c", "SPOILER a b c"]);
    expect(sent.message).toBe("both a b c");
  });

  it("keeps a `||` without a partner, or with nothing to hide, as text", async () => {
    expect(await send({ markdown: "a || b" })).toEqual({ message: "a || b" });
    expect(await send({ markdown: "a |||| b" })).toEqual({ message: "a |||| b" });
    expect(await send({ markdown: "**a ||b** c||" })).toEqual({ message: "a ||b c||", textStyle: ["0:5:BOLD"] });
  });

  it("sends a code block as monospace text without its fences", async () => {
    const sent = await send({ markdown: "Run:\n\n```sh\nnpm test\n\nnpm run check\n```" });

    expect(sent).toEqual({ message: "Run:\n\nnpm test\n\nnpm run check", textStyle: ["6:23:MONOSPACE"] });
  });

  it("renders headings bold, lists as • and 1. text, and links as plain URLs", async () => {
    const sent = await send({
      markdown: [
        "# Plan",
        "- one **two**",
        "  - nested",
        "- [docs](https://example.com/docs)",
        "3. third\n4. <https://example.com>",
        "> quoted\n> lines",
      ].join("\n\n"),
    });

    expect(sent.message).toBe(
      [
        "Plan",
        "• one two\n  • nested\n• docs (https://example.com/docs)",
        "3. third\n4. https://example.com",
        "> quoted\n> lines",
      ].join("\n\n"),
    );
    expect(covered(sent)).toEqual(["BOLD Plan", "BOLD two"]);
  });

  it("renders a table as monospace text", async () => {
    const sent = await send({ markdown: "| a | b |\n|---|---|\n| 1 | 22 |" });

    expect(sent).toEqual({ message: "a | b\n--|---\n1 | 22", textStyle: ["0:19:MONOSPACE"] });
  });

  it("sends plain strings and raw text verbatim, without styles", async () => {
    expect(await send("**not** _markdown_ ||x||")).toEqual({ message: "**not** _markdown_ ||x||" });
    expect(await send({ raw: "**raw**" })).toEqual({ message: "**raw**" });
  });

  it("renderFormatted returns the plain Signal text", async () => {
    const { adapter } = await bot();
    expect(adapter.renderFormatted({ type: "root", children: [{ type: "heading", depth: 2, children: [{ type: "text", value: "Hi" }] }] })).toBe("Hi");
  });
});

describe("outbound cards", () => {
  it("renders a card as formatted text: bold title, fields, markdown text, links, tables; drops buttons", async () => {
    const card = Card({
      title: "Order 🧾 42",
      subtitle: "Shipped",
      children: [
        CardText("Thanks, **Alice**!"),
        Fields([Field({ label: "Status", value: "paid" }), Field({ label: "Total", value: "€9" })]),
        Section([CardText("Questions?", { style: "muted" }), CardLink({ url: "https://example.com/help", label: "Help" })]),
        Divider(),
        Table({ headers: ["Item", "Qty"], rows: [["Tea", "2"]] }),
        Actions([Button({ id: "cancel", label: "Cancel" }), LinkButton({ url: "https://example.com/track", label: "Track" })]),
      ],
    });

    for (const postable of [card, { card, fallbackText: "Order 42 shipped" }]) {
      const sent = await send(postable);
      expect(sent.message).toBe(
        [
          "Order 🧾 42\nShipped",
          "Thanks, Alice!",
          "Status: paid\nTotal: €9",
          "Questions?",
          "Help (https://example.com/help)",
          "———",
          "Item | Qty\n-----|----\nTea  | 2",
          "Track (https://example.com/track)",
        ].join("\n\n"),
      );
      expect(covered(sent)).toEqual(["BOLD Order 🧾 42", "BOLD Alice", "BOLD Status", "BOLD Total", "ITALIC Questions?", "MONOSPACE Item | Qty\n-----|----\nTea  | 2"]);
    }
  });
});

/** A 1:1 envelope whose text carries Signal text styles. */
function styledEnvelope(text: string, textStyles: unknown[]) {
  const envelope = directTextEnvelope({ aci: ALICE_ACI, text });
  return { ...envelope, dataMessage: { ...envelope.dataMessage, textStyles } };
}

async function receive(envelope: unknown): Promise<Message> {
  const { fake, nextDirectMessage } = await bot();
  fake.injectEnvelope(envelope);
  return (await nextDirectMessage()).message;
}

describe("inbound text styles", () => {
  it("convert to markdown, with UTF-16 offsets past non-BMP characters", async () => {
    const message = await receive(
      styledEnvelope("😀 bold it del x() secret", [
        { style: "BOLD", start: 3, length: 7 },
        { style: "ITALIC", start: 8, length: 2 },
        { style: "STRIKETHROUGH", start: 11, length: 3 },
        { style: "MONOSPACE", start: 15, length: 3 },
        { style: "SPOILER", start: 19, length: 6 },
      ]),
    );

    expect(stringifyMarkdown(message.formatted)).toBe("😀 **bold *it*** ~~del~~ `x()` ||secret||\n");
    expect(message.text).toBe("😀 bold it del x() secret");
  });

  it("turn whole-line monospace over several lines into a code block, and keep paragraphs and line breaks", async () => {
    const message = await receive(
      styledEnvelope("Look:\nhere\n\nnpm test\nnpm run check\n\n**literal**", [{ style: "MONOSPACE", start: 12, length: 22 }]),
    );

    expect(stringifyMarkdown(message.formatted)).toBe("Look:\\\nhere\n\n```\nnpm test\nnpm run check\n```\n\n\\*\\*literal\\*\\*\n");
    expect(message.text).toBe("Look:\nhere\n\nnpm test\nnpm run check\n\n**literal**");
  });

  it("skip ranges that are malformed, unknown, or outside the text", async () => {
    const message = await receive(
      styledEnvelope("abc", [
        { style: "BOLD", start: 2, length: 5 },
        { style: "NONE", start: 0, length: 1 },
        { style: "ITALIC", start: -1, length: 2 },
        { style: "ITALIC", start: 0, length: 1.5 },
        { style: "ITALIC", start: 3, length: 1 },
        null,
        { style: "STRIKETHROUGH", start: "0", length: 1 },
      ]),
    );

    expect(stringifyMarkdown(message.formatted)).toBe("ab**c**\n");
  });
});

describe("inbound mentions", () => {
  it("read as @<userName> for the Bot Account and @<ACI> for others, and styles around them stay aligned", async () => {
    const { fake, chat } = await bot();
    const received: Message[] = [];
    chat.onNewMention(async (_thread, message) => {
      received.push(message);
    });
    const envelope = groupTextEnvelope({
      aci: BOB_ACI,
      groupId: GROUP_ID,
      text: "\uFFFC ask \uFFFC 😀 now",
      mentions: [
        { aci: BOT_ACI, start: 0 },
        { aci: ALICE_ACI, start: 6 },
      ],
    });
    fake.injectEnvelope({
      ...envelope,
      dataMessage: { ...envelope.dataMessage, textStyles: [{ style: "BOLD", start: 6, length: 1 }, { style: "ITALIC", start: 11, length: 3 }] },
    });
    await expect.poll(() => received.length).toBe(1);

    const [message] = received as [Message];
    expect(message.text).toBe(`@echo-bot ask @${ALICE_ACI} 😀 now`);
    expect(stringifyMarkdown(message.formatted)).toBe(`@echo-bot ask **@${ALICE_ACI}** 😀 *now*\n`);
    expect(message.isMention).toBe(true);
  });

  it("leave a mention without a valid ACI or position as it was", async () => {
    const envelope = directTextEnvelope({ aci: ALICE_ACI, text: "hi \uFFFC" });
    const message = await receive({
      ...envelope,
      dataMessage: {
        ...envelope.dataMessage,
        mentions: [{ uuid: "not-an-aci", start: 3, length: 1 }, { uuid: BOB_ACI, start: 3, length: 9 }, { uuid: BOB_ACI }],
      },
    });

    expect(message.text).toBe("hi \uFFFC");
  });
});
