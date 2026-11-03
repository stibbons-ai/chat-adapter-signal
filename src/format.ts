import {
  BaseFormatConverter,
  cardChildToFallbackText,
  chartElementToFallbackText,
  parseMarkdown,
  root,
  tableElementToAscii,
  tableToAscii,
  type AdapterPostableMessage,
  type CardChild,
  type CardElement,
  type Content,
  type Nodes,
  type Root,
} from "chat";

/** The Signal text styles this adapter reads and writes (`NONE` carries nothing). */
export type SignalStyle = "BOLD" | "ITALIC" | "STRIKETHROUGH" | "MONOSPACE" | "SPOILER";

/** A styled range of a Signal message; `start` and `length` count UTF-16 code units, like JavaScript strings. */
export interface SignalStyleRange {
  style: SignalStyle;
  start: number;
  length: number;
}

/** A Signal message body: plain text plus the ranges Signal clients style. */
export interface SignalText {
  text: string;
  styles: SignalStyleRange[];
}

/** An inbound native @mention: `length` UTF-16 code units at `start` (Signal puts U+FFFC there) stand for the user. */
export interface SignalMention {
  start: number;
  length: number;
  /** What the mention reads as in the text, e.g. `@echo-bot`. */
  text: string;
}

const SPOILER_MARKER = "||";
/** Every Signal style this adapter handles, in the order inbound styles nest in the markdown AST (outermost first); MONOSPACE is a leaf (`inlineCode`). */
export const SIGNAL_STYLES: readonly SignalStyle[] = ["SPOILER", "BOLD", "ITALIC", "STRIKETHROUGH", "MONOSPACE"];
const PARAGRAPH_BREAK = /\n{2,}/g;

/**
 * Converts between markdown and Signal's plain text with separate style
 * ranges. Outbound: bold, italic, strikethrough, inline code and code blocks,
 * and `||spoiler||` become style ranges; headings are bold, lists `•` / `1.`
 * text, links plain URLs. Inbound: style ranges become the matching markdown
 * nodes and mentions readable text.
 */
export class SignalFormatConverter extends BaseFormatConverter {
  fromAst(ast: Root): string {
    return renderAst(ast).text;
  }

  /** Plain Signal text has no markup: it is taken literally. */
  toAst(platformText: string): Root {
    return this.parseSignal(platformText, [], []).ast;
  }

  /**
   * Renders a postable message. Strings and `{ raw }` are sent verbatim;
   * markdown, ASTs and cards get style ranges.
   */
  renderSignal(message: AdapterPostableMessage): SignalText {
    if (typeof message === "string") {
      return { text: message, styles: [] };
    }
    if ("raw" in message) {
      return { text: message.raw, styles: [] };
    }
    if ("markdown" in message) {
      return renderAst(parseMarkdown(message.markdown));
    }
    if ("ast" in message) {
      return renderAst(message.ast);
    }
    // Signal shows no cards, but renders the card itself better than its plain `fallbackText`.
    return renderAst(cardToAst("card" in message ? message.card : message));
  }

  /**
   * Parses an inbound Signal body. `text` is the body with each mention
   * replaced by its readable text; `ast` additionally carries the style ranges
   * as markdown. Out-of-range, overlapping or unknown entries are skipped.
   */
  parseSignal(
    body: string,
    styles: readonly SignalStyleRange[],
    mentions: readonly SignalMention[],
  ): { text: string; ast: Root } {
    const { text, mapStart, mapEnd } = resolveMentions(body, mentions);
    const ranges: SignalStyleRange[] = [];
    for (const range of styles) {
      const end = Math.min(range.start + range.length, body.length);
      if (range.start >= 0 && range.start < end) {
        const start = mapStart(range.start);
        ranges.push({ style: range.style, start, length: mapEnd(end) - start });
      }
    }
    return { text, ast: root(textToBlocks(text, ranges)) };
  }
}

// ---------------------------------------------------------------------------
// Outbound: markdown AST -> text + style ranges

class SignalTextWriter {
  text = "";
  readonly styles: SignalStyleRange[] = [];
  /** Written after every line break: list indentation and block quote markers. */
  private linePrefix = "";

  write(value: string): void {
    const lines = value.split("\n");
    this.text += lines[0];
    for (const line of lines.slice(1)) {
      this.text += `\n${this.linePrefix}${line}`;
    }
  }

  styled(style: SignalStyle, render: () => void): void {
    const start = this.text.length;
    render();
    if (this.text.length > start) {
      this.styles.push({ style, start, length: this.text.length - start });
    }
  }

