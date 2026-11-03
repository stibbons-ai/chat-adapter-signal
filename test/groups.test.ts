import { ValidationError } from "@chat-adapter/shared";
import type { Message, Thread } from "chat";
import { afterEach, describe, expect, it } from "vitest";
import { createSignalAdapter } from "../src/index.js";
import { ALICE_ACI, BOB_ACI, BOT_ACCOUNT, BOT_ACI, directTextEnvelope, groupTextEnvelope } from "./fake-signal-cli.js";
import { startBot, type Bot } from "./helpers.js";


/** A Groups v2 ID (32 bytes) whose standard base64 contains `+` and `/`, so base64url visibly differs. */
const GROUP_ID = "+Pn6+/z9/v/4+fr7/P3+//j5+vv8/f7/+Pn6+/z9/v8=";
const GROUP_THREAD = "signal:group:-Pn6-_z9_v_4-fr7_P3-__j5-vv8_f7_-Pn6-_z9_v8";
const OTHER_GROUP_ID = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
const OTHER_GROUP_THREAD = "signal:group:BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
/** A legacy (v1) group ID: 16 bytes. */
const LEGACY_GROUP_ID = "CQkJCQkJCQkJCQkJCQkJCQ==";

type Fired = { handler: "mention" | "subscribed" | "message" | "dm"; thread: Thread; message: Message };

const bots: Bot[] = [];
afterEach(async () => {
  for (const started of bots.splice(0)) {
    await started.chat.shutdown();
    await started.fake.stop();
  }
});

/** A bot that records every handler call: mentions, subscribed threads, any new message, DMs. */
async function recordingBot() {
  const started = await startBot({ initialize: false });
  bots.push(started);
  const fired: Fired[] = [];
  const record = (handler: Fired["handler"]) => async (thread: Thread, message: Message) => {
    fired.push({ handler, thread, message });
  };
  started.chat.onNewMention(record("mention"));
  started.chat.onSubscribedMessage(record("subscribed"));
  started.chat.onNewMessage(/[\s\S]*/, record("message"));
  started.chat.onDirectMessage(record("dm"));
  await started.chat.initialize();
  return { ...started, fired };
}

describe("group Conversations", () => {
  it("maps a group envelope to signal:group:<base64url groupId>, thread ID = channel ID, and posts back to the Group", async () => {
    const { fake, chat, fired } = await recordingBot();
    fake.injectEnvelope(groupTextEnvelope({ aci: ALICE_ACI, groupId: GROUP_ID, text: "hello group", timestamp: 1_700_000_000_321 }));
    await expect.poll(() => fired.length).toBe(1);

    const [{ handler, thread, message }] = fired as [Fired];
    expect(handler).toBe("message");
    expect(thread.id).toBe(GROUP_THREAD);
    expect(thread.channelId).toBe(GROUP_THREAD);
    expect(thread.isDM).toBe(false);
    expect(message.threadId).toBe(GROUP_THREAD);
    expect(message.id).toBe(`${ALICE_ACI}:1700000000321`);
    expect(message.author.userId).toBe(ALICE_ACI);
    expect(message.isMention).toBe(false);

    const sent = await chat.thread(GROUP_THREAD).post("hi all");
    expect(fake.rpcRequests("send").map((request) => request.params)).toEqual([
      { account: BOT_ACCOUNT, groupId: GROUP_ID, message: "hi all" },
    ]);
    expect(sent.id).toBe(`${BOT_ACI}:1700000000000`);
  });

  it("fires onNewMention for a native @mention of the Bot Account", async () => {
    const { fake, fired } = await recordingBot();
    fake.injectEnvelope(
      groupTextEnvelope({ aci: ALICE_ACI, groupId: GROUP_ID, text: "￼ what's up?", mentions: [{ aci: BOT_ACI, start: 0 }] }),
    );
    await expect.poll(() => fired.length).toBe(1);

    expect(fired[0]).toMatchObject({ handler: "mention", thread: { id: GROUP_THREAD }, message: { isMention: true } });
  });

  it("fires onNewMention for a quote-reply to one of the Bot Account's messages", async () => {
    const { fake, fired } = await recordingBot();
    fake.injectEnvelope(groupTextEnvelope({ aci: ALICE_ACI, groupId: GROUP_ID, text: "and then?", quoteAuthor: BOT_ACI }));
    await expect.poll(() => fired.length).toBe(1);

    expect(fired[0]).toMatchObject({ handler: "mention", thread: { id: GROUP_THREAD }, message: { isMention: true } });
  });

  it.each([
    { kind: "the bot's name as plain text", envelope: { text: "echo-bot, @echo-bot and @echo-bot please" } },
    { kind: "the Bot Account's ACI as plain text", envelope: { text: `@${BOT_ACI} <@${BOT_ACI}>` } },
    { kind: "an @mention of someone else", envelope: { text: "￼ hi", mentions: [{ aci: BOB_ACI, start: 0 }] } },
    { kind: "a quote-reply to someone else", envelope: { text: "agreed", quoteAuthor: BOB_ACI } },
  ])("$kind is not a Mention (isMention is definite false)", async ({ envelope }) => {
    const { fake, fired } = await recordingBot();
    fake.injectEnvelope(groupTextEnvelope({ aci: ALICE_ACI, groupId: GROUP_ID, ...envelope }));
    await expect.poll(() => fired.length).toBe(1);

    expect(fired[0]).toMatchObject({ handler: "message", message: { isMention: false } });
  });

  it("finds the Bot Account anywhere in the mention list", async () => {
    const { fake, fired } = await recordingBot();
    const mentions = [{ aci: BOB_ACI, start: 0 }, { aci: BOT_ACI, start: 4 }];
    fake.injectEnvelope(groupTextEnvelope({ aci: ALICE_ACI, groupId: GROUP_ID, text: "￼ and ￼", mentions }));
    await expect.poll(() => fired.length).toBe(1);

    expect(fired[0]).toMatchObject({ handler: "mention", message: { isMention: true } });
  });

  it.each([null, "not a list", [null], [{ uuid: 5 }], [{}]])("treats malformed mentions %j as no Mention", async (mentions) => {
    const { fake, fired } = await recordingBot();
    const envelope = groupTextEnvelope({ aci: ALICE_ACI, groupId: GROUP_ID, text: "￼ hi" });
    fake.injectEnvelope({ ...envelope, dataMessage: { ...envelope.dataMessage, mentions, quote: null } });
    await expect.poll(() => fired.length).toBe(1);

    expect(fired[0]).toMatchObject({ handler: "message", message: { isMention: false } });
  });

  it("keeps each Group in its own Conversation", async () => {
    const { fake, chat, fired } = await recordingBot();
    fake.injectEnvelope(groupTextEnvelope({ aci: ALICE_ACI, groupId: GROUP_ID, text: "in one" }));
    fake.injectEnvelope(groupTextEnvelope({ aci: ALICE_ACI, groupId: OTHER_GROUP_ID, text: "in other" }));
    await expect.poll(() => fired.length).toBe(2);

    const threadByText = Object.fromEntries(fired.map(({ thread, message }) => [message.text, thread.id]));
    expect(threadByText).toEqual({ "in one": GROUP_THREAD, "in other": OTHER_GROUP_THREAD });

    await chat.thread(OTHER_GROUP_THREAD).post("only to other");
    expect(fake.rpcRequests("send").map((request) => request.params)).toEqual([
      { account: BOT_ACCOUNT, groupId: OTHER_GROUP_ID, message: "only to other" },
    ]);
  });
});

