import { ValidationError } from "@chat-adapter/shared";
import { emoji, type Message, type ReactionEvent, type Thread } from "chat";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALICE_ACI,
  BOB_ACI,
  BOT_ACCOUNT,
  BOT_ACI,
  directTextEnvelope,
  groupTextEnvelope,
  reactionEnvelope,
} from "./fake-signal-cli.js";
import { startBot, type Bot } from "./helpers.js";

/** A Groups v2 ID (32 bytes) whose standard base64 contains `+` and `/`. */
const GROUP_ID = "+Pn6+/z9/v/4+fr7/P3+//j5+vv8/f7/+Pn6+/z9/v8=";
const GROUP_THREAD = "signal:group:-Pn6-_z9_v_4-fr7_P3-__j5-vv8_f7_-Pn6-_z9_v8";
const LEGACY_GROUP_ID = "CQkJCQkJCQkJCQkJCQkJCQ==";
const ALICE_DM = `signal:dm:${ALICE_ACI}`;

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

/** A bot whose catch-all `onReaction` records every reaction event Chat delivers. */
async function reactionBot() {
  const started = await bot({ initialize: false });
  const reactions: ReactionEvent[] = [];
  started.chat.onReaction(async (event) => {
    reactions.push(event);
  });
  await started.chat.initialize();
  return { ...started, reactions };
}

describe("editMessage", () => {
  it("sends the edit with editTimestamp of the original message, and later edits still target the original", async () => {
    const { fake, chat } = await bot();
    const sent = await chat.thread(ALICE_DM).post("helo");
    const [, originalTimestamp] = sent.id.split(/:(?=\d+$)/);

    const edited = await sent.edit("hello");
    await edited.edit("hello!");

    expect(edited.id).toBe(sent.id);
    expect(fake.rpcRequests("send").map((request) => request.params)).toEqual([
      { account: BOT_ACCOUNT, recipient: [ALICE_ACI], message: "helo" },
      { account: BOT_ACCOUNT, recipient: [ALICE_ACI], message: "hello", editTimestamp: Number(originalTimestamp) },
      { account: BOT_ACCOUNT, recipient: [ALICE_ACI], message: "hello!", editTimestamp: Number(originalTimestamp) },
    ]);
  });

  it("edits the bot's own message in a Group", async () => {
    const { fake, adapter } = await bot();

    await adapter.editMessage(GROUP_THREAD, `${BOT_ACI}:1700000000555`, "fixed");

    expect(fake.rpcRequests("send").at(-1)?.params).toEqual({
      account: BOT_ACCOUNT,
      groupId: GROUP_ID,
      message: "fixed",
      editTimestamp: 1_700_000_000_555,
    });
  });
});

describe("deleteMessage", () => {
  it("remotely deletes the bot's own message in a 1:1 Conversation and in a Group", async () => {
    const { fake, chat, adapter } = await bot();
    const sent = await chat.thread(ALICE_DM).post("oops");
    const [, timestamp] = sent.id.split(/:(?=\d+$)/);

    await sent.delete();
    await adapter.deleteMessage(GROUP_THREAD, `${BOT_ACI}:1700000000777`);

    expect(fake.rpcRequests("remoteDelete").map((request) => request.params)).toEqual([
      { account: BOT_ACCOUNT, recipient: [ALICE_ACI], targetTimestamp: Number(timestamp) },
      { account: BOT_ACCOUNT, groupId: GROUP_ID, targetTimestamp: 1_700_000_000_777 },
    ]);
  });
});

describe("edit and delete of other messages", () => {
  it("rejects someone else's message, a message from outside the 1:1 Conversation, and malformed IDs without calling signal-cli", async () => {
    const { fake, adapter } = await bot();
    const before = fake.requests.length;

    const attempts = [
      () => adapter.editMessage(ALICE_DM, `${ALICE_ACI}:1700000000001`, "x"),
      () => adapter.deleteMessage(GROUP_THREAD, `${ALICE_ACI}:1700000000001`),
      () => adapter.addReaction(ALICE_DM, `${BOB_ACI}:1700000000001`, emoji.thumbs_up),
      ...[
        "1700000000001",
        `${BOT_ACI}:`,
        `${BOT_ACI}:abc`,
        `${BOT_ACI}:01700000000001`,
        `${BOT_ACI}:1.5`,
        `${BOT_ACI}:0`,
        `${BOT_ACI.replaceAll("-", "")}:1700000000001`,
        `${BOT_ACI}:99999999999999999999`,
      ].map((messageId) => () => adapter.deleteMessage(ALICE_DM, messageId)),
      () => adapter.markAsRead(ALICE_DM, `${BOT_ACI}:1700000000001`),
      () => adapter.editMessage("signal:dm:not-an-aci", `${BOT_ACI}:1700000000001`, "x"),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toBeInstanceOf(ValidationError);
    }

    expect(fake.requests.slice(before)).toEqual([]);
  });
});