  indented(prefix: string, render: () => void): void {
    const outer = this.linePrefix;
    this.linePrefix += prefix;
    render();
    this.linePrefix = outer;
  }
}

function renderAst(ast: Root): SignalText {
  const writer = new SignalTextWriter();
  renderBlocks(writer, ast.children, "\n\n");
  return { text: writer.text, styles: writer.styles };
}

function renderBlocks(writer: SignalTextWriter, nodes: readonly Nodes[], separator: string): void {
  let first = true;
  for (const node of nodes) {
    // Link reference definitions and the like render nothing; they must not leave a blank line.
    if (node.type === "definition" || node.type === "footnoteDefinition" || node.type === "yaml") {
      continue;
    }
    if (!first) {
      writer.write(separator);
    }
    first = false;
    renderBlock(writer, node);
  }
}

function renderBlock(writer: SignalTextWriter, node: Nodes): void {
  switch (node.type) {
    case "heading":
      writer.styled("BOLD", () => renderInlines(writer, node.children));
      return;
    case "code":
      writer.styled("MONOSPACE", () => writer.write(node.value));
      return;
    case "blockquote":
      writer.write("> ");
      writer.indented("> ", () => renderBlocks(writer, node.children, "\n\n"));
      return;
    case "list": {
      const start = node.start ?? 1;
      node.children.forEach((item, index) => {
        if (index > 0) {
          writer.write("\n");
        }
        const marker = node.ordered ? `${start + index}. ` : "• ";
        writer.write(marker);
        writer.indented(" ".repeat(marker.length), () => renderBlocks(writer, item.children, "\n"));
      });
      return;
    }
    case "table":
      writer.styled("MONOSPACE", () => writer.write(tableToAscii(node)));
      return;
    case "thematicBreak":
      writer.write("———");
      return;
    case "html":
      writer.write(node.value);
      return;
    case "paragraph":
      renderInlines(writer, node.children);
      return;
    default:
      if ("children" in node) {
        renderInlines(writer, node.children);
      } else {
        renderInline(writer, node);
      }
  }
}

/**
 * Renders a run of sibling inline nodes. `||` in their text pairs up into
 * spoilers, first with second, third with fourth; a marker left over, or
 * pairing with nothing between, stays literal text.
 */
function renderInlines(writer: SignalTextWriter, nodes: readonly Nodes[]): void {
  type Token = Nodes | typeof SPOILER_MARKER;
  const tokens: Token[] = [];
  for (const node of nodes) {
    if (node.type !== "text" || !node.value.includes(SPOILER_MARKER)) {
      tokens.push(node);
      continue;
    }
    node.value.split(SPOILER_MARKER).forEach((part, index) => {
      if (index > 0) {
        tokens.push(SPOILER_MARKER);
      }
      if (part) {
        tokens.push({ type: "text", value: part });
      }
    });
  }

  let open: number | undefined;
  tokens.forEach((token, index) => {
    if (token !== SPOILER_MARKER) {
      renderInline(writer, token);
      return;
    }
    const closes = tokens.indexOf(SPOILER_MARKER, index + 1);
    if (open === undefined) {
      // An opener with no closer, or with nothing before its closer, is literal; so is that closer.
      if (closes === -1 || closes === index + 1) {
        writer.write(SPOILER_MARKER);
        if (closes === index + 1) {
          tokens[closes] = { type: "text", value: SPOILER_MARKER };
        }
        return;
      }
      open = writer.text.length;
      return;
    }
    if (writer.text.length > open) {
      writer.styles.push({ style: "SPOILER", start: open, length: writer.text.length - open });
    }
    open = undefined;
  });
}

function renderInline(writer: SignalTextWriter, node: Nodes): void {
  switch (node.type) {
    case "text":
      writer.write(node.value);
      return;
    case "strong":
      writer.styled("BOLD", () => renderInlines(writer, node.children));
      return;
    case "emphasis":
      writer.styled("ITALIC", () => renderInlines(writer, node.children));
      return;
    case "delete":
      writer.styled("STRIKETHROUGH", () => renderInlines(writer, node.children));
      return;
    case "inlineCode":
      writer.styled("MONOSPACE", () => writer.write(node.value));
      return;
    case "break":
      writer.write("\n");
      return;
    case "link": {
      // Signal links bare URLs itself; a label that differs from the URL keeps the URL after it.
      const label = node.children.map((child) => ("value" in child ? child.value : "")).join("");
      if (label === node.url || `mailto:${label}` === node.url) {
        writer.write(node.url);
      } else {
        renderInlines(writer, node.children);
        writer.write(` (${node.url})`);
      }
      return;
    }
    case "image":
      writer.write(node.alt ? `${node.alt} (${node.url})` : node.url);
      return;
    default:
      if ("children" in node) {
        renderInlines(writer, node.children);
      } else if ("value" in node && typeof node.value === "string") {
        writer.write(node.value);
      }
  }
}

