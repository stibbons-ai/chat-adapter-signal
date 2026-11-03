import { ValidationError } from "@chat-adapter/shared";
import type { StreamChunk } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignalAdapterConfig } from "../src/index.js";
import { ALICE_ACI, BOT_ACCOUNT, BOT_ACI, directTextEnvelope, FakeSignalCli } from "./fake-signal-cli.js";
import { startBot, type Bot } from "./helpers.js";

const ALICE_DM = `signal:dm:${ALICE_ACI}`;
const GROUP_ID = "+Pn6+/z9/v/4+fr7/P3+//j5+vv8/f7/+Pn6+/z9/v8=";
const GROUP_THREAD = "signal:group:-Pn6-_z9_v_4-fr7_P3-__j5-vv8_f7_-Pn6-_z9_v8";
const TYPING = { account: BOT_ACCOUNT, recipient: [ALICE_ACI] };
const TYPING_STOP = { ...TYPING, stop: true };
/** Signal's per-message limit: 64 KiB of UTF-8. */
const LIMIT = 64 * 1024;

const bots: Bot[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const started of bots.splice(0)) {
    await started.chat.shutdown();
    await started.fake.stop();
  }
});

/**
 * A started bot on the TCP transport with fake timers and clock, so typing refreshes can be
 * stepped through. One connection carries every request in order, which `advance` relies on.
 */
async function bot(config: Partial<SignalAdapterConfig> = {}): Promise<Bot> {
  const fake = await FakeSignalCli.start();
  const port = await fake.listenTcp();
  const transport = { type: "tcp" as const, host: "127.0.0.1", port };
  const started = await startBot({ fake, config: { account: BOT_ACCOUNT, transport, ...config } });
  bots.push(started);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  return started;
}

/**
 * Moves the fake clock on by `ms` in steps of at most 1 s. After each step a round trip to
 * signal-cli on the same connection proves every request sent until then has arrived.
 */
async function advance(started: Bot, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 1_000) {
    await vi.advanceTimersByTimeAsync(Math.min(left, 1_000));
    await started.adapter.getUser(ALICE_ACI);
  }
}

/** The typing and send requests that reached signal-cli, in order, as `[method, params]`. */
function outbound(started: Bot): Array<[string, unknown]> {
  return started.fake
    .rpcRequests()
    .filter((request) => request.method === "sendTyping" || request.method === "send")
    .map((request) => [request.method, request.params]);
}

/** A text stream whose chunks arrive `gapMs` apart on the fake clock, or at once for 0. */
async function* slowStream(chunks: Array<string | StreamChunk>, gapMs = 0): AsyncIterable<string | StreamChunk> {
  for (const chunk of chunks) {
    if (gapMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, gapMs));
    }
    yield chunk;
  }
}

