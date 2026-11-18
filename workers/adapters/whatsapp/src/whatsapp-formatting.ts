import { lexer, type MarkedToken, type Token, type Tokens } from "marked";
import { z } from "zod";
import {
  fitMarkdownToLimit,
  splitMarkdownParagraphs,
  splitTextAtLimit,
  type ParagraphGrouping,
} from "../../shared/src/paragraph-messages";

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
 * Each delivery records its partition by index, so a retry after an update resumes the
 * messages it began with. WhatsApp bills every message, so new deliveries send a lead
 * paragraph and then the rest.
 */
const WHATSAPP_PARTITIONS: readonly ParagraphGrouping[] = ["legacy", "each", "lead"];
export const WHATSAPP_PARTITION: ParagraphGrouping = "lead";

/** The partition a delivery recorded; a version this code does not know reads as the current one. */
export function whatsAppPartition(formatVersion: number | undefined): ParagraphGrouping {
  return WHATSAPP_PARTITIONS[formatVersion ?? 0] ?? WHATSAPP_PARTITION;
}

export function whatsAppPartitionVersion(partition: ParagraphGrouping): number {
  return WHATSAPP_PARTITIONS.indexOf(partition);
}

/**
 * Ship's Markdown as the ordered WhatsApp messages it becomes: paragraph
 * groups rendered with WhatsApp's markers, each within the text limit.
 * Without a grouping the text stays one message unless the limit splits it.
 */
export function whatsAppTextMessages(markdown: string, grouping: ParagraphGrouping | null = WHATSAPP_PARTITION): string[] {
  const paragraphs = grouping ? splitMarkdownParagraphs(markdown, grouping) : [markdown];
  const messages = paragraphs.flatMap((paragraphs) =>
    fitMarkdownToLimit(paragraphs, renderWhatsAppText, WHATSAPP_TEXT_LIMIT)
      .map((fitted) => fitted.rendered));
  return messages.length > 0
    ? messages
    : splitTextAtLimit(renderWhatsAppText(markdown) || markdown, WHATSAPP_TEXT_LIMIT);
}

/**
 * An approval prompt is plain text. Its paragraph groups become messages
 * within `limit` code points; the caller attaches the buttons to the last one.
 */
export function whatsAppPromptMessages(prompt: string, limit: number, legacyGrouping = false): string[] {
  const paragraphs = legacyGrouping ? splitMarkdownParagraphs(prompt, "legacy") : [prompt];
  return paragraphs.flatMap((paragraph) => fitMarkdownToLimit(paragraph, (plain) => plain, limit).map((fitted) => fitted.rendered));
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
