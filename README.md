# @stibbons/chat-adapter-signal

Signal adapter for the [Chat SDK](https://github.com/vercel/chat). It talks to a
[signal-cli](https://github.com/AsamK/signal-cli) daemon that you install and run
yourself; this package never bundles, downloads or installs signal-cli or libsignal.

> Early development: 1:1 and Group messages in and out, with formatting, attachments, streamed
> replies, typing indicators, edits, remote deletes, reactions and read receipts, over
> signal-cli's HTTP daemon, a Unix socket, TCP, or a spawned signal-cli.

## Install

```sh
npm install @stibbons/chat-adapter-signal chat @chat-adapter/state-memory
```

Not yet on npm: until the first release, the [Docker example](#docker-example-echo-bot) builds the
package from this repository.

- Node.js 24 or newer, ESM only.
- `chat` ^4.43 (peer dependency), plus a Chat state adapter (`@chat-adapter/state-memory` to try it out;
  a persistent one such as Redis in production, see Reliable receive).
- signal-cli 0.14.9 or newer, installed by you, with the Bot Account already registered
  or linked (see [Provisioning the Bot Account](#provisioning-the-bot-account)). The adapter warns at
  startup when signal-cli is older. Either run it as a daemon (`signal-cli daemon --http <host:port>`,
  `--socket <path>` or `--tcp <host:port>`, with or without `-a`), or let the adapter spawn it (see
  Transports).

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
| `requestTimeoutMs` | – | How long one request to signal-cli (a send, a lookup, the startup checks) may take before it fails with a `NetworkError`, on every transport. Default 60 000. It also bounds connecting to a socket or TCP daemon. On spawn it includes signal-cli's own startup, which takes seconds. A reply that arrives later is dropped. Requests carrying attachments get longer; see [Attachments](#attachments). |
| `reconnect` | – | `{ minDelayMs?, maxDelayMs? }` backoff for reconnecting a dropped event stream; see below. |

### Transports

Run signal-cli as an HTTP daemon in its own container next to the Host App, as in the
[Docker example](#docker-example-echo-bot): that is the recommended setup, and the only transport that
replays events missed during a reconnect (see Reliable receive). For local development without a
daemon, let the adapter spawn a signal-cli you installed: `transport: { type: "spawn" }`.

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
authentication: keep them unreachable for anyone who must not send as your bot (see [Security](#security)).

`initialize()` checks that signal-cli is reachable, reads its version, looks up the
Bot Account's ACI (`listAccounts` on a multi-account daemon, otherwise the account's own
`listContacts` entry), and opens the event stream. The Host App must
stay running to receive messages (see [Deployment](#deployment)); webhooks are not supported
(`handleWebhook` answers 501).

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

## Docker example (echo bot)

[`examples/echo-bot`](examples/echo-bot) runs signal-cli and a minimal echo-bot Host App with one
compose file:

- `signal-cli`: the community image `registry.gitlab.com/packaging/signal-cli/signal-cli-native`
  ([packaging/signal-cli](https://gitlab.com/packaging/signal-cli), a native build that needs no Java),
  pinned to a release tag in `compose.yaml`. It runs
  `daemon --http 0.0.0.0:8080 --receive-mode on-start --no-receive-stdout` and keeps its data (the Bot
  Account's keys and state) in the `signal-cli-data` volume. It publishes no ports.
- `echo-bot`: [`bot.ts`](examples/echo-bot/bot.ts), which answers 1:1 messages and Mentions with
  `echo: <text>`. It reaches signal-cli at `http://signal-cli:8080` (`SIGNAL_CLI_URL`) and speaks as
  `SIGNAL_ACCOUNT`.

```sh
cd examples/echo-bot
# provision the Bot Account first, see Provisioning below: register a dedicated number, or link
echo 'SIGNAL_ACCOUNT=+15550000001' > .env   # the Bot Account's number
docker compose up -d --build
docker compose logs -f echo-bot
```

Then send the Bot Account a message from another Signal account. As long as no Bot Account is
provisioned (with `SIGNAL_ACCOUNT` set), the bot exits with `AuthenticationError: Bot Account … is not
registered or linked on the signal-cli daemon` and compose restarts it.

`--receive-mode on-start` (signal-cli's default, spelled out) makes signal-cli receive from Signal from
the moment it starts, also while the Host App is disconnected; from the Host App's first connection on,
it buffers what arrives so the adapter can replay it after a reconnect. Messages signal-cli receives
after it (re)starts and before the Host App connects are not replayed. The example keeps the adapter's
receive cursor in memory, so it also misses what arrives while the bot itself is down; use a persistent
state adapter in production (see Reliable receive).

The image comes from its publisher; this repository publishes no signal-cli image (see
[ADR-0001](docs/adr/0001-signal-cli-as-separate-program.md)).

### Provisioning the Bot Account

Provisioning is done with signal-cli's own CLI, not the adapter. Run it in a one-off container on the
same volume (`docker compose run --rm signal-cli <arguments>`; the image's entrypoint is `signal-cli`).
If the stack is already running, stop it first (`docker compose stop`) and start it again afterwards
(`docker compose up -d`): the daemon loads accounts only when it starts.

**Register a dedicated number** (recommended for a bot; one that can receive an SMS or a call, not the
number of a phone that uses Signal, as registering moves the account away from that phone):

```sh
docker compose run --rm signal-cli -a +15550000001 register
```

Signal usually demands a captcha first; signal-cli then fails with `Captcha required for verification`.
Solve it at <https://signalcaptchas.org/registration/generate.html>, copy the link behind "Open Signal"
(`signalcaptcha://…`), and register again with it (quoted, it is long):

```sh
docker compose run --rm signal-cli -a +15550000001 register --captcha 'signalcaptcha://…'
# add --voice for a call instead of an SMS (after an SMS attempt)
docker compose run --rm signal-cli -a +15550000001 verify 123-456
# add --pin <PIN> if the number has a registration lock PIN
```

Set a profile name so users see who answers, e.g.
`docker compose run --rm signal-cli -a +15550000001 updateProfile --given-name "Echo bot"`.

**Or link to an existing account** as a linked device:

```sh
docker compose run --rm signal-cli link -n echo-bot
```

signal-cli prints a QR code (when run in a terminal) and a `sgnl://linkdevice?…` URI, and waits. In
Signal on the phone, open Settings → Linked devices, link a new device and scan the code (or render the
URI as a QR code yourself, e.g. with `qrencode`). The Bot Account is then that phone's number: the bot
reads everything sent to it and answers as you. Linking a personal number makes the echo bot reply to
every contact who writes to you. The adapter ignores what you send from your own devices (sync
messages), so test from another account.

## Security

signal-cli's HTTP daemon, like its socket and TCP daemons, has no authentication: anyone who can reach
it can read the Bot Account's messages and send as the bot.

- Keep it on a private network. The example publishes no ports: only containers on the compose network
  (and, on Linux, the Docker host itself, through the container's IP) reach `http://signal-cli:8080`.
  Don't add `ports:` to the signal-cli service, not even on loopback:
  bound to `0.0.0.0` in the container, signal-cli checks no `Host` header, so any web page you open could
  reach it through DNS rebinding. To look at it, use a one-off container on the compose network (e.g.
  `docker compose run --rm --entrypoint bash signal-cli`).
- The data volume holds the Bot Account's keys: whoever has a copy can act as the bot. Treat it and its
  backups like a secret. `docker compose down -v` deletes it, and with it the Bot Account's
  registration or link; plain `docker compose down` keeps it.

### Remote Host Apps: reverse proxy with auth

When the Host App runs on another machine, put a reverse proxy with TLS and authentication in front of
signal-cli and send the credentials with `transport.headers`, which the adapter adds to every request,
including the event stream. For example with [Caddy](https://caddyserver.com) (automatic HTTPS, basic
auth), as an extra service next to signal-cli:

```yaml
services:
  caddy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
volumes:
  caddy-data:
```

```caddyfile
signal.example.com {
	basic_auth {
		# hash: docker run --rm -it caddy:2 caddy hash-password   (prompts for the password)
		echo-bot <hash>
	}
	reverse_proxy signal-cli:8080
}
```

```ts
const password = process.env.SIGNAL_CLI_PASSWORD;
if (!password) throw new Error("SIGNAL_CLI_PASSWORD is not set");

createSignalAdapter({
  account: "+15550000001",
  transport: {
    type: "http",
    url: "https://signal.example.com",
    headers: { Authorization: `Basic ${Buffer.from(`echo-bot:${password}`).toString("base64")}` },
  },
});
```

Use a long random password and an `https://` URL only: basic auth sends the password with every request.
Whoever passes the proxy gets all of signal-cli's JSON-RPC, not only sending and receiving, including
`unregister` and `removeDevice`: the proxy's authentication is the only barrier. Once the Bot Account is
provisioned, start the daemon with `-a <account>` (`-a +15550000001 daemon --http …`): it then no longer
serves `register`, `verify`, `startLink`/`finishLink` or `deleteLocalAccountData`, which a daemon without
`-a`, like the example's, offers. With missing or wrong credentials, `initialize()` rejects with `AuthenticationError`
(HTTP 401). Any proxy and scheme works, e.g. a bearer token checked by the proxy, as long as the proxy:

- passes the event stream (`/api/v1/events`, server-sent events) through and keeps it open; Caddy and
  nginx do so with their defaults. Keep any proxy read timeout above signal-cli's keep-alive interval
  (15 s by default).
- sends a `Host` header signal-cli accepts: bound to a specific address (e.g.
  `daemon --http 127.0.0.1:8080` on the proxy's host), signal-cli accepts only that address,
  `localhost`, `127.0.0.1` or `::1` (with the bound port, if a port is given) and answers others with
  421. Caddy forwards the client's `Host` unless told `header_up Host {upstream_hostport}`; nginx sends
  the upstream's by default. Bound to `0.0.0.0`, as in the example, signal-cli checks no `Host`.
- accepts request bodies as large as the attachments you send, base64-encoded (signal-cli takes up to
  150 MiB): nginx refuses bodies over 1 MB by default (`client_max_body_size`) and answers 413, which
  the adapter reports as a `NetworkError`; Caddy sets no limit.

## Deployment

The Host App must be a long-running process (a container, a VM, a server such as Mastra): the adapter
receives only while it holds the event stream open. Serverless and edge functions don't work.

Keep signal-cli current: Signal changes its server over time, and signal-cli releases older than about
three months may stop working. Update the image tag regularly; this repository's
[`renovate.json`](renovate.json) makes Renovate, where it runs on the repository, open a pull request for
each new `signal-cli-native` tag (the tag scheme `v<major>-<minor>-<patch>-<build>[-<revision>]` needs its
`regex` versioning; copy that rule into your own Renovate config). After updating:
`docker compose pull signal-cli && docker compose up -d`.

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
Chat has processed it (`chat.processMessage`, or `chat.processReaction` for a reaction), and the
cursor never moves past an event that is still running. Replayed events that were already
processed, or are still running, are skipped, so no handler runs twice for one event.

Limits:

- signal-cli keeps the last 1 000 events of its current run in memory. Events older than that,
  or received before a signal-cli restart that the adapter missed, are not replayed.
- To resume after a Host App restart, the state adapter must be persistent (e.g. Redis);
  `@chat-adapter/state-memory` loses the cursor with the process.
- With `concurrency: "queue"` or `"debounce"`, `processMessage` completes once the message is
  queued in Chat's state, not when its handler finishes.
- A message whose handler was cut off by a crash is replayed, but Chat skips it as a duplicate
  while its dedupe entry lasts (`dedupeTtlMs`, default 10 minutes): Chat records a message as
  seen before its handler runs. Chat does not deduplicate reactions, so such a reaction arrives again.
- If `chat.processMessage` or `chat.processReaction` fails (the handler throws, or Chat's state store fails before the
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
edits, remote deletes, receipts, typing indicators, story replies, and legacy-group messages.

## Message actions

- `editMessage` and `deleteMessage` (also `sent.edit()`, `sent.delete()`) work on the Bot Account's own
  messages only; anything else is a `ValidationError`. Signal clients show edited messages as edited
  and limit edits and remote deletes by message age (24 hours by default, set by Signal) and edits
  to 10 per message.
- An edited message keeps its ID. Signal clients react to an edited message by the edit's
  timestamp; the adapter remembers each edit for 30 days in the Chat state adapter (key
  `signal:edit:<account>:<edit ID>`; persistent only with a persistent state adapter) and reports
  such reactions with the message's ID.
- `addReaction` and `removeReaction` react to any message of the Conversation; Chat SDK emoji
  (`emoji.thumbs_up`) and their names become Unicode, other strings are sent as they are and should
  be one emoji. Signal keeps one reaction per user per message, so a new reaction replaces the bot's
  previous one.
- Incoming reactions in 1:1 Conversations and Groups fire `onReaction` with `added` (true or false),
  the normalized `emoji` (`rawEmoji` is Signal's Unicode; skin-tone variants such as 👍🏽 match only
  by `rawEmoji`) and the reacted-to `messageId`; reactions to stories are ignored. A reaction to another
  user's edited message carries that edit's timestamp in `messageId` (the adapter ignores others' edits).
- `thread.markAsRead()` sends a read receipt to the message's author (in a Group, only the author
  sees it); not for the Bot Account's own messages.

## Streaming and typing

`thread.startTyping()` shows Signal's typing indicator and re-sends it every 10 seconds (Signal
clients hide it 15 seconds after the last one) until the bot posts to the Conversation (the message
clears the indicator; a post that fails sends Signal's typing STOP instead), `adapter.endTyping()`
sends a STOP, or 2 minutes pass, so a handler that fails before replying does not leave the bot
typing. Signal shows no status text.

`thread.post(stream)` (an AI SDK text or full stream, or any async iterable of text) shows the typing
indicator while the stream runs, then sends the whole answer as one markdown message. It never posts
a draft and edits it: Signal allows 10 edits per message and marks edited messages. A stream that
fails, or ends without text, sends nothing, stops the indicator, and rejects (`ValidationError` for
an empty one, also when the turn is aborted before any text). A turn aborted later posts the text
so far.

Signal takes up to 64 KiB of UTF-8 text per message (signal-cli sends text over 2000 bytes as a
long-text attachment that clients show in place of the message, as Signal's apps do). A longer
post or streamed answer goes out as several messages, split at the last paragraph break that fits
(else a line break, else a space), each with its own formatting; files go with the first part. The first message's ID stands for
the reply: `sent.edit()` and `sent.delete()` act on that message only. If a later part fails to
send, the earlier ones stay sent and the post rejects.

## Formatting

Signal styles text with separate ranges rather than markup; the adapter converts both ways.

Outbound, `{ markdown }`, `{ ast }` and cards are sent as plain text with Signal text styles:

| Markdown | On Signal |
|---|---|
| `**bold**`, `_italic_`, `~~strike~~` | bold, italic, strikethrough |
| `` `code` ``, fenced code blocks | monospace (fences dropped) |
| `\|\|spoiler\|\|` | spoiler; an unpaired `\|\|`, or a pair split across `**`/`_` boundaries, stays text (so does `\|\|` in card data) |
| `# Heading` | bold line |
| `- item`, `1. item`, `- [x] task` | `• item`, `1. item`, `• ☑ task` (nested lists indented) |
| `[label](url)`, `<url>` | `label (url)`, `url` |
| `> quote` | `> quote` |
| tables | monospace text table |

A plain string or `{ raw }` is sent verbatim, without styles. Cards render as formatted text: bold
title, subtitle, text (as markdown), bold field labels, links and link buttons as URLs, tables as
monospace; other buttons and selects are dropped, as Signal has no interactive elements.
A card's `fallbackText`, when set, is sent instead, verbatim.

Inbound, Signal's bold, italic, strikethrough, monospace and spoiler ranges arrive in
`message.formatted` as the matching markdown nodes (a spoiler as `||text||`, monospace spanning
several whole lines as a code block). `message.text` is the text as sent, with mentions resolved. Text
without styles is taken literally: `*stars*` and `||bars||` typed on Signal stay as typed, also
when `message.formatted` is posted back.

## Attachments

Attachments travel through signal-cli's JSON-RPC, never through a shared file system, so they work
with signal-cli on another host or in a container.

- Outgoing: `files` (and postable `attachments` that carry `data`) are sent as RFC 2397 data URIs,
  `data:<MIME type>;filename=<name>;base64,<data>`; a file without `mimeType` goes as
  `application/octet-stream`. URL-only attachments, data that is not a Buffer, Blob or ArrayBuffer, empty
  files, invalid MIME types, and files or attachments on an edit are a `ValidationError`.
- Incoming: `message.attachments` carry `type` (image, video, audio or file), `name`, `mimeType` (an invalid
  one is dropped), `size` and, when Signal sends them, `width`/`height`; `fetchData()` asks signal-cli for the content
  (`getAttachment`). signal-cli must have the file (it downloads attachments on receive unless run
  with `--ignore-attachments`), else `fetchData()` rejects with `ResourceNotFoundError`. Attachments
  of messages read back through `fetchMessages` can still fetch their content. View-once messages are ignored.
- Both ways the whole file is one base64 JSON-RPC message, held in memory (signal-cli 0.14.9 refuses
  attachments over 150 MiB).
- Deadline: a `send` with attachments and a `getAttachment` (`fetchData()`) may take `requestTimeoutMs`
  plus 1 ms per 64 bytes of base64 content, i.e. the transfer may run as slow as 64 kB/s (about
  512 kbit/s): a 10 MiB file adds about 3.6 minutes. A `send` answers only after signal-cli has also
  uploaded the files to Signal, so both legs share that allowance. `fetchData()` sizes it from the
  attachment's `size`; without one it allows for 150 MiB (about 55 minutes). A daemon that never answers
  still fails the request with the usual `NetworkError` ("… did not answer within N ms") once the
  deadline passes. On a slower link, raise `requestTimeoutMs`.

## History, users and DMs

Signal keeps no history on a server, so the adapter sets `persistThreadHistory` and Chat records
each Conversation in its state adapter: every message it hands to a handler and every
`thread.post`. `fetchMessages` (and so `thread.messages`, `thread.allMessages`, `chat.history.thread`)
returns that record, oldest first, paged by message ID: what the bot saw since it started, within
Chat's `history.thread` limits (default 100 messages per Conversation, 7 days). Recorded messages have
`raw: null`, and the bot's own posts carry Chat's `author.userId: "self"` with `isMe: true`.
The record is keyed by thread ID only, so give each Bot Account its own state store. Recording
needs the state store: a handler still running after `chat.shutdown()` gets an error from
`thread.post` even though signal-cli already sent the message.

`fetchThread` names a 1:1 Conversation after the user (`metadata.aci`; the ACI when signal-cli knows
no name) and a Group after its Signal name (`metadata.groupId`, `description`, `members` as ACIs,
leaving out members signal-cli knows no ACI for); a Group the Bot Account is not or no longer in
throws `ResourceNotFoundError`. `getUser(aci)` returns `userId` and `userName` as the ACI and
`fullName` as signal-cli names the sender in messages (nickname, contact name, profile name), failing
those the phone number, then the username; `null` when signal-cli knows none of these for the ACI.

`adapter.openDM(user)` takes an ACI, a phone number (`+15550001111`) or `u:<username>` and returns
`signal:dm:<ACI>`; signal-cli looks numbers and usernames up on the Signal server, and a user it
finds no ACI for (unknown, or a number its owner hides) throws `ResourceNotFoundError`. Chat's own
`chat.openDM(...)` and `chat.getUser(...)` cannot tell a Signal ID from another platform's, so call
the adapter and open the thread yourself:

```ts
const signal = chat.getAdapter("signal");
const thread = chat.thread(await signal.openDM("+15550001111"));
await thread.post("Hello!");
```

## Errors

signal-cli failures surface as `@chat-adapter/shared` errors (signal-cli JSON-RPC codes in parentheses):

| Error | When |
|---|---|
| `AuthenticationError` | HTTP 401/403 (e.g. from a reverse proxy), or the daemon does not serve the Bot Account (`-32602` "Specified account does not exist", or the account is missing from `listAccounts`/`listContacts` at startup) |
| `AdapterRateLimitError` | signal-cli rate-limit error (`-5`), or HTTP 429; `retryAfter` in seconds when known |
| `ResourceNotFoundError` | The recipient is not registered with Signal (`-1`); `openDM` finds no ACI for a number or username; `fetchThread` of a Group the Bot Account is not in; an attachment's `fetchData()` when signal-cli has no such attachment (`-1`) |
| `ValidationError` | Invalid request or parameters (`-32600`, other `-32602`, other `-1` user errors) |
| `NetworkError` | signal-cli unreachable or not startable, a request not answered within `requestTimeoutMs` (longer for attachment transfers, see [Attachments](#attachments)), a spawned signal-cli that exited, a dropped socket, other HTTP failures, malformed replies, signal-cli I/O errors (`-3`), or a send where every recipient failed on the network (`-1` with `NETWORK_FAILURE` results) |
| `AdapterError` with `code` | `UNTRUSTED_IDENTITY` (`-4`), `CAPTCHA_REJECTED` (`-6`), `METHOD_NOT_FOUND` (`-32601`), `SIGNAL_CLI_ERROR` (anything else, e.g. `-32603`); from `initialize()`, `STARTUP_CANCELLED` when `disconnect()` ran during startup |

signal-cli 0.14.9 reports an I/O failure during `send` as an internal error (`-32603`, "Failed to send message: … (IOException)"),
so it arrives as `AdapterError` with code `SIGNAL_CLI_ERROR`, not as `NetworkError`.

## License

MIT. signal-cli (GPLv3) and libsignal (AGPLv3) are separate programs that this package
only talks to over signal-cli's JSON-RPC protocol.
