import { ResourceNotFoundError, ValidationError } from "@chat-adapter/shared";
import type { Message, Thread } from "chat";
import { afterEach, describe, expect, it } from "vitest";
import { ALICE_ACI, BOB_ACI, BOT_ACCOUNT, BOT_ACI, directTextEnvelope, groupTextEnvelope } from "./fake-signal-cli.js";
import { startBot, type Bot } from "./helpers.js";

const ALICE_DM = `signal:dm:${ALICE_ACI}`;
const BOB_DM = `signal:dm:${BOB_ACI}`;
const ALICE_NUMBER = "+15550001111";
const GROUP_ID = "+Pn6+/z9/v/4+fr7/P3+//j5+vv8/f7/+Pn6+/z9/v8=";
const GROUP_THREAD = "signal:group:-Pn6-_z9_v_4-fr7_P3-__j5-vv8_f7_-Pn6-_z9_v8";
const CAROL_ACI = "c0c0c0c0-0000-4000-8000-00000000c0c0";

/** Alice as signal-cli 0.14.9 `listContacts` prints her: profile name only, no contact entry. */
const ALICE_CONTACT = {
  number: ALICE_NUMBER,
  uuid: ALICE_ACI,
  username: "alice.01",
  name: "",
  givenName: null,
  familyName: null,
  nickGivenName: null,
  nickFamilyName: null,
  profile: { lastUpdateTimestamp: 1_700_000_000_000, givenName: "Alice", familyName: "Liddell", about: null },
};

const bots: Bot[] = [];
afterEach(async () => {
  for (const started of bots.splice(0)) {
    await started.chat.shutdown();
    await started.fake.stop();
  }
});

/** An echo bot (`echo: <text>` back into the Conversation) that records each message its handlers got. */
async function echoBot() {
  const started = await startBot({ initialize: false });
  bots.push(started);
  const handled: Array<{ thread: Thread; message: Message }> = [];
  const echo = async (thread: Thread, message: Message) => {
    await thread.post(`echo: ${message.text}`);
    handled.push({ thread, message });
  };
  started.chat.onDirectMessage(echo);
  started.chat.onNewMessage(/[\s\S]*/, echo);
  await started.chat.initialize();
  return { ...started, handled };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

describe("fetchMessages", () => {
  it("returns each Conversation's messages received and posted since the bot started, oldest first", async () => {
    const { fake, adapter, chat, handled } = await echoBot();
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "one", name: "Alice", timestamp: 1_700_000_000_001 }));
    await expect.poll(() => handled.length).toBe(1);
    fake.injectEnvelope(directTextEnvelope({ aci: BOB_ACI, text: "bob here" }));
    await expect.poll(() => handled.length).toBe(2);
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "two" }));
    await expect.poll(() => handled.length).toBe(3);
    fake.injectEnvelope(groupTextEnvelope({ aci: ALICE_ACI, groupId: GROUP_ID, text: "in the group" }));
    await expect.poll(() => handled.length).toBe(4);

    const { messages, nextCursor } = await adapter.fetchMessages(ALICE_DM);
    expect(nextCursor).toBeUndefined();
    // Chat records the bot's own posts with its `"self"` author convention, `isMe: true`.
    expect(messages.map((message) => [message.author.userId, message.author.isMe, message.text])).toEqual([
      [ALICE_ACI, false, "one"],
      ["self", true, "echo: one"],
      [ALICE_ACI, false, "two"],
      ["self", true, "echo: two"],
    ]);
    expect(messages[0]).toMatchObject({
      id: `${ALICE_ACI}:1700000000001`,
      threadId: ALICE_DM,
      author: { fullName: "Alice" },
      metadata: { dateSent: new Date(1_700_000_000_001) },
    });
    expect(messages[1]?.id).toMatch(new RegExp(`^${BOT_ACI}:\\d+$`));

    expect((await adapter.fetchMessages(BOB_DM)).messages.map((message) => message.text)).toEqual(["bob here", "echo: bob here"]);
    expect((await adapter.fetchMessages(GROUP_THREAD)).messages.map((message) => message.text)).toEqual([
      "in the group",
      "echo: in the group",
    ]);
    // What handlers read: Chat's thread iterators go through fetchMessages.
    expect((await collect(chat.thread(ALICE_DM).messages)).map((message) => message.text)).toEqual([
      "echo: two",
      "two",
      "echo: one",
      "one",
    ]);
    expect((await chat.history.thread.list(ALICE_DM, { limit: 1 })).messages.map((message) => message.text)).toEqual(["echo: two"]);
  });

  it("pages backward from the newest and forward from the oldest with message-ID cursors", async () => {
    const { fake, adapter, handled } = await echoBot();
    for (const text of ["a", "b"]) {
      fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text }));
      await expect.poll(() => handled.length).toBe(text === "a" ? 1 : 2);
    }
    const texts = (result: { messages: Message[] }) => result.messages.map((message) => message.text);

    const newest = await adapter.fetchMessages(ALICE_DM, { limit: 3 });
    expect(texts(newest)).toEqual(["echo: a", "b", "echo: b"]);
    expect(newest.nextCursor).toBe(newest.messages[0]?.id);
    const older = await adapter.fetchMessages(ALICE_DM, { limit: 3, cursor: newest.nextCursor! });
    expect(texts(older)).toEqual(["a"]);
    expect(older.nextCursor).toBeUndefined();

    const oldest = await adapter.fetchMessages(ALICE_DM, { limit: 3, direction: "forward" });
    expect(texts(oldest)).toEqual(["a", "echo: a", "b"]);
    const newer = await adapter.fetchMessages(ALICE_DM, { limit: 3, direction: "forward", cursor: oldest.nextCursor! });
    expect(texts(newer)).toEqual(["echo: b"]);
    expect(newer.nextCursor).toBeUndefined();

    expect(await adapter.fetchMessages(ALICE_DM, { cursor: `${ALICE_ACI}:1` })).toEqual({ messages: [] });
  });

  it("rejects an invalid thread ID", async () => {
    const { adapter } = await echoBot();
    await expect(adapter.fetchMessages("signal:dm:not-an-aci")).rejects.toThrow(ValidationError);
  });
});

