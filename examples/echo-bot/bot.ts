import { createMemoryState } from "@chat-adapter/state-memory";
import { createSignalAdapter } from "@stibbons/chat-adapter-signal";
import { Chat } from "chat";

// The adapter reads SIGNAL_ACCOUNT and SIGNAL_CLI_URL (http://signal-cli:8080) from compose.yaml.
const chat = new Chat({
  userName: "echo-bot",
  adapters: { signal: createSignalAdapter() },
  state: createMemoryState(),
  concurrency: "queue",
});

// 1:1 messages, and Group messages that @mention the bot or quote-reply to it.
chat.onDirectMessage(async (thread, message) => {
  await thread.post(`echo: ${message.text}`);
});
chat.onNewMention(async (thread, message) => {
  await thread.post(`echo: ${message.text}`);
});

await chat.initialize();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void chat.shutdown().finally(() => process.exit(0));
  });
}
