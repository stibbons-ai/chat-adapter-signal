import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat, type Logger, type Message, type Thread } from "chat";
import { createSignalAdapter, type SignalAdapter, type SignalAdapterConfig } from "../src/index.js";
import { BOT_ACCOUNT, FakeSignalCli } from "./fake-signal-cli.js";

export interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  args: unknown[];
}

export type RecordingLogger = Logger & { entries: LogEntry[] };

/** A Chat SDK logger that keeps every entry so tests can read warnings back. */
export function recordingLogger(entries: LogEntry[] = []): RecordingLogger {
  const record = (level: LogEntry["level"]) => (message: string, ...args: unknown[]) => {
    entries.push({ level, message, args });
  };
  const logger = {
    entries,
    child: () => logger,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
  return logger;
}

export interface Bot {
  fake: FakeSignalCli;
  chat: Chat<{ signal: SignalAdapter }>;
  adapter: SignalAdapter;
  logger: RecordingLogger;
  /** Resolves with the next direct message delivered to `onDirectMessage`. */
  nextDirectMessage(): Promise<{ thread: Thread; message: Message }>;
}

/** A Host App: real `Chat`, in-memory state, the Signal adapter pointed at a fresh fake signal-cli. */
export async function startBot(
  options: { config?: SignalAdapterConfig; initialize?: boolean; fake?: FakeSignalCli } = {},
): Promise<Bot> {
  const fake = options.fake ?? (await FakeSignalCli.start());
  const logger = recordingLogger();
  const adapter = createSignalAdapter(
    options.config ?? { account: BOT_ACCOUNT, transport: { type: "http", url: fake.url } },
  );
  const chat = new Chat({ userName: "echo-bot", adapters: { signal: adapter }, state: createMemoryState(), logger });

  const waiting: Array<(value: { thread: Thread; message: Message }) => void> = [];
  const queued: Array<{ thread: Thread; message: Message }> = [];
  chat.onDirectMessage((thread, message) => {
    const received = { thread, message };
    const resolve = waiting.shift();
    if (resolve) {
      resolve(received);
    } else {
      queued.push(received);
    }
  });

  if (options.initialize !== false) {
    await chat.initialize();
  }

  return {
    fake,
    chat,
    adapter,
    logger,
    nextDirectMessage: () => {
      const received = queued.shift();
      return received ? Promise.resolve(received) : new Promise((resolve) => waiting.push(resolve));
    },
  };
}