describe("addReaction and removeReaction", () => {
  it("react to a received message, targeting its author and timestamp", async () => {
    const { fake, adapter, nextDirectMessage } = await bot();
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "ship it?", timestamp: 1_700_000_000_123 }));
    const { thread, message } = await nextDirectMessage();

    await adapter.addReaction(thread.id, message.id, emoji.thumbs_up);
    await adapter.addReaction(thread.id, message.id, "🦀");
    await adapter.removeReaction(thread.id, message.id, "🦀");

    expect(fake.rpcRequests("sendReaction").map((request) => request.params)).toEqual([
      { account: BOT_ACCOUNT, recipient: [ALICE_ACI], emoji: "👍", targetAuthor: ALICE_ACI, targetTimestamp: 1_700_000_000_123 },
      { account: BOT_ACCOUNT, recipient: [ALICE_ACI], emoji: "🦀", targetAuthor: ALICE_ACI, targetTimestamp: 1_700_000_000_123 },
      {
        account: BOT_ACCOUNT,
        recipient: [ALICE_ACI],
        emoji: "🦀",
        targetAuthor: ALICE_ACI,
        targetTimestamp: 1_700_000_000_123,
        remove: true,
      },
    ]);
  });

  it("react in a Group, to another member's message and to the bot's own", async () => {
    const { fake, chat } = await bot();
    const sent = await chat.thread(GROUP_THREAD).post("status: building");
    const [, botTimestamp] = sent.id.split(/:(?=\d+$)/);

    await chat.getAdapter("signal").addReaction(GROUP_THREAD, `${BOB_ACI}:1700000000999`, emoji.heart);
    await sent.addReaction(emoji.check);
    await sent.removeReaction(emoji.check);

    expect(fake.rpcRequests("sendReaction").map((request) => request.params)).toEqual([
      { account: BOT_ACCOUNT, groupId: GROUP_ID, emoji: "❤️", targetAuthor: BOB_ACI, targetTimestamp: 1_700_000_000_999 },
      { account: BOT_ACCOUNT, groupId: GROUP_ID, emoji: "✅", targetAuthor: BOT_ACI, targetTimestamp: Number(botTimestamp) },
      {
        account: BOT_ACCOUNT,
        groupId: GROUP_ID,
        emoji: "✅",
        targetAuthor: BOT_ACI,
        targetTimestamp: Number(botTimestamp),
        remove: true,
      },
    ]);
  });
});