describe("envelopes that are not user input", () => {
  it("sync messages, inbound edits, inbound remote deletes and legacy-group messages trigger no handler", async () => {
    const { fake, chat, fired } = await recordingBot();
    // Subscribed, so any message reaching Chat in this Group would fire a handler, mention or not.
    await chat.thread(GROUP_THREAD).subscribe();
    const mention = groupTextEnvelope({ aci: ALICE_ACI, groupId: GROUP_ID, text: "￼ hi", mentions: [{ aci: BOT_ACI, start: 0 }] });
    const { dataMessage, ...withoutData } = mention;

    // Sent-syncs from the owner's linked devices: a group message mentioning the bot, and a 1:1 message.
    fake.injectEnvelope({
      ...withoutData,
      sourceUuid: BOT_ACI,
      syncMessage: { sentMessage: { ...dataMessage, destination: null, destinationNumber: null, destinationUuid: null } },
    });
    fake.injectEnvelope({ ...withoutData, sourceUuid: BOT_ACI, syncMessage: { sentMessage: { ...directTextEnvelope({ aci: ALICE_ACI, text: "x" }).dataMessage, destinationUuid: ALICE_ACI } } });
    // Edits: of a group message mentioning the bot, and of a 1:1 message.
    fake.injectEnvelope({ ...withoutData, editMessage: { targetSentTimestamp: 1, dataMessage } });
    fake.injectEnvelope({ ...withoutData, editMessage: { targetSentTimestamp: 1, dataMessage: directTextEnvelope({ aci: ALICE_ACI, text: "x" }).dataMessage } });
    // Remote deletes in the Group, without and with message text.
    fake.injectEnvelope({ ...mention, dataMessage: { ...dataMessage, message: null, mentions: undefined, remoteDelete: { timestamp: 1 } } });
    fake.injectEnvelope({ ...mention, dataMessage: { ...dataMessage, remoteDelete: { timestamp: 1 } } });
    // A legacy (v1) group message that mentions the bot.
    fake.injectEnvelope(
      groupTextEnvelope({ aci: ALICE_ACI, groupId: LEGACY_GROUP_ID, text: "￼ old", mentions: [{ aci: BOT_ACI, start: 0 }] }),
    );
    fake.injectEnvelope(groupTextEnvelope({ aci: BOB_ACI, groupId: GROUP_ID, text: "sentinel" }));
    await expect.poll(() => fired.length).toBe(1);

    expect(fired.map(({ handler, message }) => [handler, message.text])).toEqual([["subscribed", "sentinel"]]);
  });

  it("malformed group info, group updates, the bot's own group messages, reactions and story replies trigger no handler", async () => {
    const { fake, chat, fired } = await recordingBot();
    await chat.thread(GROUP_THREAD).subscribe();
    const mention = groupTextEnvelope({ aci: ALICE_ACI, groupId: GROUP_ID, text: "￼ hi", mentions: [{ aci: BOT_ACI, start: 0 }] });
    const withGroupInfo = (groupInfo: unknown) => ({ ...mention, dataMessage: { ...mention.dataMessage, groupInfo } });

    // Group info that names no valid Groups v2 ID must not fall back to the sender's 1:1 Conversation.
    fake.injectEnvelope(withGroupInfo({}));
    fake.injectEnvelope(withGroupInfo({ groupId: 123 }));
    fake.injectEnvelope(withGroupInfo({ groupId: `${OTHER_GROUP_ID.slice(0, -2)}d=` }));
    fake.injectEnvelope(withGroupInfo({ groupId: GROUP_ID.replaceAll("+", "-").replaceAll("/", "_") }));
    fake.injectEnvelope(groupTextEnvelope({ aci: BOT_ACI, groupId: GROUP_ID, text: "my own message" }));
    // A group update (membership or title change) carries no message text.
    fake.injectEnvelope({
      ...mention,
      dataMessage: { ...withGroupInfo({ ...mention.dataMessage.groupInfo, type: "UPDATE" }).dataMessage, message: null, mentions: undefined },
    });
    fake.injectEnvelope({ ...mention, dataMessage: { ...mention.dataMessage, reaction: { emoji: "👍", targetAuthorUuid: BOT_ACI } } });
    fake.injectEnvelope({ ...mention, dataMessage: { ...mention.dataMessage, storyContext: { authorUuid: BOT_ACI, sentTimestamp: 1 } } });
    fake.injectEnvelope(groupTextEnvelope({ aci: BOB_ACI, groupId: GROUP_ID, text: "sentinel" }));
    await expect.poll(() => fired.length).toBe(1);

    expect(fired.map(({ handler, message }) => [handler, message.text])).toEqual([["subscribed", "sentinel"]]);
  });
});