describe("startTyping", () => {
  it("sends Signal's typing indicator and re-sends it every 10 s, before clients drop it after 15 s", async () => {
    const started = await bot();

    await started.chat.thread(ALICE_DM).startTyping();
    expect(outbound(started)).toEqual([["sendTyping", TYPING]]);

    await advance(started, 9_999);
    expect(outbound(started)).toHaveLength(1);
    await advance(started, 1);
    expect(outbound(started)).toEqual([
      ["sendTyping", TYPING],
      ["sendTyping", TYPING],
    ]);
    await advance(started, 10_000);
    expect(outbound(started)).toHaveLength(3);
  });

  it("types into a Group by its group ID", async () => {
    const started = await bot();

    await started.chat.thread(GROUP_THREAD).startTyping();

    expect(outbound(started)).toEqual([["sendTyping", { account: BOT_ACCOUNT, groupId: GROUP_ID }]]);
  });

  it("stops refreshing once the bot posts, without a STOP: the message clears the indicator", async () => {
    const started = await bot();
    const thread = started.chat.thread(ALICE_DM);

    await thread.startTyping();
    await advance(started, 10_000);
    await thread.post("done");
    await advance(started, 60_000);

    expect(outbound(started)).toEqual([
      ["sendTyping", TYPING],
      ["sendTyping", TYPING],
      ["send", { ...TYPING, message: "done" }],
    ]);
  });

  it("stops refreshing after a post that bypasses Chat's thread (adapter.postMessage)", async () => {
    const started = await bot();

    await started.chat.thread(ALICE_DM).startTyping();
    await started.adapter.postMessage(ALICE_DM, "done");
    await advance(started, 60_000);

    expect(outbound(started).map(([method]) => method)).toEqual(["sendTyping", "send"]);
  });

  it("a post waits for a refresh already on its way, so the indicator cannot follow the message", async () => {
    const started = await bot();
    await started.chat.thread(ALICE_DM).startTyping();
    const release = started.fake.hold("sendTyping");
    await advance(started, 10_000);

    const posting = started.adapter.postMessage(ALICE_DM, "done");
    await advance(started, 1_000);
    expect(started.fake.rpcRequests("send")).toHaveLength(0);
    release();
    await posting;

    expect(outbound(started).map(([method]) => method)).toEqual(["sendTyping", "sendTyping", "send"]);
  });

  it("a post waits for the first indicator still on its way (an unawaited startTyping), then stops refreshing", async () => {
    const started = await bot();
    const release = started.fake.holdNext("sendTyping");

    const typing = started.chat.thread(ALICE_DM).startTyping();
    const posting = started.adapter.postMessage(ALICE_DM, "done");
    await advance(started, 1_000);
    expect(started.fake.rpcRequests("send")).toHaveLength(0);
    release();
    await Promise.all([typing, posting]);
    await advance(started, 60_000);

    expect(outbound(started).map(([method]) => method)).toEqual(["sendTyping", "send"]);
  });

  it("sends a STOP when the post fails, as no message clears the indicator then", async () => {
    const started = await bot();
    const thread = started.chat.thread(ALICE_DM);
    await thread.startTyping();
    started.fake.failRpc("send", { code: -1, message: "Failed to send message" });

    await expect(thread.post("done")).rejects.toThrow();

    expect(outbound(started)).toEqual([
      ["sendTyping", TYPING],
      ["send", { ...TYPING, message: "done" }],
      ["sendTyping", TYPING_STOP],
    ]);
  });

  it("endTyping sends a STOP and ends the refresh; without active typing it sends nothing", async () => {
    const started = await bot();

    await started.adapter.startTyping(ALICE_DM);
    await started.adapter.endTyping(ALICE_DM);
    await started.adapter.endTyping(ALICE_DM);
    await advance(started, 60_000);

    expect(outbound(started)).toEqual([
      ["sendTyping", TYPING],
      ["sendTyping", TYPING_STOP],
    ]);
  });

  it("gives up refreshing after 2 minutes without a post, so a failed handler does not type forever", async () => {
    const started = await bot();

    await started.adapter.startTyping(ALICE_DM);
    await advance(started, 5 * 60_000);

    // At 0 s, 10 s, ..., 120 s; the last one fades on its own.
    expect(started.fake.rpcRequests("sendTyping")).toHaveLength(13);
    await started.adapter.endTyping(ALICE_DM);
    expect(started.fake.rpcRequests("sendTyping")).toHaveLength(13);
  });

  it("after the 2 minutes, endTyping still stops the last indicator until it fades", async () => {
    const started = await bot();

    await started.adapter.startTyping(ALICE_DM);
    await advance(started, 125_000);
    await started.adapter.endTyping(ALICE_DM);

    expect(outbound(started).slice(12)).toEqual([
      ["sendTyping", TYPING],
      ["sendTyping", TYPING_STOP],
    ]);
  });

  it("15 s after the last indicator it has faded: endTyping then sends nothing", async () => {
    const started = await bot();

    await started.adapter.startTyping(ALICE_DM);
    await advance(started, 136_000);
    await started.adapter.endTyping(ALICE_DM);

    expect(started.fake.rpcRequests("sendTyping")).toHaveLength(13);
  });

  it("after the 2 minutes, startTyping shows a new indicator and refreshes it again", async () => {
    const started = await bot();

    await started.adapter.startTyping(ALICE_DM);
    await advance(started, 125_000);
    await started.adapter.startTyping(ALICE_DM);
    await advance(started, 30_000);

    // 0 s ... 120 s, then 125 s, 135 s, 145 s, 155 s.
    expect(started.fake.rpcRequests("sendTyping")).toHaveLength(17);
  });

  it("sends no STOP for a failed post when the bot was not typing", async () => {
    const started = await bot();
    started.fake.failRpc("send", { code: -1, message: "Failed to send message" });

    await expect(started.chat.thread(ALICE_DM).post("done")).rejects.toThrow();

    expect(outbound(started).map(([method]) => method)).toEqual(["send"]);
  });

  it("a repeated startTyping extends the 2 minutes without sending a second indicator", async () => {
    const started = await bot();

    await started.adapter.startTyping(ALICE_DM);
    await advance(started, 55_000);
    await started.adapter.startTyping(ALICE_DM);

    // 0 s, 10 s, ..., 50 s: the indicator is still up, so none at 55 s.
    expect(started.fake.rpcRequests("sendTyping")).toHaveLength(6);
    await advance(started, 5 * 60_000);
    // ... then up to 170 s, within 2 minutes of the second call.
    expect(started.fake.rpcRequests("sendTyping")).toHaveLength(18);
  });

  it("rejects when signal-cli refuses the indicator, and does not refresh it", async () => {
    const started = await bot();
    started.fake.failRpc("sendTyping", { code: -1, message: "Failed to send message" });

    await expect(started.adapter.startTyping(ALICE_DM)).rejects.toThrow();
    await advance(started, 60_000);

    expect(started.fake.rpcRequests("sendTyping")).toHaveLength(1);
  });

  it("shows the indicator again on the next startTyping after a failed one", async () => {
    const started = await bot();
    started.fake.failRpc("sendTyping", { code: -1, message: "Failed to send message" });
    await expect(started.adapter.startTyping(ALICE_DM)).rejects.toThrow();
    started.fake.clearRpcFailure("sendTyping");

    await started.adapter.startTyping(ALICE_DM);
    await advance(started, 10_000);

    expect(started.fake.rpcRequests("sendTyping")).toHaveLength(3);
  });

  it("a second startTyping while the first indicator is on its way shares its failure", async () => {
    const started = await bot();
    started.fake.failRpc("sendTyping", { code: -1, message: "Failed to send message" });
    const release = started.fake.holdNext("sendTyping");

    const first = started.adapter.startTyping(ALICE_DM);
    const second = started.adapter.startTyping(ALICE_DM);
    release();

    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
    expect(started.fake.rpcRequests("sendTyping")).toHaveLength(1);
  });

  it("keeps refreshing after a failed refresh and logs it", async () => {
    const started = await bot();
    await started.adapter.startTyping(ALICE_DM);
    started.fake.failRpc("sendTyping", { code: -1, message: "Failed to send message" });

    await advance(started, 20_000);

    expect(started.fake.rpcRequests("sendTyping")).toHaveLength(3);
    expect(started.logger.entries.filter((entry) => entry.level === "warn").map((entry) => entry.message)).toContain(
      "Could not refresh a Signal typing indicator",
    );
  });

  it("keeps a stream that is still answering during shutdown typing until it posts", async () => {
    const started = await bot({ drainTimeoutMs: 60_000 });
    started.chat.onDirectMessage(async (thread) => {
      await thread.post(slowStream(["still ", "thinking"], 6_000));
    });
    started.fake.injectEnvelope(directTextEnvelope({ aci: ALICE_ACI, text: "hi" }));
    await vi.waitFor(() => expect(started.fake.rpcRequests("sendTyping")).toHaveLength(1));

    // Shutdown closes the receive connection, so no `advance` round trips: step the clock and wait for arrivals.
    const shutdown = started.chat.shutdown();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(started.fake.rpcRequests("sendTyping")).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(2_000);
    await shutdown;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(outbound(started)).toEqual([
      ["sendTyping", TYPING],
      ["sendTyping", TYPING],
      ["send", { ...TYPING, message: "still thinking" }],
    ]);
  });

  it("stops every refresh on disconnect", async () => {
    const started = await bot();
    await started.adapter.startTyping(ALICE_DM);

    await started.chat.shutdown();
    await vi.advanceTimersByTimeAsync(60_000);
    // A request after shutdown reopens the connection, behind any refresh sent meanwhile.
    await started.adapter.getUser(ALICE_ACI);

    expect(started.fake.rpcRequests("sendTyping")).toHaveLength(1);
  });

  it("rejects an invalid thread ID", async () => {
    const started = await bot();

    await expect(started.adapter.startTyping("signal:dm:nope")).rejects.toBeInstanceOf(ValidationError);
    expect(started.fake.rpcRequests("sendTyping")).toHaveLength(0);
  });
});