describe("inbound reactions", () => {
  it("fire onReaction with added/removed, the normalized emoji, the reacting user and the target message", async () => {
    const { fake, reactions } = await reactionBot();
    const target = `${BOT_ACI}:1700000000444`;

    fake.injectEnvelope({
      ...reactionEnvelope({ aci: ALICE_ACI, emoji: "👍", targetAuthor: BOT_ACI, targetTimestamp: 1_700_000_000_444 }),
      sourceName: "Alice",
    });
    fake.injectEnvelope(reactionEnvelope({ aci: ALICE_ACI, emoji: "👍", targetAuthor: BOT_ACI, targetTimestamp: 1_700_000_000_444, remove: true }));
    fake.injectEnvelope(
      reactionEnvelope({ aci: BOB_ACI, emoji: "🦀", targetAuthor: ALICE_ACI, targetTimestamp: 1_700_000_000_111, groupId: GROUP_ID }),
    );
    await expect.poll(() => reactions.length).toBe(3);

    expect(
      reactions.map(({ added, emoji: value, rawEmoji, messageId, threadId, thread, user }) => ({
        added,
        emoji: value,
        rawEmoji,
        messageId,
        threadId,
        threadIsDM: thread.isDM,
        user: { userId: user.userId, fullName: user.fullName, isMe: user.isMe },
      })),
    ).toEqual([
      {
        added: true,
        emoji: emoji.thumbs_up,
        rawEmoji: "👍",
        messageId: target,
        threadId: ALICE_DM,
        threadIsDM: true,
        user: { userId: ALICE_ACI, fullName: "Alice", isMe: false },
      },
      {
        added: false,
        emoji: emoji.thumbs_up,
        rawEmoji: "👍",
        messageId: target,
        threadId: ALICE_DM,
        threadIsDM: true,
        user: { userId: ALICE_ACI, fullName: ALICE_ACI, isMe: false },
      },
      {
        added: true,
        emoji: expect.objectContaining({ name: "🦀" }),
        rawEmoji: "🦀",
        messageId: `${ALICE_ACI}:1700000000111`,
        threadId: GROUP_THREAD,
        threadIsDM: false,
        user: { userId: BOB_ACI, fullName: BOB_ACI, isMe: false },
      },
    ]);
  });

  it("match emoji filters by name, including Signal's heart with a variation selector", async () => {
    const started = await bot({ initialize: false });
    const hearts: string[] = [];
    started.chat.onReaction([emoji.heart], async (event) => {
      hearts.push(event.rawEmoji);
    });
    await started.chat.initialize();

    for (const raw of ["👍", "❤️", "❤"]) {
      started.fake.injectEnvelope(reactionEnvelope({ aci: ALICE_ACI, emoji: raw, targetAuthor: BOT_ACI, targetTimestamp: 1_700_000_000_444 }));
    }
    await expect.poll(() => hearts.length).toBe(2);

    expect(hearts).toEqual(["❤️", "❤"]);
  });

  it("story reactions, legacy-group reactions, malformed reactions and reactions synced from the bot's own devices fire nothing", async () => {
    const { fake, reactions } = await reactionBot();
    const valid = reactionEnvelope({ aci: ALICE_ACI, emoji: "👍", targetAuthor: BOT_ACI, targetTimestamp: 1_700_000_000_444 });
    const withReaction = (reaction: Record<string, unknown>) => ({
      ...valid,
      dataMessage: { ...valid.dataMessage, reaction: { ...valid.dataMessage.reaction, ...reaction } },
    });

    fake.injectEnvelope({ ...valid, dataMessage: { ...valid.dataMessage, storyContext: { authorUuid: BOT_ACI, sentTimestamp: 1 } } });
    fake.injectEnvelope(
      reactionEnvelope({ aci: ALICE_ACI, emoji: "👍", targetAuthor: BOT_ACI, targetTimestamp: 1_700_000_000_444, groupId: LEGACY_GROUP_ID }),
    );
    fake.injectEnvelope(withReaction({ emoji: "" }));
    fake.injectEnvelope(withReaction({ targetAuthorUuid: null }));
    fake.injectEnvelope(withReaction({ targetSentTimestamp: "1700000000444" }));
    const { dataMessage, ...withoutData } = valid;
    fake.injectEnvelope({ ...withoutData, sourceUuid: BOT_ACI, syncMessage: { sentMessage: { ...dataMessage, destinationUuid: ALICE_ACI } } });
    // The bot's own reaction, should signal-cli ever deliver one as a data message.
    fake.injectEnvelope({ ...valid, sourceUuid: BOT_ACI });
    fake.injectEnvelope(reactionEnvelope({ aci: BOB_ACI, emoji: "🎉", targetAuthor: BOT_ACI, targetTimestamp: 1 }));
    await expect.poll(() => reactions.length).toBe(1);

    expect(reactions.map(({ rawEmoji, user }) => [rawEmoji, user.userId])).toEqual([["🎉", BOB_ACI]]);
  });

  it("are not handed to message handlers", async () => {
    const started = await bot({ initialize: false });
    const messages: Message[] = [];
    started.chat.onDirectMessage(async (_thread: Thread, message: Message) => {
      messages.push(message);
    });
    await started.chat.initialize();

    started.fake.injectEnvelope(reactionEnvelope({ aci: ALICE_ACI, emoji: "👍", targetAuthor: BOT_ACI, targetTimestamp: 1 }));
    started.fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "sentinel" }));
    await expect.poll(() => messages.length).toBe(1);

    expect(messages.map((message) => message.text)).toEqual(["sentinel"]);
  });
});

