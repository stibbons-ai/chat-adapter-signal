import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat } from "chat";
import { afterEach, expect, it } from "vitest";
import { createSignalAdapter } from "../src/index.js";
import { BOT_ACCOUNT, BOT_ACI, directTextEnvelope, FakeSignalCli } from "./fake-signal-cli.js";

const ALICE_ACI = "a1b2c3d4-0000-4000-8000-00000000a11c";

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
