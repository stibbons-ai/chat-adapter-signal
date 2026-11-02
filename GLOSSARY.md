# Signal Adapter

Connects Chat SDK bots to Signal by talking to a separately installed signal-cli.

## Language

**Bot Account**:
The single Signal account a bot speaks as: either a dedicated number or a linked device of a personal number.
_Avoid_: bot number, user, identity

**Conversation**:
A Signal 1:1 chat or Group as a whole; Signal has no threads, so a Conversation is both the Chat SDK Thread and its Channel.
_Avoid_: chat, room, thread (when meaning the Signal side)

**Group**:
A Signal Groups v2 Conversation with more than two members.
_Avoid_: channel, room, legacy group

**Host App**:
The application that runs Chat SDK with this adapter inside it, e.g. a Mastra server; it must stay running to keep receiving from signal-cli.
_Avoid_: app, server, bot (when meaning the process)

**Mention**:
A group message that addresses the Bot Account, either by a native Signal @mention or by quote-replying to one of the Bot Account's own messages; name text alone is not a Mention.
_Avoid_: ping, tag
