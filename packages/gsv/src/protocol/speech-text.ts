import { lexer, type Token, type Tokens } from "marked";

export type SpeechTextFormat = "plain" | "markdown";

const MAX_SPOKEN_TABLE_ROWS = 6;
const MAX_SPOKEN_TABLE_COLUMNS = 4;
const EMOJI_SEQUENCE_PATTERN = /(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:[\u{1F3FB}-\u{1F3FF}]|[\uFE0E\uFE0F])?(?:\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:[\u{1F3FB}-\u{1F3FF}]|[\uFE0E\uFE0F])?)*/gu;
const EMOJI_MODIFIER_PATTERN = /[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\uFE0E\uFE0F\u200D]/gu;

export function normalizeSpeechText(
  input: string,
  format: SpeechTextFormat = "markdown",
): string {
  const text = input.trim();
  if (!text) {
    return "";
  }
  if (format === "plain") {
    return normalizeSpeechWhitespace(text);
  }

  try {
    return normalizeSpeechWhitespace(renderBlockTokens(lexer(text) as Token[]));
  } catch {
    return normalizeSpeechWhitespace(markdownFallbackToSpeechText(text));
  }
}

export function normalizeSpeechTextFormat(value: unknown): SpeechTextFormat {
  return value === "plain" ? "plain" : "markdown";
}

function renderBlockTokens(tokens: Token[]): string {
  const blocks: string[] = [];
  for (const token of tokens) {
    const rendered = renderBlockToken(token);
    if (rendered) {
      blocks.push(rendered);
    }
  }
  return blocks.join("\n\n");
}

function renderBlockToken(token: Token): string {
  switch (token.type) {
    case "space":
    case "def":
    case "hr":
      return "";
    case "heading":
    case "paragraph":
      return renderInlineTokens(token.tokens);
    case "blockquote": {
      const quote = renderBlockTokens((token as Tokens.Blockquote).tokens);
      return quote ? `Quote: ${quote}` : "";
    }
    case "list":
      return renderList(token as Tokens.List);
    case "code":
      return token.text.trim() ? "Code block omitted." : "";
    case "table":
      return renderTable(token as Tokens.Table);
    case "html":
      return stripHtml(token.text || token.raw);
    case "text":
      return token.tokens ? renderInlineTokens(token.tokens) : token.text;
    default:
      return renderInlineToken(token);
  }
}

function renderList(token: Tokens.List): string {
  const start = typeof token.start === "number" ? token.start : 1;
  const items = token.items
    .map((item, index) => {
      const text = renderBlockTokens(item.tokens) || item.text;
      const prefix = item.task
        ? item.checked ? "Done: " : "Todo: "
        : token.ordered ? `${start + index}. ` : "";
      return `${prefix}${text}`;
    })
    .filter((item) => item.trim().length > 0);
  return items.join("\n");
}

function renderTable(token: Tokens.Table): string {
  const headers = token.header
    .map((cell) => renderInlineTokens(cell.tokens) || cell.text)
    .map((cell) => cell.trim())
    .filter(Boolean);
  const rowCount = token.rows.length;
  const columnCount = headers.length || token.rows[0]?.length || 0;
  if (rowCount === 0 || columnCount === 0) {
    return "";
  }
  if (rowCount > MAX_SPOKEN_TABLE_ROWS || columnCount > MAX_SPOKEN_TABLE_COLUMNS) {
    return `Table with ${rowCount} rows and ${columnCount} columns omitted.`;
  }

  const rows = token.rows.map((row, rowIndex) => {
    const cells = row
      .slice(0, MAX_SPOKEN_TABLE_COLUMNS)
      .map((cell, cellIndex) => {
        const value = renderInlineTokens(cell.tokens) || cell.text;
        const header = headers[cellIndex];
        return header ? `${header}: ${value}` : value;
      })
      .map((cell) => cell.trim())
      .filter(Boolean);
    return cells.length > 0 ? `Row ${rowIndex + 1}: ${cells.join("; ")}.` : "";
  }).filter(Boolean);

  return rows.length > 0 ? `Table. ${rows.join(" ")}` : "";
}

function renderInlineTokens(tokens: Token[] | undefined): string {
  if (!tokens || tokens.length === 0) {
    return "";
  }
  return tokens.map(renderInlineToken).join("");
}

function renderInlineToken(token: Token): string {
  switch (token.type) {
    case "text":
      return token.tokens ? renderInlineTokens(token.tokens) : token.text;
    case "strong":
    case "em":
    case "del":
      return renderInlineTokens(token.tokens) || token.text;
    case "codespan":
    case "escape":
      return token.text;
    case "link":
      return renderInlineTokens(token.tokens) || token.text || token.href;
    case "image":
      return token.text ? `Image: ${token.text}.` : "";
    case "br":
      return " ";
    case "html":
      return stripHtml(token.text || token.raw);
    default:
      if ("tokens" in token && Array.isArray(token.tokens)) {
        return renderInlineTokens(token.tokens);
      }
      if ("text" in token && typeof token.text === "string") {
        return token.text;
      }
      return "";
  }
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, " "));
}

function markdownFallbackToSpeechText(value: string): string {
  return stripHtml(value)
    .replace(/```[\s\S]*?```/g, "Code block omitted.")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~#>|]/g, " ");
}

function normalizeSpeechWhitespace(value: string): string {
  return stripEmojiForSpeech(decodeHtmlEntities(value))
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/([.!?]){4,}/g, "$1$1$1")
    .trim();
}

function stripEmojiForSpeech(value: string): string {
  return value
    .replace(/[#*0-9]\uFE0F?\u20E3/gu, " ")
    .replace(EMOJI_SEQUENCE_PATTERN, " ")
    .replace(EMOJI_MODIFIER_PATTERN, "");
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return "\"";
    if (lower === "apos" || lower === "#39") return "'";
    if (lower.startsWith("#x")) {
      return codePointToString(Number.parseInt(lower.slice(2), 16), match);
    }
    if (lower.startsWith("#")) {
      return codePointToString(Number.parseInt(lower.slice(1), 10), match);
    }
    return match;
  });
}

function codePointToString(value: number, fallback: string): string {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  try {
    return String.fromCodePoint(value);
  } catch {
    return fallback;
  }
}