describe("parseMessage", () => {
  it("parses a group envelope; before initialize the Bot Account is unknown, so isMention is left open and its mention reads as its ACI", () => {
    const adapter = createSignalAdapter({ account: BOT_ACCOUNT, transport: { type: "http", url: "http://signal-cli:8080" } });
    const envelope = groupTextEnvelope({ aci: ALICE_ACI, groupId: GROUP_ID, text: "￼ hi", mentions: [{ aci: BOT_ACI, start: 0 }] });

    const message = adapter.parseMessage(envelope);
    expect(message).toMatchObject({ threadId: GROUP_THREAD, text: `@${BOT_ACI} hi`, author: { userId: ALICE_ACI } });
    expect(message.isMention).toBeUndefined();
  });

  it("rejects a legacy-group envelope", () => {
    const adapter = createSignalAdapter({ account: BOT_ACCOUNT, transport: { type: "http", url: "http://signal-cli:8080" } });

    expect(() => adapter.parseMessage(groupTextEnvelope({ aci: ALICE_ACI, groupId: LEGACY_GROUP_ID, text: "old" }))).toThrow(
      expect.objectContaining({ name: "ValidationError" }),
    );
  });
});

describe("group thread IDs", () => {
  const adapter = createSignalAdapter({ account: BOT_ACCOUNT, transport: { type: "http", url: "http://signal-cli:8080" } });

  it("encodes and decodes group thread IDs and reports them as non-DMs", () => {
    expect(adapter.encodeThreadId({ type: "group", groupId: GROUP_ID })).toBe(GROUP_THREAD);
    expect(adapter.decodeThreadId(GROUP_THREAD)).toEqual({ type: "group", groupId: GROUP_ID });
    expect(adapter.isDM(GROUP_THREAD)).toBe(false);
    expect(adapter.channelIdFromThreadId(GROUP_THREAD)).toBe(GROUP_THREAD);
  });

  it.each([
    ["standard base64 instead of base64url", `signal:group:${GROUP_ID}`],
    ["padding", `${GROUP_THREAD}=`],
    ["a legacy 16-byte group ID", "signal:group:CQkJCQkJCQkJCQkJCQkJCQ"],
    ["a 33-byte ID", `signal:group:${Buffer.alloc(33, 7).toString("base64url")}`],
    ["a non-canonical last character", `${OTHER_GROUP_THREAD.slice(0, -1)}d`],
    ["trailing text", `${GROUP_THREAD}:extra`],
    ["no ID", "signal:group:"],
  ])("rejects a group thread ID with %s", (_case, threadId) => {
    expect(() => adapter.decodeThreadId(threadId)).toThrow(ValidationError);
    expect(() => adapter.isDM(threadId)).toThrow(ValidationError);
  });

  it.each([LEGACY_GROUP_ID, GROUP_ID.replace("=", ""), "not base64!"])("refuses to encode group ID %j", (groupId) => {
    expect(() => adapter.encodeThreadId({ type: "group", groupId })).toThrow(ValidationError);
  });
});
