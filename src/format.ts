import {
  BaseFormatConverter,
  cardChildToFallbackText,
  chartElementToFallbackText,
  codeBlock,
  emphasis,
  inlineCode,
  link,
  paragraph,
  parseMarkdown,
  root,
  strikethrough,
  strong,
  tableElementToAscii,
  tableToAscii,
  text,
  toPlainText,
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
  replacement: string;
}

const SPOILER_MARKER = "||";
/** Every Signal style this adapter handles, in the order inbound styles nest in the markdown AST (outermost first); MONOSPACE is a leaf (`inlineCode`). */
const SIGNAL_STYLES: readonly SignalStyle[] = ["SPOILER", "BOLD", "ITALIC", "STRIKETHROUGH", "MONOSPACE"];
const BREAK = { type: "break" } as const;
const PARAGRAPH_BREAK = /\n{2,}/g;

/**
 * Converts between markdown and Signal's plain text with separate style
 * ranges. Outbound: bold, italic, strikethrough, inline code and code blocks,
 * and `||spoiler||` become style ranges; headings are bold, lists `•` / `1.`
 * text, links plain URLs. Inbound: style ranges become the matching markdown
 * nodes and mentions readable text.
 */
export class SignalFormatConverter extends BaseFormatConverter {
  /** The plain text only: style ranges need `renderSignal`, as a string cannot carry them. */
  fromAst(ast: Root): string {
    return renderAst(ast).text;
  }

  /** Plain Signal text has no markup: it is taken literally. */
  toAst(platformText: string): Root {
    return this.parseSignal(platformText, [], []).ast;
  }

  /** The text `renderSignal` sends, so every path renders a message the same way. */
  override renderPostable(message: AdapterPostableMessage): string {
    return this.renderSignal(message).text;
  }

  /**
   * Renders a postable message. Strings, `{ raw }` and a card's
   * `fallbackText` are sent verbatim; markdown, ASTs and cards get style ranges.
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
    if ("card" in message && message.fallbackText) {
      return { text: message.fallbackText, styles: [] };
    }
    if ("card" in message) {
      return renderAst(cardToAst(message.card));
    }
    if (message.type === "card") {
      return renderAst(cardToAst(message));
    }
    throw new Error("Invalid PostableMessage format");
  }

  /**
   * Parses an inbound Signal body. `text` is the body with each mention
   * replaced by its readable text; `ast` additionally carries the style ranges
   * as markdown. Out-of-range ranges are clipped or skipped, as are
   * overlapping or out-of-range mentions; overlapping ranges nest.
   */
  parseSignal(
    body: string,
    styles: readonly SignalStyleRange[],
    mentions: readonly SignalMention[],
  ): { text: string; ast: Root } {
    const { text, mapStart, mapEnd } = resolveMentions(body, mentions);
    const ranges: SignalStyleRange[] = [];
    for (const range of styles) {
      let start = range.start;
      let end = Math.min(range.start + range.length, body.length);
      // A range must not split an emoji or other surrogate pair: widen it to whole characters.
      if (isLowSurrogate(body, start)) start--;
      if (isLowSurrogate(body, end)) end++;
      if (start < 0 || start >= end) {
        continue;
      }
      start = mapStart[start]!;
      end = mapEnd[end]!;
      // Clients style a selection's edge spaces too; markdown can't express those (`** a**` is no emphasis).
      if (range.style !== "MONOSPACE") {
        while (start < end && /\s/.test(text[start]!)) start++;
        while (end > start && /\s/.test(text[end - 1]!)) end--;
      }
      if (start < end) {
        ranges.push({ style: range.style, start, length: end - start });
      }
    }
    return { text, ast: root(textToBlocks(text, ranges)) };
  }
}

export function isSignalStyle(value: unknown): value is SignalStyle {
  return (SIGNAL_STYLES as readonly unknown[]).includes(value);
}

function isLowSurrogate(value: string, index: number): boolean {
  const code = value.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff && index > 0;
}

// ---------------------------------------------------------------------------
// Outbound: markdown AST -> text + style ranges

class SignalTextWriter {
  text = "";
  readonly styles: SignalStyleRange[] = [];
  /** Written after every line break: list indentation and block quote markers. */
  private linePrefix = "";

  /** Resolves reference-style links and images: identifier -> URL. */
  readonly definitions: ReadonlyMap<string, string>;

