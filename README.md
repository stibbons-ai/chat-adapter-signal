# @stibbons/chat-adapter-signal

Signal adapter for the [Chat SDK](https://github.com/vercel/chat). It talks to a
[signal-cli](https://github.com/AsamK/signal-cli) daemon that you install and run
yourself; this package never bundles, downloads or installs signal-cli or libsignal.

> Early development: 1:1 and Group text messages in and out, over signal-cli's HTTP daemon,
> a Unix socket, TCP, or a spawned signal-cli. Formatting, reactions and attachments are not supported yet.

## Requirements

- Node.js 24 or newer, ESM only.
- `chat` ^4.43 (peer dependency).
- signal-cli 0.14.9 or newer, installed by you, with the Bot Account already registered
  or linked. The adapter warns at startup when signal-cli is older. Either run it as a
  daemon (`signal-cli daemon --http <host:port>`, `--socket <path>` or `--tcp <host:port>`;
  the HTTP daemon must be multi-account, i.e. started without `-a`), or let the adapter
  spawn it (see Transports).

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
| `transport` | `SIGNAL_CLI_URL` (implies `{ type: "http" }`) | How to reach signal-cli; see Transports. |
| `userName` | – | Defaults to the `Chat` instance's `userName`. |
| `logger` | – | Defaults to the `Chat` instance's logger. |
| `drainTimeoutMs` | – | How long `disconnect()` waits for running handlers. Default 10 000. |

### Transports

| `transport` | signal-cli side |
|---|---|
| `{ type: "http", url, headers? }` | `signal-cli daemon --http <host:port>` (multi-account). `headers` are sent on every request, including the event stream, e.g. for a reverse proxy's auth. |
| `{ type: "socket", path }` | `signal-cli daemon --socket <path>` |
| `{ type: "tcp", host, port }` | `signal-cli daemon --tcp <host:port>` |
| `{ type: "spawn", command?, args? }` | The adapter runs `<command> <args…> -a <account> jsonRpc` and talks over its stdin/stdout. `command` defaults to `signal-cli` on `PATH`; `args` go before `-a`, e.g. `["--config", "/var/lib/signal-cli"]`. |

Socket, TCP and spawn speak signal-cli's line-delimited JSON-RPC. Their daemons may run
single- or multi-account; on a multi-account daemon the adapter ignores other accounts'
messages. `disconnect()` closes the socket, or terminates the spawned signal-cli (SIGTERM,
then SIGKILL after 5 s). If the spawned signal-cli exits on its own, the adapter logs a
`NetworkError` with its exit code and last stderr line (e.g. `User +15550000001 is not
registered.`), fails requests in flight, and receives nothing further; at startup,
`initialize()` rejects with that error. The socket, TCP and HTTP daemons have no
authentication: keep them unreachable for anyone who must not send as your bot.

`initialize()` checks that signal-cli is reachable, reads its version, looks up the
Bot Account's ACI (`listAccounts` on a multi-account daemon, otherwise the account's own
`listContacts` entry), and opens the event stream. The Host App must
stay running to receive messages; webhooks are not supported (`handleWebhook` answers 501).

Each incoming message is handed to Chat without waiting for the previous one, so a slow
handler in one Conversation does not hold up the others. Within one Conversation, Chat's
`concurrency` setting decides what happens when a message arrives while its handler is
still running. With Chat's default `"drop"`, that second message is dropped (Chat logs a
`LockError`); use `"queue"` (or `"debounce"`) for Signal bots, as in the example above.

`disconnect()` (called by `chat.shutdown()`) first closes the event stream, then waits for
running handlers to finish so their replies go out and their locks are released, at most
`drainTimeoutMs` (after that it logs a warning), then closes the socket or spawned signal-cli. Don't call `chat.shutdown()` from
inside a message handler: the drain then waits for that handler itself, so shutdown takes the
full `drainTimeoutMs`. A shutdown during `initialize()` stops the startup and makes
`initialize()` reject with `AdapterError` code `STARTUP_CANCELLED`; an event stream that was
already connecting is closed as soon as it opens. A later `chat.initialize()` starts afresh.
Await `chat.initialize()` before calling `chat.shutdown()`: Chat SDK 4.43 does not cancel an
initialization that has not yet reached the adapter. If `initialize()` fails (for example while
signal-cli is still starting), call `chat.shutdown()` before retrying: Chat SDK 4.43 caches the
failed initialization, so a retry without it fails again without contacting signal-cli.

## IDs

Users are keyed by their ACI, never their phone number; profile name and phone number
are display data only (`author.fullName`).

- Thread and channel ID of a 1:1 Conversation: `signal:dm:<ACI>`
- Thread and channel ID of a Group: `signal:group:<groupId>`, the Groups v2 ID in base64url without padding
  (signal-cli prints it in standard base64); legacy (v1) groups are not supported
- Message ID: `<authorACI>:<timestamp>`; the bot's own messages use the Bot Account's ACI.

## Groups and Mentions

Each Group is one Conversation, so `thread.subscribe()` covers all of its messages and `thread.post`
sends to the whole Group. Every Group message the adapter hands to Chat has `message.isMention` set: `true` for a native Signal
@mention of the Bot Account or a quote-reply to one of its messages, which fires `onNewMention`;
`false` otherwise, including when the bot's name only appears as text. The mention itself shows as
U+FFFC in `message.text` for now.

Not user input, so never handed to Chat: sync messages from the Bot Account's own linked devices,
edits, remote deletes, reactions, receipts, typing indicators, story replies, and legacy-group messages.

## Errors

signal-cli failures surface as `@chat-adapter/shared` errors (signal-cli JSON-RPC codes in parentheses):

| Error | When |
|---|---|
| `AuthenticationError` | HTTP 401/403 (e.g. from a reverse proxy), or the daemon does not serve the Bot Account (`-32602` "Specified account does not exist", or the account is missing from `listAccounts`/`listContacts` at startup) |
| `AdapterRateLimitError` | signal-cli rate-limit error (`-5`), or HTTP 429; `retryAfter` in seconds when known |
| `ResourceNotFoundError` | The recipient is not registered with Signal (`-1`) |
| `ValidationError` | Invalid request or parameters (`-32600`, other `-32602`, other `-1` user errors) |
| `NetworkError` | signal-cli unreachable or not startable, a spawned signal-cli that exited, a dropped socket, other HTTP failures, malformed replies, signal-cli I/O errors (`-3`), or a send where every recipient failed on the network (`-1` with `NETWORK_FAILURE` results) |
| `AdapterError` with `code` | `UNTRUSTED_IDENTITY` (`-4`), `CAPTCHA_REJECTED` (`-6`), `METHOD_NOT_FOUND` (`-32601`), `SIGNAL_CLI_ERROR` (anything else, e.g. `-32603`); from `initialize()`, `STARTUP_CANCELLED` when `disconnect()` ran during startup |

signal-cli 0.14.9 reports an I/O failure during `send` as an internal error (`-32603`, "Failed to send message: … (IOException)"),
so it arrives as `AdapterError` with code `SIGNAL_CLI_ERROR`, not as `NetworkError`.

## License

MIT. signal-cli (GPLv3) and libsignal (AGPLv3) are separate programs that this package
only talks to over signal-cli's JSON-RPC protocol.