describe("stream", () => {
  it("types while the answer streams in, then posts it once as styled markdown, never editing", async () => {
    const started = await bot();
    const thread = started.chat.thread(ALICE_DM);

    const chunks: Array<string | StreamChunk> = [
      "Hello ",
      { type: "task_update", id: "1", title: "thinking", status: "in_progress" },
      { type: "markdown_text", text: "**world**" },
      "!",
    ];
    const posting = thread.post(slowStream(chunks, 6_000));
    await advance(started, 30_000);
    const sent = await posting;

    expect(outbound(started)).toEqual([
      ["sendTyping", TYPING],
      ["sendTyping", TYPING],
      ["sendTyping", TYPING],
      ["send", { ...TYPING, message: "Hello world!", textStyle: ["6:5:BOLD"] }],
    ]);
    // The fake numbers its replies from 1_700_000_000_000; the three indicators came first.
    expect(sent.id).toBe(`${BOT_ACI}:1700000000003`);
    expect(sent.text).toBe("Hello world!");
    await advance(started, 60_000);
    expect(outbound(started)).toHaveLength(4);
  });

  it("takes over typing the handler started, and keeps it up past 2 minutes while the stream runs", async () => {
    const started = await bot();
    const thread = started.chat.thread(ALICE_DM);

    await thread.startTyping();
    const posting = thread.post(slowStream(["slow ", "answer"], 100_000));
    await advance(started, 60_000);
    // A handler's startTyping during the stream must not cap the stream's typing at 2 minutes from now.
    await thread.startTyping();
    await advance(started, 145_000);
    await posting;

    // One indicator at 0 s (none extra when the stream starts or typing is asked again), refreshed
    // up to 190 s while the stream runs to 200 s, past 60 s + 2 minutes.
    expect(outbound(started)).toEqual([...Array(20).fill(["sendTyping", TYPING]), ["send", { ...TYPING, message: "slow answer" }]]);
  });

  it("records the streamed reply once in the Conversation's history, with the sent message's ID", async () => {
    const started = await bot();

    const sent = await started.chat.thread(ALICE_DM).post(slowStream(["one ", "two"]));

    const { messages } = await started.adapter.fetchMessages(ALICE_DM);
    expect(messages.map((message) => [message.id, message.text])).toEqual([[sent.id, "one two"]]);
  });

  it("stops typing with a STOP and posts nothing when the stream fails", async () => {
    const started = await bot();
    async function* failing(): AsyncIterable<string> {
      yield "partial";
      throw new Error("model crashed");
    }

    await expect(started.chat.thread(ALICE_DM).post(failing())).rejects.toThrow("model crashed");

    expect(outbound(started)).toEqual([
      ["sendTyping", TYPING],
      ["sendTyping", TYPING_STOP],
    ]);
  });

  it("rejects with the stream's own error when the STOP fails too", async () => {
    const started = await bot();
    async function* failing(): AsyncIterable<string> {
      yield "partial";
      started.fake.failRpc("sendTyping", { code: -1, message: "Failed to send message" });
      throw new Error("model crashed");
    }

    await expect(started.chat.thread(ALICE_DM).post(failing())).rejects.toThrow("model crashed");

    expect(outbound(started)).toEqual([
      ["sendTyping", TYPING],
      ["sendTyping", TYPING_STOP],
    ]);
    expect(started.logger.entries.map((entry) => entry.message)).toContain("Could not stop a Signal typing indicator");
  });

  it("sends no STOP for a failed stream when the indicator never went up", async () => {
    const started = await bot();
    started.fake.failRpc("sendTyping", { code: -1, message: "Failed to send message" });
    async function* failing(): AsyncIterable<string> {
      yield "partial";
      throw new Error("model crashed");
    }

    await expect(started.chat.thread(ALICE_DM).post(failing())).rejects.toThrow("model crashed");

    expect(started.fake.rpcRequests("sendTyping")).toHaveLength(1);
  });

  it("rejects an empty stream after stopping the indicator, as Signal cannot send an empty message", async () => {
    const started = await bot();

    await expect(started.chat.thread(ALICE_DM).post(slowStream([" ", "\n"]))).rejects.toBeInstanceOf(ValidationError);

    expect(outbound(started)).toEqual([
      ["sendTyping", TYPING],
      ["sendTyping", TYPING_STOP],
    ]);
  });

  it("still posts the answer when the typing indicator fails", async () => {
    const started = await bot();
    started.fake.failRpc("sendTyping", { code: -1, message: "Failed to send message" });

    await started.chat.thread(ALICE_DM).post(slowStream(["answer"]));

    expect(started.fake.rpcRequests("send").map((request) => request.params?.message)).toEqual(["answer"]);
  });

  it("splits a streamed answer over Signal's limit like a post", async () => {
    const started = await bot();

    await started.chat.thread(ALICE_DM).post(slowStream(["a".repeat(40_000), "\n\n", "b".repeat(40_000)]));

    expect(started.fake.rpcRequests("send").map((request) => request.params?.message)).toEqual([
      "a".repeat(40_000),
      "b".repeat(40_000),
    ]);
  });
});