  constructor(definitions: ReadonlyMap<string, string>) {
    this.definitions = definitions;
  }

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
    const length = this.text.length - start;
    const inner = this.styles.at(-1);
    // `# **Title**` styles the same text bold twice; one range is enough.
    if (length > 0 && !(inner?.style === style && inner.start === start && inner.length === length)) {
      this.styles.push({ style, start, length });
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
  const definitions = new Map<string, string>();
  const collect = (nodes: readonly Nodes[]) => {
    for (const node of nodes) {
      if (node.type === "definition") {
        definitions.set(node.identifier, node.url);
      } else if ("children" in node) {
        collect(node.children);
      }
    }
  };
  collect(ast.children);
  const writer = new SignalTextWriter(definitions);
  renderBlocks(writer, ast.children, "\n\n");
  return { text: writer.text, styles: writer.styles };
}

function renderBlocks(writer: SignalTextWriter, nodes: readonly Nodes[], separator: string): void {
  let first = true;
  for (const node of nodes) {
    // Link reference definitions render nothing; they must not leave a blank line.
    if (node.type === "definition" || node.type === "yaml") {
      continue;
    }
    const before = writer.text.length;
    if (!first) {
      writer.write(separator);
    }
    const start = writer.text.length;
    renderBlock(writer, node);
    if (writer.text.length === start) {
      // An empty block (an empty code block, say) takes its separator back.
      writer.text = writer.text.slice(0, before);
    } else {
      first = false;
    }
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
        const checkbox = item.checked === true ? "☑ " : item.checked === false ? "☐ " : "";
        const marker = `${node.ordered ? `${start + index}.` : "•"} ${checkbox}`;
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
    case "footnoteDefinition":
      writer.write(`[^${node.label ?? node.identifier}]: `);
      renderBlocks(writer, node.children, "\n");
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
 * pairing with nothing between, stays literal text. Card data (`LITERAL_TEXT`)
 * is never markup.
 */
function renderInlines(writer: SignalTextWriter, nodes: readonly Nodes[]): void {
  type Token = Nodes | typeof SPOILER_MARKER;
  const tokens: Token[] = [];
  for (const node of nodes) {
    if (node.type !== "text" || LITERAL_TEXT.has(node) || !node.value.includes(SPOILER_MARKER)) {
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
    case "link":
      renderLink(writer, node.url, node.children);
      return;
    case "linkReference": {
      const url = writer.definitions.get(node.identifier);
      if (url === undefined) {
        renderInlines(writer, node.children);
      } else {
        renderLink(writer, url, node.children);
      }
      return;
    }
    case "image":
      writer.write(node.alt ? `${node.alt} (${node.url})` : node.url);
      return;
    case "imageReference": {
      const url = writer.definitions.get(node.identifier);
      writer.write([node.alt, url && `(${url})`].filter(Boolean).join(" "));
      return;
    }
    case "footnoteReference":
      writer.write(`[^${node.label ?? node.identifier}]`);
      return;
    default:
      if ("children" in node) {
        renderInlines(writer, node.children);
      } else if ("value" in node && typeof node.value === "string") {
        writer.write(node.value);
      }
  }
}

/** Signal links bare URLs itself; a label that differs from the URL keeps the URL after it. */
function renderLink(writer: SignalTextWriter, url: string, children: readonly Nodes[]): void {
  const label = toPlainText(root([paragraph(children as Content[])]));
  if (!label || label === url) {
    writer.write(url);
  } else if (`mailto:${label}` === url || `http://${label}` === url) {
    // A GFM autolinked e-mail address or `www.` link: the text as written.
    writer.write(label);
  } else {
    renderInlines(writer, children);
    writer.write(` (${url})`);
  }
}

// ---------------------------------------------------------------------------
// Cards -> markdown AST

/** Text that is data, not markup (card titles, field values, labels; inbound Signal text): never read as `||` spoilers. */
const LITERAL_TEXT = new WeakSet<Nodes>();

function literal(value: string): Content {
  const node = text(value);
  LITERAL_TEXT.add(node);
  return node;
}

function cardToAst(card: CardElement): Root {
  const blocks: Content[] = [];
  const header: Content[] = [];
  if (card.title) {
    header.push(strong([literal(card.title)]));
  }
  if (card.subtitle) {
    if (header.length > 0) {
      header.push(BREAK);
    }
    header.push(literal(card.subtitle));
  }
  if (header.length > 0) {
    blocks.push(paragraph(header));
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
      const style = child.style === "bold" ? strong : child.style === "muted" ? emphasis : undefined;
      if (!style) {
        return content;
      }
      return content.map((block) => (block.type === "paragraph" ? paragraph([style(block.children)]) : block));
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
        paragraph(
          child.children.flatMap((field, index) => [
            ...(index > 0 ? [BREAK] : []),
            strong([literal(field.label)]),
            literal(`: ${field.value}`),
          ]),
        ),
      ];
    case "table":
      return [codeBlock(tableElementToAscii(child.headers, child.rows))];
    case "chart":
      return [codeBlock(chartElementToFallbackText(child))];
    case "actions":
      // Buttons and selects need interactivity Signal lacks; link buttons are just links.
      return child.children.flatMap((action) =>
        action.type === "link-button" ? [linkParagraph(action.url, action.label)] : [],
      );
    default: {
      const fallback = cardChildToFallbackText(child);
      return fallback ? [paragraph([literal(fallback)])] : [];
    }
  }
}

function linkParagraph(url: string, label: string): Content {
  return paragraph([link(url, [literal(label)])]);
}

// ---------------------------------------------------------------------------
// Inbound: text + style ranges -> markdown AST

/**
 * Replaces mentions with their text. `mapStart` / `mapEnd` map every offset in
 * the body to the result (one lookup each, however many mentions): an offset
 * inside a mention moves to the mention's start for a range start, its end
 * for a range end.
 */
function resolveMentions(body: string, mentions: readonly SignalMention[]) {
  let text = "";
  const mapStart = new Uint32Array(body.length + 1);
  const mapEnd = new Uint32Array(body.length + 1);
  let cursor = 0;
  for (const mention of [...mentions].sort((a, b) => a.start - b.start)) {
    const end = mention.start + mention.length;
    if (mention.start < cursor || mention.length === 0 || end > body.length) {
      continue;
    }
    text += body.slice(cursor, mention.start);
    for (; cursor <= mention.start; cursor++) {
      mapStart[cursor] = mapEnd[cursor] = text.length - (mention.start - cursor);
    }
    const start = text.length;
    text += mention.replacement;
    for (; cursor < end; cursor++) {
      mapStart[cursor] = start;
      mapEnd[cursor] = text.length;
    }
  }
  const rest = text.length - cursor;
  text += body.slice(cursor);
  for (; cursor <= body.length; cursor++) {
    mapStart[cursor] = mapEnd[cursor] = cursor + rest;
  }
  return { text, mapStart, mapEnd };
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
  const codeBlocks = monospaceRuns(segments)
    .map(({ start, end }) => {
      // A selection of whole lines often takes the line break after (or before) them too.
      while (start < end && text[start] === "\n") start++;
      while (end > start && text[end - 1] === "\n") end--;
      return { start, end };
    })
    .filter(
      ({ start, end }) =>
        (start === 0 || text[start - 1] === "\n") &&
        (end === text.length || text[end] === "\n") &&
        text.slice(start, end).includes("\n"),
    );

  const blocks: Content[] = [];
  // Paragraphs come in order, so the first segment a paragraph needs never lies before the previous one's.
  let first = 0;
  const addParagraph = (from: number, to: number) => {
    while (from < to && text[from] === "\n") from++;
    while (to > from && text[to - 1] === "\n") to--;
    if (from === to) {
      return;
    }
    while (segments[first]!.end <= from) first++;
    const pieces: Piece[] = [];
    for (let index = first; index < segments.length && segments[index]!.start < to; index++) {
      const piece = segments[index]!;
      pieces.push({ value: text.slice(Math.max(piece.start, from), Math.min(piece.end, to)), styles: piece.styles });
    }
    blocks.push(paragraph(inlines(pieces, 0)));
  };
  const paragraphs = (from: number, to: number) => {
    let start = from;
    for (const separator of text.slice(from, to).matchAll(PARAGRAPH_BREAK)) {
      addParagraph(start, from + separator.index);
      start = from + separator.index + separator[0].length;
    }
    addParagraph(start, to);
  };
  let cursor = 0;
  for (const code of codeBlocks) {
    paragraphs(cursor, code.start);
    blocks.push(codeBlock(text.slice(code.start, code.end)));
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


type Piece = { value: string; styles: ReadonlySet<SignalStyle> };

/** Nests pieces by style in `SIGNAL_STYLES` order: consecutive pieces sharing a style share one node. */
function inlines(pieces: readonly Piece[], depth: number): Content[] {
  const style = SIGNAL_STYLES[depth];
  if (!style) {
    return pieces.flatMap((piece) => textWithBreaks(piece.value));
  }
  const nodes: Content[] = [];
  // Appended one by one, not push(...): a long hostile message must not overflow the argument stack.
  const append = (more: readonly Content[]) => {
    for (const node of more) nodes.push(node);
  };
  let index = 0;
  while (index < pieces.length) {
    const styled = pieces[index]!.styles.has(style);
    let end = index;
    while (end < pieces.length && pieces[end]!.styles.has(style) === styled) end++;
    const run = pieces.slice(index, end);
    index = end;
    if (!styled) {
      append(inlines(run, depth + 1));
    } else if (style === "MONOSPACE") {
      nodes.push(inlineCode(run.map((piece) => piece.value).join("")));
    } else if (style === "SPOILER") {
      append([text(SPOILER_MARKER), ...inlines(run, depth + 1), text(SPOILER_MARKER)]);
    } else {
      const node = style === "BOLD" ? strong : style === "ITALIC" ? emphasis : strikethrough;
      nodes.push(node(inlines(run, depth + 1)));
    }
  }
  return nodes;
}

/** Inbound text is literal: a `||` typed without a spoiler style stays `||` when the AST is posted back. */
function textWithBreaks(value: string): Content[] {
  return value
    .split("\n")
    .flatMap((line, index): Content[] => [...(index > 0 ? [BREAK] : []), ...(line ? [literal(line)] : [])]);
}