// ---------------------------------------------------------------------------
// Cards -> markdown AST

function cardToAst(card: CardElement): Root {
  const blocks: Content[] = [];
  const header: Content[] = [];
  if (card.title) {
    header.push({ type: "strong", children: [{ type: "text", value: card.title }] });
  }
  if (card.subtitle) {
    if (header.length > 0) {
      header.push({ type: "break" });
    }
    header.push({ type: "text", value: card.subtitle });
  }
  if (header.length > 0) {
    blocks.push({ type: "paragraph", children: header as never });
  }
  if (card.imageUrl) {
    blocks.push(linkParagraph(card.imageUrl, card.imageUrl));
  }
  for (const child of card.children) {
    blocks.push(...cardChildToAst(child));
  }
  return root(blocks);
}

function cardChildToAst(child: CardChild): Content[] {
  switch (child.type) {
    case "text": {
      const content = parseMarkdown(child.content).children;
      const style = child.style === "bold" ? "strong" : child.style === "muted" ? "emphasis" : undefined;
      if (!style) {
        return content;
      }
      return content.map((block) =>
        block.type === "paragraph" ? { type: "paragraph", children: [{ type: style, children: block.children }] } : block,
      );
    }
    case "image":
      return [linkParagraph(child.url, child.alt || child.url)];
    case "link":
      return [linkParagraph(child.url, child.label)];
    case "divider":
      return [{ type: "thematicBreak" }];
    case "section":
      return child.children.flatMap(cardChildToAst);
    case "fields":
      return [
        {
          type: "paragraph",
          children: child.children.flatMap((field, index) => [
            ...(index > 0 ? [{ type: "break" } as const] : []),
            { type: "strong", children: [{ type: "text", value: field.label }] } as const,
            { type: "text", value: `: ${field.value}` } as const,
          ]),
        },
      ];
    case "table":
      return [{ type: "code", value: tableElementToAscii(child.headers, child.rows) }];
    case "chart":
      return [{ type: "code", value: chartElementToFallbackText(child) }];
    case "actions":
      // Buttons and selects need interactivity Signal lacks; link buttons are just links.
      return child.children.flatMap((action) =>
        action.type === "link-button" ? [linkParagraph(action.url, action.label)] : [],
      );
    default: {
      const text = cardChildToFallbackText(child);
      return text ? [{ type: "paragraph", children: [{ type: "text", value: text }] }] : [];
    }
  }
}

function linkParagraph(url: string, label: string): Content {
  return { type: "paragraph", children: [{ type: "link", url, children: [{ type: "text", value: label }] }] };
}

// ---------------------------------------------------------------------------
// Inbound: text + style ranges -> markdown AST

/** Replaces mentions with their text and maps offsets in the body to offsets in the result. */
function resolveMentions(body: string, mentions: readonly SignalMention[]) {
  const valid: SignalMention[] = [];
  let end = 0;
  for (const mention of [...mentions].sort((a, b) => a.start - b.start)) {
    if (mention.start >= end && mention.length > 0 && mention.start + mention.length <= body.length) {
      valid.push(mention);
      end = mention.start + mention.length;
    }
  }

  let text = "";
  let cursor = 0;
  for (const mention of valid) {
    text += body.slice(cursor, mention.start) + mention.text;
    cursor = mention.start + mention.length;
  }
  text += body.slice(cursor);

  // An offset inside a mention moves to the mention's start (a range start) or end (a range end).
  const map = (offset: number, inside: "start" | "end") => {
    let shift = 0;
    for (const mention of valid) {
      if (offset <= mention.start) {
        break;
      }
      if (offset < mention.start + mention.length) {
        return mention.start + shift + (inside === "end" ? mention.text.length : 0);
      }
      shift += mention.text.length - mention.length;
    }
    return offset + shift;
  };
  return { text, mapStart: (offset: number) => map(offset, "start"), mapEnd: (offset: number) => map(offset, "end") };
}

/** A run of text with one set of active styles. */
interface Segment {
  start: number;
  end: number;
  styles: ReadonlySet<SignalStyle>;
}