describe("replies over Signal's 64 KiB limit", () => {
  /** The `send` requests' text and styles. */
  function sends(started: Bot) {
    return started.fake.rpcRequests("send").map((request) => [request.params?.message, request.params?.textStyle]);
  }

  it("are not split at exactly 64 KiB of UTF-8", async () => {
    const started = await bot();
    const text = `😀${"é".repeat((LIMIT - 4) / 2)}`;

    await started.chat.thread(ALICE_DM).post(text);

    expect(sends(started)).toEqual([[text, undefined]]);
  });

  it("are split at the last paragraph break that fits, each part with its own style ranges", async () => {
    const started = await bot();
    const a = "a".repeat(40_000);
    const b = "b".repeat(30_000);

    const sent = await started.chat.thread(ALICE_DM).post({ markdown: `**😀${a}**\n\n${b}\n\n**ccc** _d_` });

    expect(sends(started)).toEqual([
      [`😀${a}`, ["0:40002:BOLD"]],
      [`${b}\n\nccc d`, ["30002:3:BOLD", "30006:1:ITALIC"]],
    ]);
    // The first part stands for the reply: the fake numbers sends from 1_700_000_000_000.
    expect(sent.id).toBe(`${BOT_ACI}:1700000000000`);
  });

  it("split a style range that spans the break into both parts", async () => {
    const started = await bot();
    const x = "x".repeat(40_000);
    const y = "y".repeat(40_000);

    await started.chat.thread(ALICE_DM).post({ markdown: `\`\`\`\n${x}\n\n${y}\n\`\`\`` });

    expect(sends(started)).toEqual([
      [x, ["0:40000:MONOSPACE"]],
      [y, ["0:40000:MONOSPACE"]],
    ]);
  });

  it("fall back to a line break, then a space, then a cut between characters", async () => {
    const started = await bot();
    const thread = started.chat.thread(ALICE_DM);
    const line = "l".repeat(40_000);
    const word = "w".repeat(40_000);

    await thread.post(`${line}\n${line}`);
    await thread.post(`${word} ${word}`);
    await thread.post(`${line}\n\n\n${word}`);
    // 65 534 bytes, then an emoji (4 bytes) that must not be cut in half.
    await thread.post(`${"z".repeat(LIMIT - 2)}😀${"z".repeat(10)}`);

    expect(sends(started)).toEqual([
      [line, undefined],
      [line, undefined],
      [word, undefined],
      [word, undefined],
      [line, undefined],
      [word, undefined],
      ["z".repeat(LIMIT - 2), undefined],
      [`😀${"z".repeat(10)}`, undefined],
    ]);
  });

  it("prefer the last paragraph break that fits, then a line break over a space", async () => {
    const started = await bot();
    const thread = started.chat.thread(ALICE_DM);
    const [a, b, c] = ["a".repeat(20_000), "b".repeat(30_000), "c".repeat(10_000)];

    await thread.post(`${a}\n\n${a}\n\n${b}`);
    await thread.post(`${b}\n\n${b}\n${c}`);
    await thread.post(`${b}\n${b} ${c}`);

    expect(sends(started).map(([text]) => text)).toEqual([
      `${a}\n\n${a}`,
      b,
      b,
      `${b}\n${c}`,
      b,
      `${b} ${c}`,
    ]);
  });

  it("fill a part to exactly 64 KiB, with a break right at the limit or a cut between characters", async () => {
    const started = await bot();
    const thread = started.chat.thread(ALICE_DM);
    const full = "a".repeat(LIMIT);
    const third = Math.floor(LIMIT / 3);

    await thread.post(`${full}\n\n${"b".repeat(10)}`);
    await thread.post(`${full}${"y".repeat(10)}`);
    await thread.post("€".repeat(third + 10));
    // An emoji one byte short of fitting moves on whole; one that fits is followed by one more character.
    await thread.post(`${"z".repeat(LIMIT - 3)}😀${"z".repeat(10)}`);
    await thread.post(`${"z".repeat(LIMIT - 5)}😀${"y".repeat(10)}`);
    // A newline run straddling the limit is dropped whole.
    await thread.post(`${"a".repeat(LIMIT - 2)}\n\n\n\n\n\n${"b".repeat(10)}`);

    expect(sends(started).map(([text]) => text)).toEqual([
      full,
      "b".repeat(10),
      full,
      "y".repeat(10),
      "€".repeat(third),
      "€".repeat(10),
      "z".repeat(LIMIT - 3),
      `😀${"z".repeat(10)}`,
      `${"z".repeat(LIMIT - 5)}😀y`,
      "y".repeat(9),
      "a".repeat(LIMIT - 2),
      "b".repeat(10),
    ]);
  });

  it("count UTF-8 bytes, not characters", async () => {
    const started = await bot();
    // 20 000 three-byte characters per paragraph: 120 002 bytes in all, but only 40 002 characters.
    const paragraph = "€".repeat(20_000);

    await started.chat.thread(ALICE_DM).post(`${paragraph}\n\n${paragraph}`);

    expect(sends(started)).toEqual([
      [paragraph, undefined],
      [paragraph, undefined],
    ]);
  });
});
