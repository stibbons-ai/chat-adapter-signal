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
  // Signal users often send several messages in a row; queue them instead of dropping them.
  concurrency: "queue",
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
| `drainTimeoutMs` | – | How long `disconnect()` waits for running handlers. Default 10 000. |

`initialize()` checks that signal-cli is reachable, reads its version, looks up the
Bot Account's ACI with `listAccounts`, and opens the event stream. The Host App must
stay running to receive messages; webhooks are not supported (`handleWebhook` answers 501).

Each incoming message is handed to Chat without waiting for the previous one, so a slow
handler in one Conversation does not hold up the others. Within one Conversation, Chat's
`concurrency` setting decides what happens when a message arrives while its handler is
still running. With Chat's default `"drop"`, that second message is dropped (Chat logs a
`LockError`); use `"queue"` (or `"debounce"`) for Signal bots, as in the example above.

`disconnect()` (called by `chat.shutdown()`) first closes the event stream, then waits for
running handlers to finish so their replies go out and their locks are released, at most
`drainTimeoutMs`; after that it logs a warning and returns. Don't call `chat.shutdown()` from
inside a message handler: the drain then waits for that handler itself, so shutdown takes the
full `drainTimeoutMs`. A shutdown during `initialize()` stops the startup and makes
`initialize()` reject with `AdapterError` code `STARTUP_CANCELLED`; an event stream that was
already connecting is closed as soon as it opens. A later `chat.initialize()` starts afresh.
Await `chat.initialize()` before calling `chat.shutdown()`: Chat SDK 4.43 does not cancel an
initialization that has not yet reached the adapter.

## IDs

Users are keyed by their ACI, never their phone number; profile name and phone number
are display data only (`author.fullName`).

- Thread and channel ID of a 1:1 Conversation: `signal:dm:<ACI>`
- Message ID: `<authorACI>:<timestamp>`; the bot's own messages use the Bot Account's ACI.

## Errors

signal-cli failures surface as `@chat-adapter/shared` errors (signal-cli JSON-RPC codes in parentheses):

| Error | When |
|---|---|
| `AuthenticationError` | HTTP 401/403 (e.g. from a reverse proxy), or the daemon does not serve the Bot Account (`-32602` "Specified account does not exist", or the account is missing from `listAccounts` at startup) |
| `AdapterRateLimitError` | signal-cli rate-limit error (`-5`), or HTTP 429; `retryAfter` in seconds when known |
| `ResourceNotFoundError` | The recipient is not registered with Signal (`-1`) |
| `ValidationError` | Invalid request or parameters (`-32600`, other `-32602`, other `-1` user errors); from `initialize()`, a single-account daemon (started with `-a`) |
| `NetworkError` | signal-cli unreachable, other HTTP failures, malformed replies, signal-cli I/O errors (`-3`), or a send where every recipient failed on the network (`-1` with `NETWORK_FAILURE` results) |
| `AdapterError` with `code` | `UNTRUSTED_IDENTITY` (`-4`), `CAPTCHA_REJECTED` (`-6`), `METHOD_NOT_FOUND` (`-32601`), `SIGNAL_CLI_ERROR` (anything else, e.g. `-32603`); from `initialize()`, `STARTUP_CANCELLED` when `disconnect()` ran during startup |

signal-cli 0.14.9 reports an I/O failure during `send` as an internal error (`-32603`, "Failed to send message: … (IOException)"),
so it arrives as `AdapterError` with code `SIGNAL_CLI_ERROR`, not as `NetworkError`.

## License

MIT. signal-cli (GPLv3) and libsignal (AGPLv3) are separate programs that this package
only talks to over signal-cli's JSON-RPC protocol.
