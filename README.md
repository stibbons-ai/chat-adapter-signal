# @stibbons/chat-adapter-signal

Signal adapter for the [Chat SDK](https://github.com/vercel/chat). It talks to a
[signal-cli](https://github.com/AsamK/signal-cli) daemon that you install and run
yourself; this package never bundles, downloads or installs signal-cli or libsignal.

> Early development: 1:1 text messages in and out over signal-cli's HTTP daemon.
> Groups, formatting, reactions, attachments and the other transports are not supported yet.

## Requirements

- Node.js 20 or newer, ESM only.
- `chat` ^4.43 (peer dependency).
- signal-cli 0.14.9 or newer, running as a multi-account HTTP daemon
  (`signal-cli daemon --http <host:port>`, without `-a`), with the Bot Account
  already registered or linked. The adapter warns at startup when signal-cli is older.

## Usage

```ts
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createSignalAdapter } from "@stibbons/chat-adapter-signal";

const chat = new Chat({
  userName: "echo-bot",
  adapters: {
    signal: createSignalAdapter({
      account: "+15550000001",
      transport: { type: "http", url: "http://signal-cli:8080" },
    }),
  },
  state: createMemoryState(),
});

chat.onDirectMessage(async (thread, message) => {
  await thread.post(`echo: ${message.text}`);
});

await chat.initialize();
```

| Option | Environment fallback | Notes |
|---|---|---|
| `account` | `SIGNAL_ACCOUNT` | The Bot Account's number (or ACI) in signal-cli. One adapter instance speaks as exactly one account. |
| `transport` | `SIGNAL_CLI_URL` (implies `{ type: "http" }`) | `{ type: "http", url, headers? }`. `headers` are sent on every request, including the event stream, e.g. for a reverse proxy's auth. |
| `userName` | – | Defaults to the `Chat` instance's `userName`. |
| `logger` | – | Defaults to the `Chat` instance's logger. |

`initialize()` checks that signal-cli is reachable, reads its version, looks up the
Bot Account's ACI with `listAccounts`, and opens the event stream. The Host App must
stay running to receive messages; webhooks are not supported (`handleWebhook` answers 501).

## IDs

Users are keyed by their ACI, never their phone number; profile name and phone number
are display data only (`author.fullName`).

- Thread and channel ID of a 1:1 Conversation: `signal:dm:<ACI>`
- Message ID: `<authorACI>:<timestamp>`; the bot's own messages use the Bot Account's ACI.

## Errors

signal-cli failures surface as `@chat-adapter/shared` errors:

| Error | When |
|---|---|
| `AuthenticationError` | HTTP 401/403 (e.g. from a reverse proxy), or the daemon does not serve the Bot Account |
| `AdapterRateLimitError` | signal-cli rate-limit error (`-5`), or HTTP 429; `retryAfter` in seconds when known |
| `ResourceNotFoundError` | The recipient is not registered with Signal |
| `ValidationError` | Invalid request or parameters (`-32600`, `-32602`, other `-1` user errors) |
| `NetworkError` | signal-cli unreachable, other HTTP failures, or signal-cli I/O errors (`-3`) |

## License

MIT. signal-cli (GPLv3) and libsignal (AGPLv3) are separate programs that this package
only talks to over signal-cli's JSON-RPC protocol.