describe("markAsRead", () => {
  it("sends a read receipt to the author of the message being handled, in a 1:1 Conversation and in a Group", async () => {
    const started = await bot({ initialize: false });
    const read: string[] = [];
    const markRead = async (thread: Thread, message: Message) => {
      await thread.markAsRead();
      read.push(message.text);
    };
    started.chat.onDirectMessage(markRead);
    started.chat.onNewMention(markRead);
    await started.chat.initialize();

    started.fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "dm", timestamp: 1_700_000_000_201 }));
    await expect.poll(() => read.length).toBe(1);
    started.fake.injectEnvelope(
      groupTextEnvelope({ aci: BOB_ACI, groupId: GROUP_ID, text: "￼ hi", mentions: [{ aci: BOT_ACI, start: 0 }], timestamp: 1_700_000_000_202 }),
    );
    await expect.poll(() => read.length).toBe(2);

    expect(started.fake.rpcRequests("sendReceipt").map((request) => request.params)).toEqual([
      { account: BOT_ACCOUNT, recipient: ALICE_ACI, targetTimestamp: [1_700_000_000_201], type: "read" },
      { account: BOT_ACCOUNT, recipient: BOB_ACI, targetTimestamp: [1_700_000_000_202], type: "read" },
    ]);
  });
});

/**
 * Walkthrough for a bot developer: a deploy bot acknowledges a request with a
 * read receipt and 👀, posts a status line, edits it when done and swaps 👀 for
 * ✅; the user's 👎 on the status line makes the bot retract it. Read back from
 * signal-cli everything the bot sent, in order.
 */
it("deploy bot: read receipt, reactions, edit and retract, driven by a user's messages and reactions", async () => {
  const started = await bot({ initialize: false });
  const { chat, fake } = started;
  const signal = chat.getAdapter("signal");
  let statusId = "";
  let done = 0;
  chat.onDirectMessage(async (thread, message) => {
    await thread.markAsRead();
    await signal.addReaction(thread.id, message.id, emoji.eyes);
    const status = await thread.post("deploying…");
    statusId = status.id;
    await status.edit("deployed");
    await signal.addReaction(thread.id, message.id, emoji.check);
    done++;
  });
  chat.onReaction([emoji.thumbs_down], async (event) => {
    await event.adapter.deleteMessage(event.threadId, event.messageId);
    done++;
  });
  await chat.initialize();
  const startup = fake.requests.length;

  fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "deploy", timestamp: 1_700_000_000_300 }));
  await expect.poll(() => done).toBe(1);
  const [author, statusTimestamp] = statusId.split(/:(?=\d+$)/) as [string, string];
  // A 👍 on the status line is not a 👎 handler's business; the 👎 retracts it.
  for (const reaction of ["👍", "👎"]) {
    fake.injectEnvelope(reactionEnvelope({ aci: ALICE_ACI, emoji: reaction, targetAuthor: author, targetTimestamp: Number(statusTimestamp) }));
  }
  await expect.poll(() => done).toBe(2);

  expect(author).toBe(BOT_ACI);
  expect(fake.requests.slice(startup).flatMap(({ body }) => (body ? [[body.method, body.params]] : []))).toEqual([
    ["sendReceipt", { account: BOT_ACCOUNT, recipient: ALICE_ACI, targetTimestamp: [1_700_000_000_300], type: "read" }],
    ["sendReaction", { account: BOT_ACCOUNT, recipient: [ALICE_ACI], emoji: "👀", targetAuthor: ALICE_ACI, targetTimestamp: 1_700_000_000_300 }],
    ["send", { account: BOT_ACCOUNT, recipient: [ALICE_ACI], message: "deploying…" }],
    ["send", { account: BOT_ACCOUNT, recipient: [ALICE_ACI], message: "deployed", editTimestamp: Number(statusTimestamp) }],
    ["sendReaction", { account: BOT_ACCOUNT, recipient: [ALICE_ACI], emoji: "✅", targetAuthor: ALICE_ACI, targetTimestamp: 1_700_000_000_300 }],
    ["remoteDelete", { account: BOT_ACCOUNT, recipient: [ALICE_ACI], targetTimestamp: Number(statusTimestamp) }],
  ]);
});
