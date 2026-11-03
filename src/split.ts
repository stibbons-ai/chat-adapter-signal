import type { SignalText } from "./format.js";

/**
 * Signal's per-message text limit in UTF-8 bytes. signal-cli sends a body over 2000 bytes trimmed,
 * with the full text as a long-text attachment that clients show in its place, as Signal's own
 * clients do; those send at most 64 KiB that way (Signal-Android `MAX_TOTAL_BODY_SIZE_BYTES`).
 */
const MAX_MESSAGE_BYTES = 64 * 1024;

/** Where a part may end, best first: a paragraph break, a line break, a space. Each drops its run of its first character. */
const BREAKS = ["\n\n", "\n", " "] as const;

/**
 * Splits a message body longer than Signal's limit into several, each ending at the last
 * paragraph break that fits, else the last line break, else the last space, else between two
 * characters. The break itself is dropped; style ranges are clipped to each part and re-based.
 */
export function splitSignalText(body: SignalText): SignalText[] {
  const { text, styles } = body;
  if (Buffer.byteLength(text) <= MAX_MESSAGE_BYTES) {
    return [body];
  }
  const parts: SignalText[] = [];
  let start = 0;
  while (start < text.length) {
    const fit = fittingEnd(text, start, MAX_MESSAGE_BYTES);
    let end = fit;
    let next = fit;
    if (fit < text.length) {
      for (const separator of BREAKS) {
        const at = text.lastIndexOf(separator, fit);
        if (at > start) {
          end = at;
          next = at;
          while (text[next] === separator[0]) next++;
          break;
        }
      }
    }
    const clipped = styles.flatMap((range) => {
      const from = Math.max(range.start, start);
      const to = Math.min(range.start + range.length, end);
      return to > from ? [{ style: range.style, start: from - start, length: to - from }] : [];
    });
    parts.push({ text: text.slice(start, end), styles: clipped });
    start = next;
  }
  return parts;
}

/** The furthest UTF-16 index after `start` whose text from `start` is at most `maxBytes` UTF-8 bytes, never inside a surrogate pair. */
function fittingEnd(text: string, start: number, maxBytes: number): number {
  let bytes = 0;
  let index = start;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    const low = text.charCodeAt(index + 1);
    const pair = code >= 0xd800 && code <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
    // A lone surrogate is sent as U+FFFD, 3 bytes.
    const size = pair ? 4 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    if (bytes + size > maxBytes) {
      break;
    }
    bytes += size;
    index += pair ? 2 : 1;
  }
  return index;
}
