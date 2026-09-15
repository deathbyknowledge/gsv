import { lexer, type MarkedToken, type Token, type Tokens } from "marked";
import { z } from "zod";

/** Meta's limit for one free-form text message body. */
export const WHATSAPP_TEXT_LIMIT = 4096;
/** Meta's limit for a media caption. */
export const WHATSAPP_CAPTION_LIMIT = 1024;

/**
 * Renders agent Markdown with WhatsApp's inline markers. WhatsApp has no
 * escape character, so literal marker characters in the source stay as they are.
 */
export function renderWhatsAppText(markdown: string): string {
  const trimmed = markdown.trim();
  if (!trimmed) return "";
  try {
    return renderBlockTokens(lexer(trimmed)).trim() || trimmed;
  } catch {
    return trimmed;
  }
}

/**
 * Splits text into messages of at most `limit` code points, preferring
 * paragraph, line and word boundaries in that order.
 */
export function splitWhatsAppText(text: string, limit = WHATSAPP_TEXT_LIMIT): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("WhatsApp text limit is invalid");
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest) {
    const codePoints = [...rest];
    if (codePoints.length <= limit) {
      chunks.push(rest);
      break;
    }
    const window = codePoints.slice(0, limit).join("");
    const boundary = /\s/.test(codePoints[limit]!)
      ? window.length
      : lastBoundary(window, "\n\n") ?? lastBoundary(window, "\n") ?? lastBoundary(window, " ");
    const cut = boundary !== null && boundary >= Math.floor(window.length / 4) ? boundary : window.length;
    const chunk = rest.slice(0, cut).trimEnd();
    if (chunk) chunks.push(chunk);
    rest = rest.slice(cut).trimStart();
  }
  return chunks;
}

function lastBoundary(window: string, separator: string): number | null {
  const index = window.lastIndexOf(separator);
  return index > 0 ? index : null;
}

function renderBlockTokens(tokens: Token[], blockquoteDepth = 0): string {
  return tokens
    .filter(isMarkedToken)
    .map((token) => renderBlockToken(token, blockquoteDepth))
    .filter((value) => value.length > 0)
    .join("\n\n");
}

function renderBlockToken(token: MarkedToken, blockquoteDepth: number): string {
  switch (token.type) {
    case "space":
    case "def":
      return "";
    case "heading":
      return bold(renderInlineTokens(token.tokens));
    case "paragraph":
      return renderInlineTokens(token.tokens);
    case "blockquote": {
      const content = renderBlockTokens(token.tokens, blockquoteDepth + 1);
      return content ? prefixLines(content, "> ") : "";
    }
    case "list":
      return renderList(token, blockquoteDepth);
    case "code":
      return `\`\`\`\n${token.text}\n\`\`\``;
    case "table":
      return renderTable(token);
    case "hr":
      return "────────";
    case "html":
      return token.text || token.raw;
    case "text":
      return token.tokens ? renderInlineTokens(token.tokens) : token.text;
    default:
      return "";
  }
}

function renderList(token: Tokens.List, blockquoteDepth: number): string {
  const start = token.start === "" ? 1 : token.start;
  return token.items
    .map((item, index) => {
      const prefix = item.task
        ? item.checked ? "☑ " : "☐ "
        : token.ordered ? `${start + index}. ` : "- ";
      const content = item.tokens
        .filter(isMarkedToken)
        .map((child) => renderBlockToken(child, blockquoteDepth))
        .filter(Boolean)
        .join("\n")
        .trim();
      if (!content) return "";
      const [firstLine, ...remainingLines] = content.split("\n");
      return [`${prefix}${firstLine}`, ...remainingLines.map((line) => `  ${line}`)].join("\n");
    })
    .filter(Boolean)
    .join("\n");
}

function renderTable(token: Tokens.Table): string {
  const header = token.header.map((cell) => renderInlineTokens(cell.tokens));
  const rows = token.rows.map((row) => row.map((cell) => renderInlineTokens(cell.tokens)).join(" | "));
  return [header.length > 0 ? bold(header.join(" | ")) : "", ...rows].filter(Boolean).join("\n");
}

function renderInlineTokens(tokens: Token[] | undefined): string {
  if (!tokens || tokens.length === 0) return "";
  return tokens.filter(isMarkedToken).map(renderInlineToken).join("");
}

function renderInlineToken(token: MarkedToken): string {
  switch (token.type) {
    case "text":
      return token.tokens ? renderInlineTokens(token.tokens) : token.text;
    case "strong":
      return bold(renderInlineTokens(token.tokens));
    case "em":
      return wrap(renderInlineTokens(token.tokens), "_");
    case "del":
      return wrap(renderInlineTokens(token.tokens), "~");
    case "codespan":
      return `\`${token.text}\``;
    case "link":
      return renderLink(renderInlineTokens(token.tokens), token.href);
    case "image":
      return renderLink(renderInlineTokens(token.tokens) || token.text, token.href);
    case "br":
      return "\n";
    case "escape":
      return token.text;
    case "html":
      return token.text || token.raw;
    default:
      return "";
  }
}

function renderLink(label: string, href: string): string {
  const url = safeLink(href);
  const text = label.trim();
  if (!url) return text || href;
  if (!text || text === url) return url;
  return `${text} (${url})`;
}

function safeLink(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? href : null;
  } catch {
    return null;
  }
}

/** WhatsApp markers must touch the text they wrap, so surrounding whitespace moves outside. */
function wrap(content: string, marker: string): string {
  const leading = content.match(/^\s*/)?.[0] ?? "";
  const trailing = content.match(/\s*$/)?.[0] ?? "";
  const inner = content.trim();
  if (!inner) return content;
  return `${leading}${marker}${inner}${marker}${trailing}`;
}

function bold(content: string): string {
  return wrap(content, "*");
}

function prefixLines(value: string, prefix: string): string {
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

const markedTokenTypeSchema = z.enum([
  "blockquote", "br", "code", "codespan", "def", "del", "em", "escape",
  "heading", "hr", "html", "image", "link", "list", "list_item", "paragraph",
  "space", "strong", "table", "text",
]);

function isMarkedToken(token: Token): token is MarkedToken {
  return markedTokenTypeSchema.safeParse(token.type).success;
}
