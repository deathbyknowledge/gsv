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

/**
 * Splits Markdown at blank lines into messages. Fenced code blocks, lists,
 * tables and block quotes stay whole even when they contain blank lines, and
 * runs of short paragraphs merge into one message.
 */
export function splitMarkdownParagraphs(markdown: string): string[] {
  const messages: string[] = [];
  let current = "";
  for (const block of markdownBlocks(markdown)) {
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
  return messages;
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
  return fitPieces(markdown, render, limit, limit);
}

export function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length += 1;
  return length;
}

function fitPieces(
  markdown: string,
  render: (markdown: string) => string,
  limit: number,
  markdownLimit: number,
): RenderedMessage[] {
  const fitted: RenderedMessage[] = [];
  for (const piece of splitTextAtLimit(markdown, markdownLimit)) {
    const rendered = render(piece);
    if (!rendered) continue;
    const renderedLength = codePointLength(rendered);
    if (renderedLength <= limit) {
      fitted.push({ markdown: piece, rendered });
      continue;
    }
    if (markdownLimit <= 1) {
      // One code point rendered past the limit; cutting the rendering is the last resort.
      fitted.push(...splitTextAtLimit(rendered, limit).map((cut) => ({ markdown: piece, rendered: cut })));
      continue;
    }
    // Shrink the Markdown allowance by the observed rendering overhead, with
    // some headroom, and always by at least one code point so the loop ends.
    const proportional = Math.floor((markdownLimit * limit) / renderedLength * 0.9);
    const next = Math.max(1, Math.min(markdownLimit - 1, proportional));
    fitted.push(...fitPieces(piece, render, limit, next));
  }
  return fitted;
}

function markdownBlocks(markdown: string): string[] {
  const trimmed = markdown.trim();
  if (!trimmed) return [];
  let tokens: Token[];
  try {
    tokens = lexer(trimmed);
  } catch {
    return trimmed.split(/\n[ \t]*\n+/).map((block) => block.trim()).filter(Boolean);
  }
  const blocks: string[] = [];
  for (const token of tokens) {
    if (token.type === "space" || token.type === "def") continue;
    // Leading spaces belong to indented code; only surrounding blank lines go.
    const raw = token.raw.replace(/^\n+/, "").trimEnd();
    if (raw) blocks.push(raw);
  }
  return blocks;
}

function lastBoundary(window: string, separator: string): number | null {
  const index = window.lastIndexOf(separator);
  return index > 0 ? index : null;
}
