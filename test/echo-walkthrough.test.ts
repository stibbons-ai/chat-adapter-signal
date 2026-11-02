import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat } from "chat";
import { afterEach, expect, it } from "vitest";
import { createSignalAdapter } from "../src/index.js";
import { ALICE_ACI, BOB_ACI, BOT_ACCOUNT, BOT_ACI, directTextEnvelope, FakeSignalCli, groupTextEnvelope } from "./fake-signal-cli.js";


let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

/**
 * Walkthrough for a Host App developer: wire the adapter exactly as the
 * README would, start the bot, have a user DM it, and read back from
 * signal-cli what the bot actually sent.
 */
it("echo bot: a user's 1:1 message is echoed back to that user", async () => {
  const signalCli = await FakeSignalCli.start();

  const chat = new Chat({
    userName: "echo-bot",
    adapters: {
      signal: createSignalAdapter({ account: BOT_ACCOUNT, transport: { type: "http", url: signalCli.url } }),
    },
    state: createMemoryState(),
    concurrency: "queue",
    logger: "silent",
  });
  const replies: string[] = [];
  chat.onDirectMessage(async (thread, message) => {
    const sent = await thread.post(`echo: ${message.text}`);
    replies.push(sent.id);
  });
  await chat.initialize();
  cleanup = async () => {
    await chat.shutdown();
    await signalCli.stop();
  };

  signalCli.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, number: "+15551230001", name: "Alice", text: "ping" }));
  await expect.poll(() => replies.length).toBe(1);

  expect(signalCli.rpcRequests("send").map((request) => request.params)).toEqual([
    { account: BOT_ACCOUNT, recipient: [ALICE_ACI], message: "echo: ping" },
  ]);
  expect(replies).toEqual([`${BOT_ACI}:1700000000000`]);
});

/**
 * Walkthrough for a group member: chatter without a Mention leaves the bot
 * quiet; an @mention gets a reply in the Group, and so does a later
 * quote-reply to that answer. Read back from signal-cli what went out.
 */
it("group bot: answers in the Group only when mentioned or quote-replied to", async () => {
  const signalCli = await FakeSignalCli.start();
  const groupId = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";

  const chat = new Chat({
    userName: "echo-bot",
    adapters: {
      signal: createSignalAdapter({ account: BOT_ACCOUNT, transport: { type: "http", url: signalCli.url } }),
    },
    state: createMemoryState(),
    concurrency: "queue",
    logger: "silent",
  });
  const answered: string[] = [];
  chat.onNewMention(async (thread, message) => {
    await thread.post(`echo: ${message.text.replace("￼", "@echo-bot")}`);
    answered.push(message.text);
  });
  await chat.initialize();
  cleanup = async () => {
    await chat.shutdown();
    await signalCli.stop();
  };

  signalCli.injectEnvelope(groupTextEnvelope({ aci: BOB_ACI, groupId, text: "lunch, echo-bot?" }));
  signalCli.injectEnvelope(groupTextEnvelope({ aci: ALICE_ACI, groupId, text: "￼ ping", mentions: [{ aci: BOT_ACI, start: 0 }] }));
  await expect.poll(() => answered.length).toBe(1);
  signalCli.injectEnvelope(groupTextEnvelope({ aci: BOB_ACI, groupId, text: "pong?", quoteAuthor: BOT_ACI }));
  await expect.poll(() => answered.length).toBe(2);

  expect(signalCli.rpcRequests("send").map((request) => request.params)).toEqual([
    { account: BOT_ACCOUNT, groupId, message: "echo: @echo-bot ping" },
    { account: BOT_ACCOUNT, groupId, message: "echo: pong?" },
  ]);
  expect(answered).toEqual(["￼ ping", "pong?"]);
});
