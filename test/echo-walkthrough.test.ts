import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat } from "chat";
import { afterEach, expect, it, vi } from "vitest";
import { createSignalAdapter, type SignalTransportConfig } from "../src/index.js";
import { fakeSignalCliOnPath } from "./helpers.js";
import { ALICE_ACI, BOB_ACI, BOT_ACCOUNT, BOT_ACI, directTextEnvelope, FakeSignalCli, groupTextEnvelope } from "./fake-signal-cli.js";


let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.unstubAllEnvs();
});

/** Points a transport of each kind at the fake signal-cli; spawn runs the fake `signal-cli` from PATH. */
const transports: Record<SignalTransportConfig["type"], (signalCli: FakeSignalCli, dir: string) => Promise<SignalTransportConfig>> = {
  http: async (signalCli) => ({ type: "http", url: signalCli.url }),
  socket: async (signalCli, dir) => {
    const path = join(dir, "signal-cli.sock");
    await signalCli.listenSocket(path);
    return { type: "socket", path };
  },
  tcp: async (signalCli) => ({ type: "tcp", host: "127.0.0.1", port: await signalCli.listenTcp() }),
  spawn: async (signalCli) => {
    await fakeSignalCliOnPath(signalCli);
    return { type: "spawn" };
  },
};

/**
 * Walkthrough for a Host App developer: wire the adapter exactly as the
 * README would, start the bot, have a user DM it, and read back from
 * signal-cli what the bot actually sent. Runs once per transport.
 */
it.each(Object.keys(transports) as SignalTransportConfig["type"][])(
  "echo bot over %s: a user's 1:1 message is echoed back to that user",
  async (type) => {
    const signalCli = await FakeSignalCli.start();
    const dir = await mkdtemp(join(tmpdir(), "signal-walkthrough-"));

    const chat = new Chat({
      userName: "echo-bot",
      adapters: {
        signal: createSignalAdapter({ account: BOT_ACCOUNT, transport: await transports[type](signalCli, dir) }),
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
      await rm(dir, { recursive: true, force: true });
    };

    signalCli.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, number: "+15551230001", name: "Alice", text: "ping" }));
    await expect.poll(() => replies.length).toBe(1);

    expect(signalCli.rpcRequests("send").map((request) => request.params)).toEqual([
      { account: BOT_ACCOUNT, recipient: [ALICE_ACI], message: "echo: ping" },
    ]);
    expect(replies).toEqual([`${BOT_ACI}:1700000000000`]);
    if (type === "spawn") {
      expect(signalCli.spawns.map((spawn) => spawn.argv)).toEqual([["-a", BOT_ACCOUNT, "jsonRpc"]]);
    }
  },
);

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
