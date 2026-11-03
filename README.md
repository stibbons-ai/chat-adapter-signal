# @stibbons/chat-adapter-signal

Signal adapter for the [Chat SDK](https://github.com/vercel/chat). It talks to a
[signal-cli](https://github.com/AsamK/signal-cli) daemon that you install and run
yourself; this package never bundles, downloads or installs signal-cli or libsignal.

> Early development: 1:1 and Group text messages in and out, with formatting, over signal-cli's HTTP daemon,
> a Unix socket, TCP, or a spawned signal-cli. Reactions and attachments are not supported yet.

## Requirements

- Node.js 24 or newer, ESM only.
- `chat` ^4.43 (peer dependency).
- signal-cli 0.14.9 or newer, installed by you, with the Bot Account already registered
  or linked. The adapter warns at startup when signal-cli is older. Either run it as a
  daemon (`signal-cli daemon --http <host:port>`, `--socket <path>` or `--tcp <host:port>`,
  with or without `-a`), or let the adapter spawn it (see Transports).

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
| `drainTimeoutMs` | – | How long `disconnect()` waits for running handlers and the final receive-cursor write. Default 10 000. |
| `reconnect` | – | `{ minDelayMs?, maxDelayMs? }` backoff for reconnecting a dropped event stream; see below. |

### Transports

| `transport` | signal-cli side |
|---|---|
| `{ type: "http", url, headers?, idleTimeoutMs? }` | `signal-cli daemon --http <host:port>`. `headers` are sent on every request, including the event stream, e.g. for a reverse proxy's auth. `idleTimeoutMs` (default 60 000): see Reliable receive. |
| `{ type: "socket", path }` | `signal-cli daemon --socket <path>` |
| `{ type: "tcp", host, port }` | `signal-cli daemon --tcp <host:port>` |
| `{ type: "spawn", command?, args? }` | The adapter runs `<command> <args…> -a <account> jsonRpc` and talks over its stdin/stdout. `command` defaults to `signal-cli` on `PATH`; `args` go before `-a`, e.g. `["--config", "/var/lib/signal-cli"]`. |

Socket, TCP and spawn speak signal-cli's line-delimited JSON-RPC. On a multi-account
socket or TCP daemon the adapter ignores other accounts' messages. `disconnect()` closes the socket, or terminates the spawned signal-cli (SIGTERM,
then SIGKILL after 5 s). If the spawned signal-cli exits on its own, the adapter logs a
`NetworkError` with its exit code and last stderr line (e.g. `User +15550000001 is not
registered.`), fails requests in flight, and starts it again (see Reliable receive); at startup,
`initialize()` rejects with that error. That stderr line is signal-cli's own log output and
can name phone numbers; treat these errors like your other logs. The socket, TCP and HTTP daemons have no
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

`disconnect()` (called by `chat.shutdown()`) first closes the event stream and stops
reconnecting, then waits for running handlers to finish so their replies go out, their locks
are released and the receive cursor is stored, at most `drainTimeoutMs` (after that it logs a
warning), then closes the socket or spawned signal-cli. Don't call `chat.shutdown()` from
inside a message handler: the drain then waits for that handler itself, so shutdown takes the
full `drainTimeoutMs`. A shutdown during `initialize()` stops the startup and makes
`initialize()` reject with `AdapterError` code `STARTUP_CANCELLED`; an event stream that was
already connecting is closed as soon as it opens. A later `chat.initialize()` starts afresh.
Await `chat.initialize()` before calling `chat.shutdown()`: Chat SDK 4.43 does not cancel an
initialization that has not yet reached the adapter. If `initialize()` fails (for example while
signal-cli is still starting), call `chat.shutdown()` before retrying: Chat SDK 4.43 caches the
failed initialization, so a retry without it fails again without contacting signal-cli.

## Reliable receive

When the event stream drops (network failure, signal-cli restart), the adapter reconnects by
itself with exponential backoff: `reconnect.minDelayMs` (default 1 000) doubling per failed
attempt up to `reconnect.maxDelayMs` (default 30 000), each delay shortened by up to 50 %
jitter. It keeps retrying until `chat.shutdown()`, logging a warning per attempt.
On the HTTP transport, a connection that dies without closing (NAT timeout, sleep, a proxy dropping upstream) is
detected when no data, not even signal-cli's keep-alive (every 15 s by default,
`--sse-keepalive-interval`), arrives for `transport.idleTimeoutMs`; keep that well above the
daemon's keep-alive interval.

