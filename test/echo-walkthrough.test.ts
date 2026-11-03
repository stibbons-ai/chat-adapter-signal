import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat, stringifyMarkdown } from "chat";
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
    await thread.post(`echo: ${message.text}`);
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
  expect(answered).toEqual(["@echo-bot ping", "pong?"]);
});

/**
 * Walkthrough for a user who formats their message, and a bot that answers in
 * markdown: the user's styles reach the handler as markdown, the handler
 * echoes that markdown back with a heading and a list, and signal-cli is
 * asked to send the same styles (offsets past an emoji) plus the reply's own.
 */
it("formatting bot: a styled message comes in as markdown and goes back out with Signal text styles", async () => {
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
  const received: string[] = [];
  chat.onDirectMessage(async (thread, message) => {
    const markdown = stringifyMarkdown(message.formatted).trim();
    received.push(markdown);
    await thread.post({ markdown: `## You said\n\n- ${markdown}\n- ||nothing else||` });
  });
  await chat.initialize();
  cleanup = async () => {
    await chat.shutdown();
    await signalCli.stop();
  };

  const envelope = directTextEnvelope({ aci: ALICE_ACI, text: "🎉 big news, see run.sh" });
  signalCli.injectEnvelope({
    ...envelope,
    dataMessage: {
      ...envelope.dataMessage,
      textStyles: [
        { style: "BOLD", start: 3, length: 8 },
        { style: "MONOSPACE", start: 17, length: 6 },
      ],
    },
  });
  await expect.poll(() => received.length).toBe(1);

  expect(received).toEqual(["🎉 **big news**, see `run.sh`"]);
  expect(signalCli.rpcRequests("send").map((request) => request.params)).toEqual([
    {
      account: BOT_ACCOUNT,
      recipient: [ALICE_ACI],
      message: "You said\n\n• 🎉 big news, see run.sh\n• nothing else",
      textStyle: ["0:8:BOLD", "15:8:BOLD", "29:6:MONOSPACE", "38:12:SPOILER"],
    },
  ]);
});

/**
 * Walkthrough for a bot operator: the echo bot keeps answering through a
 * network drop, a signal-cli restart, and a Host App restart (same state store,
 * as Redis would be), and every message is answered exactly once. Read back
 * from signal-cli what the bot actually sent.
 */
it("echo bot: survives drops and restarts without losing or repeating replies", async () => {
  const signalCli = await FakeSignalCli.start();
  const state = createMemoryState(); // stands in for a persistent store: its values outlive chat.shutdown()
  const startHostApp = async () => {
    const chat = new Chat({
      userName: "echo-bot",
      adapters: {
        signal: createSignalAdapter({
          account: BOT_ACCOUNT,
          transport: { type: "http", url: signalCli.url },
          reconnect: { minDelayMs: 5, maxDelayMs: 50 },
        }),
      },
      state,
      concurrency: "queue",
      logger: "silent",
    });
    chat.onDirectMessage(async (thread, message) => {
      await thread.post(`echo: ${message.text}`);
    });
    await chat.initialize();
    return chat;
  };
  const sent = () => signalCli.rpcRequests("send").map((request) => request.params?.message);
  const alice = (text: string) => signalCli.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text }));

  let chat = await startHostApp();
  cleanup = async () => {
    await chat.shutdown();
    await signalCli.stop();
  };
  alice("one");
  await expect.poll(sent).toEqual(["echo: one"]);

  // Network drop: Alice writes while the bot is disconnected.
  signalCli.closeEventStreams();
  await signalCli.eventStreamsClosed();
  alice("two");
  await expect.poll(sent).toEqual(["echo: one", "echo: two"]);

  // signal-cli restarts; Alice writes before the bot has reconnected.
  signalCli.restartDaemon();
  alice("three");
  await expect.poll(sent).toEqual(["echo: one", "echo: two", "echo: three"]);

  // Host App restart: Alice writes while it is down.
  await chat.shutdown();
  alice("four");
  chat = await startHostApp();
  await expect.poll(sent).toEqual(["echo: one", "echo: two", "echo: three", "echo: four"]);

  // Nothing is answered twice, even after replays settle.
  alice("five");
  await expect.poll(sent).toHaveLength(5);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(sent()).toEqual(["echo: one", "echo: two", "echo: three", "echo: four", "echo: five"]);
});
