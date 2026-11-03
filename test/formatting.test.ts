import { Actions, Button, Card, CardLink, CardText, Divider, Field, Fields, Image, LinkButton, Section, stringifyMarkdown, Table, type AdapterPostableMessage, type Message } from "chat";
import { createSignalAdapter, SignalFormatConverter } from "../src/index.js";
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

  it("renders headings bold, lists as • and 1. text, and links as `label (url)` or the bare URL", async () => {
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

  it("writes autolinked e-mail addresses and www links as typed, and resolves reference-style links and footnotes", async () => {
    const sent = await send({
      markdown: "Mail a@b.example or see www.example.com, [the docs][d] and ![logo][l][^n]\n\n[d]: https://example.com/docs\n[l]: https://example.com/l.png\n\n[^n]: A note.",
    });

    expect(sent).toEqual({
      message: "Mail a@b.example or see www.example.com, the docs (https://example.com/docs) and logo (https://example.com/l.png)[^n]\n\n[^n]: A note.",
    });
  });

  it("styles a bold heading once and leaves no blank line for an empty code block", async () => {
    expect(await send({ markdown: "# **Title**\n\n```\n```\n\nend" })).toEqual({ message: "Title\n\nend", textStyle: ["0:5:BOLD"] });
  });

  it("renders task list items with their checkbox state", async () => {
    expect(await send({ markdown: "- [x] done\n- [ ] todo\n- plain" })).toEqual({ message: "• ☑ done\n• ☐ todo\n• plain" });
  });

  it("pairs several spoilers in one run, indents under ordered markers and in quotes, keeps an unresolved reference as typed", async () => {
    const markdown = "||a|| and ||b||\n\n1. a\n   - b\n\n[x][missing] ![](https://e.com/i.png) ![pic](https://e.com/p.png)\n\n> p1\n>\n> - q\n\n||||x||";
    expect(await send({ markdown })).toEqual({
      message: "a and b\n\n1. a\n   • b\n\n[x][missing] https://e.com/i.png pic (https://e.com/p.png)\n\n> p1\n> \n> • q\n\n||||x||",
      textStyle: ["0:1:SPOILER", "6:1:SPOILER"],
    });
  });

  it("toAst takes Signal text literally", () => {
    expect(stringifyMarkdown(new SignalFormatConverter().toAst("**x** ||y||"))).toBe("\\*\\*x\\*\\* ||y||\n");
  });

  it("rejects a postable message of unknown shape like Chat's own converter", () => {
    expect(() => new SignalFormatConverter().renderSignal({} as never)).toThrow("Invalid PostableMessage format");
  });

  it("parseSignal skips mentions with non-integer offsets", () => {
    const mentions = [
      { start: Number.NaN, length: 1, replacement: "@x" },
      { start: 1.5, length: 1, replacement: "@y" },
      { start: 3, length: 1.5, replacement: "@z" },
    ];
    expect(new SignalFormatConverter().parseSignal("hello", [], mentions).text).toBe("hello");
  });

  it("sends an mdast AST with styles", async () => {
    const sent = await send({ ast: { type: "root", children: [{ type: "paragraph", children: [{ type: "emphasis", children: [{ type: "text", value: "hi" }] }] }] } });

    expect(sent).toEqual({ message: "hi", textStyle: ["0:2:ITALIC"] });
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

  it("SignalFormatConverter.renderPostable gives the text renderSignal sends, cards included", () => {
    const converter = new SignalFormatConverter();
    const card = Card({ title: "T", children: [CardText("hi **x**")] });

    for (const postable of [card, { markdown: "**b** ||s||" }]) {
      expect(converter.renderPostable(postable)).toBe(converter.renderSignal(postable).text);
    }
    expect(converter.renderPostable(card)).toBe("T\n\nhi x");
  });

  it("echoes a received message's AST back, also after serialisation, without turning typed `||` into a spoiler", async () => {
    const { chat, fake, nextDirectMessage } = await bot();
    fake.injectEnvelope(styledEnvelope("a ||b|| c", [{ style: "BOLD", start: 0, length: 1 }]));
    const { message } = await nextDirectMessage();
    await chat.thread(DM).post({ ast: message.formatted });
    // Chat serialises messages it queues or debounces.
    await chat.thread(DM).post({ ast: JSON.parse(JSON.stringify(message.toJSON())).formatted });

    expect(fake.rpcRequests("send").map((request) => request.params)).toMatchObject([
      { message: "a ||b|| c", textStyle: ["0:1:BOLD"] },
      { message: "a ||b|| c", textStyle: ["0:1:BOLD"] },
    ]);
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

    for (const postable of [card, { card }]) {
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

  it("sends a card's fallbackText verbatim instead, when set", async () => {
    const card = Card({ title: "Order 42", children: [CardText("**shipped**")] });

    expect(await send({ card, fallbackText: "Order 42 **shipped**" })).toEqual({ message: "Order 42 **shipped**" });
  });

  it("keeps `||` in card data literal; card text, which is markdown, still has spoilers", async () => {
    const card = Card({
      title: "a || b || c",
      subtitle: "s||t||",
      children: [
        Fields([Field({ label: "x||y||", value: "1 || 2 || 3" })]),
        CardText("||hidden||"),
        CardLink({ url: "https://e.com", label: "l||m||" }),
        Image({ url: "https://e.com/i.png", alt: "i||j||" }),
        Actions([LinkButton({ url: "https://e.com/b", label: "b||c||" })]),
      ],
    });

    expect(await send(card)).toEqual({
      message: "a || b || c\ns||t||\n\nx||y||: 1 || 2 || 3\n\nhidden\n\nl||m|| (https://e.com)\n\ni||j|| (https://e.com/i.png)\n\nb||c|| (https://e.com/b)",
      textStyle: ["0:11:BOLD", "20:6:BOLD", "41:6:SPOILER"],
    });
  });

  it("renders the header image and images as URLs, and bold card text bold, in a Group too", async () => {
    const { chat, fake } = await bot();
    const card = Card({
      title: "T",
      imageUrl: "https://example.com/h.png",
      children: [CardText("sale", { style: "bold" }), Image({ url: "https://example.com/i.png", alt: "pic" })],
    });
    await chat.thread(`signal:group:${GROUP_ID.replaceAll("=", "")}`).post(card);

    expect(fake.rpcRequests("send")[0]?.params).toEqual({
      account: BOT_ACCOUNT,
      groupId: GROUP_ID,
      message: "T\n\nhttps://example.com/h.png\n\nsale\n\npic (https://example.com/i.png)",
      textStyle: ["0:1:BOLD", "30:4:BOLD"],
    });
  });
});

/** A 1:1 envelope whose text carries Signal text styles. */
function styledEnvelope(text: string, textStyles: Array<{ style?: unknown; start?: unknown; length?: unknown } | null>) {
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

  it("skip ranges that are malformed or unknown, and clip those running past the text", async () => {
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

  it("move a style's edge spaces outside it and never split an emoji", async () => {
    const message = await receive(
      styledEnvelope("say hi 😀 now", [
        { style: "BOLD", start: 3, length: 4 },
        { style: "ITALIC", start: 8, length: 1 },
      ]),
    );

    expect(stringifyMarkdown(message.formatted)).toBe("say **hi** *😀* now\n");
  });

  it.each([
    ["a single whole monospace line stays inline code", "x\nab", [{ style: "MONOSPACE", start: 2, length: 2 }], "x\\\n`ab`\n"],
    ["monospace over a line break, not whole lines, stays inline", "a b\nc d", [{ style: "MONOSPACE", start: 2, length: 3 }], "a `b\nc` d\n"],
    ["three line breaks are one paragraph break", "a\n\n\nb", [], "a\n\nb\n"],
    ["a spoiler wraps the styles inside it", "ab cd", [{ style: "SPOILER", start: 0, length: 5 }, { style: "BOLD", start: 3, length: 2 }], "||ab **cd**||\n"],
    ["markdown typed without styles stays literal", "1. a *b*", [], "1\\. a \\*b\\*\n"],
    ["whole lines of monospace selected with their line break are a code block", "a\nb\nc", [{ style: "MONOSPACE", start: 0, length: 4 }], "```\na\nb\n```\n\nc\n"],
    ["a style ending inside an emoji takes the whole emoji", "x😀", [{ style: "BOLD", start: 0, length: 2 }], "**x😀**\n"],
    ["monospace keeps its edge spaces", "a  x  b", [{ style: "MONOSPACE", start: 1, length: 5 }], "a`   x   `b\n"],
    ["monospace from mid-line over a line break stays inline", "a b\nc", [{ style: "MONOSPACE", start: 2, length: 3 }], "a `b\nc`\n"],
    ["whole lines of monospace with a style inside are still a code block", "a\nb\nc", [{ style: "MONOSPACE", start: 0, length: 5 }, { style: "BOLD", start: 2, length: 1 }], "```\na\nb\nc\n```\n"],
    ["strikethrough nests inside italic", "abc", [{ style: "ITALIC", start: 0, length: 3 }, { style: "STRIKETHROUGH", start: 1, length: 1 }], "*a~~b~~c*\n"],
    ["overlapping monospace ranges make one code span", "a bcd e", [{ style: "MONOSPACE", start: 2, length: 2 }, { style: "MONOSPACE", start: 3, length: 2 }], "a `bcd` e\n"],
    ["bold inside monospace splits the code span around it", "a bcd e", [{ style: "MONOSPACE", start: 2, length: 3 }, { style: "BOLD", start: 3, length: 1 }], "a `b`**`c`**`d` e\n"],
    ["monospace over whole lines ending mid-line stays inline", "a\nb\ncd", [{ style: "MONOSPACE", start: 0, length: 5 }], "`a\nb\nc`d\n"],
    ["whole lines of monospace selected with the line break before them are a code block", "x\na\nb\ny", [{ style: "MONOSPACE", start: 1, length: 4 }], "x\n\n```\na\nb\n```\n\ny\n"],
  ])("%s", (_name, text, textStyles, markdown) => {
    const adapter = createSignalAdapter({ account: BOT_ACCOUNT, transport: { type: "http", url: "http://signal-cli:8080" } });

    expect(stringifyMarkdown(adapter.parseMessage(styledEnvelope(text, textStyles)).formatted)).toBe(markdown);
  });

  it("parse a huge hostile message without overflowing the stack", () => {
    const adapter = createSignalAdapter({ account: BOT_ACCOUNT, transport: { type: "http", url: "http://signal-cli:8080" } });
    const text = "ab ".repeat(100_000);
    const textStyles = Array.from({ length: 100_000 }, (_, index) => ({ style: index % 2 ? "BOLD" : "ITALIC", start: index * 3, length: 2 }));

    const message = adapter.parseMessage(styledEnvelope(text, textStyles));
    expect(message.text).toBe(text);
    expect(stringifyMarkdown(message.formatted).startsWith("*ab* **ab** *ab*")).toBe(true);
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
        mentions: [
          { uuid: "not-an-aci", start: 3, length: 1 },
          { uuid: BOB_ACI, start: 3, length: 9 },
          { uuid: BOB_ACI, start: 3, length: 0 },
          { uuid: BOB_ACI },
        ],
      },
    });

    expect(message.text).toBe("hi \uFFFC");
  });

  it("apply in text order, skip one overlapping another, and pull a style starting inside a mention onto all of it", () => {
    const adapter = createSignalAdapter({ account: BOT_ACCOUNT, transport: { type: "http", url: "http://signal-cli:8080" } });
    const envelope = styledEnvelope("\uFFFC \uFFFC\uFFFCc d", [{ style: "BOLD", start: 3, length: 2 }]);
    const message = adapter.parseMessage({
      ...envelope,
      dataMessage: {
        ...envelope.dataMessage,
        mentions: [
          { uuid: BOB_ACI, start: 2, length: 2 },
          { uuid: ALICE_ACI, start: 3, length: 1 },
          { uuid: ALICE_ACI, start: 0, length: 1 },
        ],
      },
    });

    expect(message.text).toBe(`@${ALICE_ACI} @${BOB_ACI}c d`);
    expect(stringifyMarkdown(message.formatted)).toBe(`@${ALICE_ACI} **@${BOB_ACI}c** d\n`);
  });

  it("stretch a style ending inside a mention over all of it", () => {
    const adapter = createSignalAdapter({ account: BOT_ACCOUNT, transport: { type: "http", url: "http://signal-cli:8080" } });
    const envelope = styledEnvelope("\uFFFC\uFFFC hi", [{ style: "BOLD", start: 0, length: 1 }]);
    const message = adapter.parseMessage({
      ...envelope,
      dataMessage: { ...envelope.dataMessage, mentions: [{ uuid: BOB_ACI, start: 0, length: 2 }] },
    });

    expect(stringifyMarkdown(message.formatted)).toBe(`**@${BOB_ACI}** hi\n`);
  });
});
