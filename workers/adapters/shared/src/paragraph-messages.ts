import { lexer, type Token } from "marked";

/**
 * Paragraph messages: one Ship reply becomes the several platform messages a
 * person reads more comfortably than one wall of text.
 *
 * `splitMarkdownParagraphs` works on Ship's Markdown before any platform
 * rendering and knows nothing about providers. `fitMarkdownToLimit` then
 * enforces a platform's hard limit on the rendered text of each message by
 * splitting the Markdown further and rendering again, so a rendering is never
 * cut inside a tag or entity. Telegram and WhatsApp use both; Slack and Discord
 * should adopt them when their outbound text moves to paragraph messages.
 */

/**
 * A message keeps absorbing the following paragraph while it is shorter than
 * this many code points, so a greeting and a one-line question stay in one
 * bubble and a heading stays with the paragraph it introduces. Once a message
 * reaches the threshold it closes and the next paragraph starts a new one.
 */
export const SHORT_MESSAGE_THRESHOLD = 320;

/** Below this limit a single code point could render past it (`"` becomes `&quot;`). */
const MINIMUM_RENDER_LIMIT = 16;

export type RenderedMessage = {
  markdown: string;
  rendered: string;
};

/** A reference-style link definition such as `[r]: https://example.com`. */
type LinkDefinition = {
  /** The label as marked normalizes it: lowercase, inner whitespace collapsed. */
  tag: string;
  raw: string;
};

type MarkdownBlocks = {
  blocks: string[];
  definitions: LinkDefinition[];
};

/**
 * Splits Markdown at blank lines into messages. Fenced code blocks, lists,
 * tables and block quotes stay whole even when they contain blank lines, and
 * runs of short paragraphs merge into one message. A reference-style link
 * definition travels with every message that uses it, since each message is
 * rendered on its own later.
 */
export function splitMarkdownParagraphs(markdown: string): string[] {
  const { blocks, definitions } = markdownBlocks(markdown);
  const messages: string[] = [];
  let current = "";
  for (const block of blocks) {
    if (!current) {
      current = block;
      continue;
    }
    if (codePointLength(current) < SHORT_MESSAGE_THRESHOLD) {
      current = `${current}\n\n${block}`;
      continue;
    }
    messages.push(current);
    current = block;
  }
  if (current) messages.push(current);
  return messages.map((message) => withDefinitions(message, definitions));
}

/**
 * Splits text into pieces of at most `limit` code points, preferring
 * paragraph, line and word boundaries in that order before a hard cut.
 */
export function splitTextAtLimit(text: string, limit: number): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Text limit is invalid");
  const pieces: string[] = [];
  let rest = text.trim();
  while (rest) {
    const codePoints = [...rest];
    if (codePoints.length <= limit) {
      pieces.push(rest);
      break;
    }
    const window = codePoints.slice(0, limit).join("");
    // A boundary in the first quarter would leave most of the text for the
    // next piece, so each boundary kind is tried in turn before a hard cut.
    const minimum = Math.floor(window.length / 4);
    const cut = /\s/.test(codePoints[limit]!)
      ? window.length
      : ["\n\n", "\n", " "]
        .map((separator) => lastBoundary(window, separator))
        .find((index) => index !== null && index >= minimum) ?? window.length;
    const piece = rest.slice(0, cut).trimEnd();
    if (piece) pieces.push(piece);
    rest = rest.slice(cut).trimStart();
  }
  return pieces;
}

/**
 * Renders one Markdown message and guarantees that both the Markdown and its
 * rendering fit `limit` code points, so a plain-text fallback that sends the
 * Markdown itself also fits. A rendering that overshoots the limit splits the
 * Markdown further and renders each piece again.
 */
export function fitMarkdownToLimit(
  markdown: string,
  render: (markdown: string) => string,
  limit: number,
): RenderedMessage[] {
  if (!Number.isSafeInteger(limit) || limit < MINIMUM_RENDER_LIMIT) {
    throw new Error("Rendered message limit is invalid");
  }
  // Definitions are split away first so a cut never lands inside one, then
  // handed back to each piece that references them.
  const { blocks, definitions } = markdownBlocks(markdown);
  return fitPieces(blocks.join("\n\n"), definitions, render, limit, limit);
}

export function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length += 1;
  return length;
}

function fitPieces(
  markdown: string,
  definitions: LinkDefinition[],
  render: (markdown: string) => string,
  limit: number,
  markdownLimit: number,
): RenderedMessage[] {
  const fitted: RenderedMessage[] = [];
  for (const piece of splitTextAtLimit(markdown, markdownLimit)) {
    const complete = withDefinitions(piece, definitions);
    const rendered = render(complete);
    if (!rendered) continue;
    const longest = Math.max(codePointLength(rendered), codePointLength(complete));
    if (longest <= limit) {
      fitted.push({ markdown: complete, rendered });
      continue;
    }
    if (markdownLimit <= 1) {
      // One code point rendered past the limit; cutting the rendering is the last resort.
      fitted.push(...splitTextAtLimit(rendered, limit).map((cut) => ({ markdown: complete, rendered: cut })));
      continue;
    }
    // Shrink the Markdown allowance by the observed overhead of rendering or
    // of the definitions, with some headroom, and always by at least one code
    // point so the loop ends.
    const proportional = Math.floor((markdownLimit * limit) / longest * 0.9);
    const next = Math.max(1, Math.min(markdownLimit - 1, proportional));
    fitted.push(...fitPieces(piece, definitions, render, limit, next));
  }
  return fitted;
}

function markdownBlocks(markdown: string): MarkdownBlocks {
  const trimmed = markdown.trim();
  if (!trimmed) return { blocks: [], definitions: [] };
  let tokens: Token[];
  try {
    tokens = lexer(trimmed);
  } catch {
    return {
      blocks: trimmed.split(/\n[ \t]*\n+/).map((block) => block.trim()).filter(Boolean),
      definitions: [],
    };
  }
  const blocks: string[] = [];
  const definitions: LinkDefinition[] = [];
  for (const token of tokens) {
    if (token.type === "space") continue;
    if (token.type === "def") {
      definitions.push({ tag: token.tag, raw: token.raw.trim() });
      continue;
    }
    // Leading spaces belong to indented code; only surrounding blank lines go.
    const raw = token.raw.replace(/^\n+/, "").trimEnd();
    if (raw) blocks.push(raw);
  }
  return { blocks, definitions };
}

/** Appends the definitions the text refers to, so the text renders its links alone. */
function withDefinitions(text: string, definitions: LinkDefinition[]): string {
  const used = definitions.filter((definition) => referencesDefinition(text, definition.tag));
  if (used.length === 0) return text;
  return `${text}\n\n${used.map((definition) => definition.raw).join("\n")}`;
}

/** Matches `[text][tag]`, `[tag][]` and `[tag]` with the label's case and spacing relaxed. */
function referencesDefinition(text: string, tag: string): boolean {
  const label = tag
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return new RegExp(`\\[\\s*${label}\\s*\\]`, "i").test(text);
}

function lastBoundary(window: string, separator: string): number | null {
  const index = window.lastIndexOf(separator);
  return index > 0 ? index : null;
}