describe("fetchThread", () => {
  it("describes a 1:1 Conversation by the user's ACI and the name Signal shows for them", async () => {
    const { fake, adapter } = await echoBot();
    fake.contacts.push(ALICE_CONTACT);

    expect(await adapter.fetchThread(ALICE_DM)).toEqual({
      id: ALICE_DM,
      channelId: ALICE_DM,
      isDM: true,
      channelName: "Alice Liddell",
      metadata: { aci: ALICE_ACI },
    });
    expect(fake.rpcRequests("listContacts").at(-1)?.params).toEqual({
      account: BOT_ACCOUNT,
      recipient: [ALICE_ACI],
      allRecipients: true,
    });
  });

  it("describes a Group by name, description and member ACIs, without phone numbers", async () => {
    const { fake, adapter } = await echoBot();
    fake.groups.push({
      id: GROUP_ID,
      name: "Book club",
      description: "Monthly reads",
      isMember: true,
      members: [
        { number: ALICE_NUMBER, uuid: ALICE_ACI, isAdmin: true },
        { number: BOT_ACCOUNT, uuid: BOT_ACI, isAdmin: false },
        { number: "+15550002222", uuid: null, isAdmin: false },
      ],
    });

    expect(await adapter.fetchThread(GROUP_THREAD)).toEqual({
      id: GROUP_THREAD,
      channelId: GROUP_THREAD,
      isDM: false,
      channelName: "Book club",
      metadata: { groupId: GROUP_ID, description: "Monthly reads", members: [ALICE_ACI, BOT_ACI] },
    });
    expect(fake.rpcRequests("listGroups").map((request) => request.params)).toEqual([
      { account: BOT_ACCOUNT, groupId: [GROUP_ID] },
    ]);
  });

  it("throws ResourceNotFoundError for a Group the Bot Account is not in, and ValidationError for an invalid ID", async () => {
    const { adapter } = await echoBot();
    await expect(adapter.fetchThread(GROUP_THREAD)).rejects.toThrow(ResourceNotFoundError);
    await expect(adapter.fetchThread("signal:group:abc")).rejects.toThrow(ValidationError);
  });
});

describe("getUser", () => {
  it("returns user info keyed by ACI, named the way message authors are", async () => {
    const { fake, adapter, handled } = await echoBot();
    fake.contacts.push(ALICE_CONTACT);
    fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "hi", number: ALICE_NUMBER, name: "Alice Liddell" }));
    await expect.poll(() => handled.length).toBe(1);
    const { author } = handled[0]!.message;

    const user = await adapter.getUser(ALICE_ACI.toUpperCase());
    expect(user).toEqual({ userId: ALICE_ACI, userName: ALICE_ACI, fullName: "Alice Liddell", isBot: false });
    expect(user).toMatchObject({ userId: author.userId, userName: author.userName, fullName: author.fullName });
    expect(await adapter.getUser(BOT_ACI)).toMatchObject({ userId: BOT_ACI, isBot: true });
  });

  it("names a user by nickname, then contact name, then profile name, then number, like signal-cli's sourceName", async () => {
    const { fake, adapter } = await echoBot();
    const base = { username: null, name: "", nickGivenName: null, nickFamilyName: null, profile: null };
    const acis = ["10000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002", "30000000-0000-4000-8000-000000000003"];
    fake.contacts.push(
      { ...base, number: null, uuid: acis[0]!, name: "Contact Name", nickGivenName: "Nick", profile: { givenName: "Pro" } },
      { ...base, number: null, uuid: acis[1]!, name: "Contact Name", profile: { givenName: "Pro", familyName: "File" } },
      { ...base, number: "+15550003333", uuid: acis[2]!, profile: { givenName: null, familyName: null } },
    );

    const names = await Promise.all(acis.map(async (aci) => (await adapter.getUser(aci))?.fullName));
    expect(names).toEqual(["Nick", "Contact Name", "+15550003333"]);
  });

  it("returns null for an ACI signal-cli does not know and rejects anything but an ACI", async () => {
    const { fake, adapter } = await echoBot();
    expect(await adapter.getUser(CAROL_ACI)).toBeNull();
    const lookups = fake.rpcRequests("listContacts").length;
    await expect(adapter.getUser(ALICE_NUMBER)).rejects.toThrow(ValidationError);
    expect(fake.rpcRequests("listContacts")).toHaveLength(lookups);
  });
});