On the HTTP transport, the adapter stores the ID of the last processed event in Chat's state adapter (key
`signal:receive-cursor:<account>`) and sends it as `Last-Event-ID` on every reconnect and at
startup, so signal-cli replays what was received meanwhile. An event counts as processed once
`chat.processMessage` for it has completed, and the cursor never moves past an event that is
still running. Replayed events that were already processed, or are still running, are skipped,
so no handler runs twice for one event.

Limits:

- signal-cli keeps the last 1 000 events of its current run in memory. Events older than that,
  or received before a signal-cli restart that the adapter missed, are not replayed.
- To resume after a Host App restart, the state adapter must be persistent (e.g. Redis);
  `@chat-adapter/state-memory` loses the cursor with the process.
- With `concurrency: "queue"` or `"debounce"`, `processMessage` completes once the message is
  queued in Chat's state, not when its handler finishes.
- An event whose handler was cut off by a crash is replayed, but Chat skips it as a duplicate
  while its dedupe entry lasts (`dedupeTtlMs`, default 10 minutes): Chat records a message as
  seen before its handler runs.
- If `chat.processMessage` fails (the handler throws, or Chat's state store fails before the
  handler runs), the event still counts as processed so one bad event cannot stall the stream;
  Chat logs the error.
- After a fresh start (no stored cursor), there is no ID to resume from until the first event
  arrives: a reconnect in that window replays nothing (the adapter logs a warning), and a Host App
  crash before that event was processed loses the events not yet processed. Once an event was received,
  reconnects resume after the newest one.

Socket, TCP and spawn reconnect the same way (spawn starts signal-cli again), but signal-cli's
line-delimited JSON-RPC has no event IDs and no replay, so nothing is resumed there:

- A socket or TCP daemon keeps receiving while the adapter is disconnected, and those events
  are lost. Use the HTTP transport if missed messages matter.
- A spawned signal-cli receives nothing while it is down; the Signal server keeps the messages
  and delivers them once it runs again.
- A TCP connection that dies without closing is noticed only by the operating system's TCP
  keep-alive, which can take minutes.
- At shutdown, events signal-cli pushes while running handlers drain are not handled, and on
  these transports nothing brings them back.

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
`false` otherwise, including when the bot's name only appears as text. In `message.text` a native
@mention reads `@<userName>` for the Bot Account and `@<ACI>` for anyone else (Signal sends no
names with mentions).

Not user input, so never handed to Chat: sync messages from the Bot Account's own linked devices,
edits, remote deletes, reactions, receipts, typing indicators, story replies, and legacy-group messages.

## Formatting

Signal styles text with separate ranges rather than markup; the adapter converts both ways.

Outbound, `{ markdown }`, `{ ast }` and cards are sent as plain text with Signal text styles:

| Markdown | On Signal |
|---|---|
| `**bold**`, `_italic_`, `~~strike~~` | bold, italic, strikethrough |
| `` `code` ``, fenced code blocks | monospace (fences dropped) |
| `\|\|spoiler\|\|` | spoiler; an unpaired `\|\|` stays text |
| `# Heading` | bold line |
| `- item`, `1. item` | `• item`, `1. item` (nested lists indented) |
| `[label](url)`, `<url>` | `label (url)`, `url` |
| `> quote` | `> quote` |
| tables | monospace text table |

A plain string or `{ raw }` is sent verbatim, without styles. Cards render as formatted text: bold
title, subtitle, text (as markdown), bold field labels, links and link buttons as URLs, tables as
monospace; other buttons and selects are dropped, as Signal has no interactive elements.
`fallbackText` is not used, since the card itself renders.

Inbound, Signal's bold, italic, strikethrough, monospace and spoiler ranges arrive in
`message.formatted` as the matching markdown nodes (a spoiler as `||text||`, monospace spanning
whole lines as a code block). `message.text` is the text as sent, with mentions resolved. Text
without styles is taken literally: `*stars*` typed on Signal stay stars.

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
