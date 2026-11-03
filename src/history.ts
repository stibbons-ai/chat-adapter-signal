import type { FetchOptions, FetchResult, Message } from "chat";

/** Page size when the caller gives no `limit`: Chat's default history length, so one page holds it all. */
const DEFAULT_LIMIT = 100;

/**
 * One page of a Conversation's recorded history (oldest first), as Chat's
 * `FetchOptions` describe it: `backward` (default) takes the newest messages
 * before the cursor, `forward` the oldest after it. The cursor is the ID of the
 * page's last message in paging direction; a cursor no longer in the history
 * (trimmed or expired) yields an empty page.
 */
export function historyPage<T>(messages: Message<T>[], options: FetchOptions): FetchResult<T> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const at = options.cursor === undefined ? undefined : messages.findIndex((message) => message.id === options.cursor);
  if (at === -1) {
    return { messages: [] };
  }
  const forward = options.direction === "forward";
  let start: number;
  let end: number;
  if (forward) {
    start = at === undefined ? 0 : at + 1;
    end = Math.min(messages.length, start + limit);
  } else {
    end = at ?? messages.length;
    start = Math.max(0, end - limit);
  }
  const page = messages.slice(start, end);
  const more = forward ? end < messages.length : start > 0;
  const nextCursor = more ? page.at(forward ? -1 : 0)?.id : undefined;
  return nextCursor === undefined ? { messages: page } : { messages: page, nextCursor };
}