describe("openDM", () => {
  it("opens the 1:1 Conversation for an ACI in any case, without asking signal-cli", async () => {
    const { fake, adapter } = await echoBot();
    const lookups = fake.rpcRequests("listContacts").length;
    expect(await adapter.openDM(ALICE_ACI.toUpperCase().replaceAll("-", ""))).toBe(ALICE_DM);
    expect(fake.rpcRequests("listContacts")).toHaveLength(lookups);
  });

  it("resolves a phone number or u:username to the user's ACI through signal-cli", async () => {
    const { fake, adapter } = await echoBot();
    fake.contacts.push(ALICE_CONTACT);

    expect(await adapter.openDM(ALICE_NUMBER)).toBe(ALICE_DM);
    expect(await adapter.openDM("u:alice.01")).toBe(ALICE_DM);
    expect(fake.rpcRequests("listContacts").slice(-2).map((request) => request.params)).toEqual([
      { account: BOT_ACCOUNT, recipient: [ALICE_NUMBER], allRecipients: true },
      { account: BOT_ACCOUNT, recipient: ["u:alice.01"], allRecipients: true },
    ]);
  });

  it("throws ResourceNotFoundError when signal-cli finds no ACI for the number or username", async () => {
    const { fake, adapter } = await echoBot();
    // A number Signal knows only by its PNI (its owner never shared a profile with the bot).
    fake.contacts.push({ number: "+15550004444", uuid: null, username: null, name: "" });

    await expect(adapter.openDM("+15550004444")).rejects.toThrow(ResourceNotFoundError);
    await expect(adapter.openDM("+15559999999")).rejects.toThrow(ResourceNotFoundError);
    await expect(adapter.openDM("u:nobody.99")).rejects.toThrow(ResourceNotFoundError);
  });
});

/**
 * Walkthrough for a bot developer: a user DMs the bot; a handler reads the
 * Conversation's history and the user's name, then the bot proactively opens a
 * DM with another user by phone number and posts there. Read back from
 * signal-cli what went out and from the bot what history it recorded.
 */
it("walkthrough: a handler reads history and user info, then the bot starts a DM by phone number", async () => {
  const started = await startBot({ initialize: false });
  bots.push(started);
  const { fake, adapter, chat } = started;
  fake.contacts.push(ALICE_CONTACT, {
    number: "+15550005555",
    uuid: BOB_ACI,
    username: null,
    name: "Bob",
    nickGivenName: null,
    nickFamilyName: null,
    profile: null,
  });
  let replies = 0;
  chat.onDirectMessage(async (thread, message) => {
    const history = await collect(thread.allMessages);
    const user = await adapter.getUser(message.author.userId);
    await thread.post(`${user?.fullName}, this Conversation has ${history.length} message(s)`);
    replies++;
  });
  await chat.initialize();

  fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "hello", name: "Alice Liddell" }));
  await expect.poll(() => replies).toBe(1);
  fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "again", name: "Alice Liddell" }));
  await expect.poll(() => replies).toBe(2);

  const bobDm = chat.thread(await adapter.openDM("+15550005555"));
  expect(bobDm.isDM).toBe(true);
  await bobDm.post("Alice says hi");

  expect(fake.rpcRequests("send").map((request) => request.params)).toEqual([
    { account: BOT_ACCOUNT, recipient: [ALICE_ACI], message: "Alice Liddell, this Conversation has 1 message(s)" },
    { account: BOT_ACCOUNT, recipient: [ALICE_ACI], message: "Alice Liddell, this Conversation has 3 message(s)" },
    { account: BOT_ACCOUNT, recipient: [BOB_ACI], message: "Alice says hi" },
  ]);
  expect((await adapter.fetchMessages(BOB_DM)).messages.map((message) => [message.author.isMe, message.text])).toEqual([
    [true, "Alice says hi"],
  ]);
  expect(await adapter.fetchThread(BOB_DM)).toMatchObject({ isDM: true, channelName: "Bob", metadata: { aci: BOB_ACI } });
});