/** Cuts `[0, length)` at every range boundary; one sweep, so many ranges stay cheap. */
function segment(length: number, ranges: readonly SignalStyleRange[]): Segment[] {
  const events: Array<{ at: number; style: SignalStyle; delta: 1 | -1 }> = [];
  for (const range of ranges) {
    events.push({ at: range.start, style: range.style, delta: 1 }, { at: range.start + range.length, style: range.style, delta: -1 });
  }
  events.sort((a, b) => a.at - b.at);
  const active = new Map<SignalStyle, number>();
  const segments: Segment[] = [];
  let position = 0;
  let index = 0;
  while (position < length) {
    while (index < events.length && events[index]!.at <= position) {
      const { style, delta } = events[index++]!;
      active.set(style, (active.get(style) ?? 0) + delta);
    }
    const end = Math.min(events[index]?.at ?? length, length);
    const styles = new Set([...active].filter(([, count]) => count > 0).map(([style]) => style));
    segments.push({ start: position, end, styles });
    position = end;
  }
  return segments;
}

/**
 * Splits text into paragraphs at blank lines. A MONOSPACE run that spans
 * whole lines and more than one of them becomes a code block.
 */
function textToBlocks(text: string, ranges: readonly SignalStyleRange[]): Content[] {
  const segments = segment(text.length, ranges);
  const codeBlocks: Array<{ start: number; end: number }> = [];
  for (const run of monospaceRuns(segments)) {
    const startsLine = run.start === 0 || text[run.start - 1] === "\n";
    const endsLine = run.end === text.length || text[run.end] === "\n";
    if (startsLine && endsLine && text.slice(run.start, run.end).includes("\n")) {
      codeBlocks.push(run);
    }
  }

  const blocks: Content[] = [];
  const paragraphs = (from: number, to: number) => {
    let start = from;
    for (const separator of text.slice(from, to).matchAll(PARAGRAPH_BREAK)) {
      blocks.push(...paragraph(segments, text, start, from + separator.index));
      start = from + separator.index + separator[0].length;
    }
    blocks.push(...paragraph(segments, text, start, to));
  };
  let cursor = 0;
  for (const code of codeBlocks) {
    paragraphs(cursor, code.start);
    blocks.push({ type: "code", value: text.slice(code.start, code.end) });
    cursor = code.end;
  }
  paragraphs(cursor, text.length);
  return blocks;
}

function monospaceRuns(segments: readonly Segment[]): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = [];
  for (const { start, end, styles } of segments) {
    if (!styles.has("MONOSPACE")) {
      continue;
    }
    const last = runs.at(-1);
    if (last?.end === start) {
      last.end = end;
    } else {
      runs.push({ start, end });
    }
  }
  return runs;
}

/** The paragraph for `[from, to)` without its surrounding line breaks, or nothing when that is empty. */
function paragraph(segments: readonly Segment[], text: string, from: number, to: number): Content[] {
  while (from < to && text[from] === "\n") from++;
  while (to > from && text[to - 1] === "\n") to--;
  if (from === to) {
    return [];
  }
  const pieces = segments
    .filter((piece) => piece.end > from && piece.start < to)
    .map((piece) => ({ value: text.slice(Math.max(piece.start, from), Math.min(piece.end, to)), styles: piece.styles }));
  return [{ type: "paragraph", children: inlines(pieces, 0) as never }];
}

type Piece = { value: string; styles: ReadonlySet<SignalStyle> };

/** Nests pieces by style in `SIGNAL_STYLES` order: consecutive pieces sharing a style share one node. */
function inlines(pieces: readonly Piece[], depth: number): Content[] {
  const style = SIGNAL_STYLES[depth];
  if (!style) {
    return pieces.flatMap((piece) => textWithBreaks(piece.value));
  }
  const nodes: Content[] = [];
  let index = 0;
  while (index < pieces.length) {
    const styled = pieces[index]!.styles.has(style);
    let end = index;
    while (end < pieces.length && pieces[end]!.styles.has(style) === styled) end++;
    const run = pieces.slice(index, end);
    index = end;
    if (!styled) {
      nodes.push(...inlines(run, depth + 1));
    } else if (style === "MONOSPACE") {
      nodes.push({ type: "inlineCode", value: run.map((piece) => piece.value).join("") });
    } else if (style === "SPOILER") {
      nodes.push({ type: "text", value: SPOILER_MARKER }, ...inlines(run, depth + 1), { type: "text", value: SPOILER_MARKER });
    } else {
      const type = style === "BOLD" ? "strong" : style === "ITALIC" ? "emphasis" : "delete";
      nodes.push({ type, children: inlines(run, depth + 1) } as Content);
    }
  }
  return nodes;
}

function textWithBreaks(value: string): Content[] {
  return value.split("\n").flatMap((line, index): Content[] => [
    ...(index > 0 ? [{ type: "break" } as const] : []),
    ...(line ? [{ type: "text", value: line } as const] : []),
  ]);
}
