import { lexer, type MarkedToken, type Token, type Tokens } from "marked";
import { z } from "zod";
import type { callManagedTelegramApi } from "./managed-telegram-api";

type TelegramApiPayload = Parameters<typeof callManagedTelegramApi>[2];

type TelegramApiCall<T> = (
  method: string,
  payload: TelegramApiPayload,
) => Promise<T>;

const telegramFormattingErrorSchema = z.object({
  telegramStatus: z.literal(400),
  telegramDescription: z.string(),
}).passthrough();

export type TelegramReplyParameters = {
  message_id: number;
};

type CaptionPayloadBuilder = (
  caption?: string,
  parseMode?: "HTML",
) => TelegramApiPayload;

const FORMATTING_ERROR_PATTERN =
  /can't parse|parse entities|parse[^:]*markdown|markdown[^:]*parse|unsupported[^:]*tag|invalid[^:]*entity|entity[^:]*invalid/i;

export function buildTelegramReplyParameters(
  replyToMessageId?: number,
): TelegramReplyParameters | undefined {
  if (replyToMessageId === undefined || !Number.isFinite(replyToMessageId)) {
    return undefined;
  }

  return { message_id: replyToMessageId };
}

export async function sendTelegramMarkdownMessage<T>(
  callApi: TelegramApiCall<T>,
  chatId: string,
  markdown: string,
  replyToMessageId?: number,
): Promise<T> {
  const replyParameters = buildTelegramReplyParameters(replyToMessageId);
  const replyPayload = replyParameters
    ? { reply_parameters: replyParameters }
    : {};

  try {
    return await callApi("sendRichMessage", {
      chat_id: chatId,
      rich_message: { markdown },
      ...replyPayload,
    });
  } catch (error) {
    if (!(error instanceof Error) || !isTelegramFormattingError(error)) {
      throw error;
    }
  }

  try {
    return await callApi("sendMessage", {
      chat_id: chatId,
      text: markdownToTelegramHtml(markdown),
      parse_mode: "HTML",
      ...replyPayload,
    });
  } catch (error) {
    if (!(error instanceof Error) || !isTelegramFormattingError(error)) {
      throw error;
    }
  }

  return callApi("sendMessage", {
    chat_id: chatId,
    text: markdown,
    ...replyPayload,
  });
}

export async function callTelegramApiWithMarkdownCaption<T>(
  callApi: TelegramApiCall<T>,
  method: string,
  caption: string | undefined,
  buildPayload: CaptionPayloadBuilder,
): Promise<T> {
  if (!caption) {
    return callApi(method, buildPayload());
  }

  try {
    return await callApi(
      method,
      buildPayload(markdownToTelegramHtml(caption), "HTML"),
    );
  } catch (error) {
    if (!(error instanceof Error) || !isTelegramFormattingError(error)) {
      throw error;
    }
  }

  return callApi(method, buildPayload(caption));
}

export function markdownToTelegramHtml(markdown: string): string {
  const trimmed = markdown.trim();
  if (!trimmed) {
    return "";
  }

  try {
    return renderBlockTokens(lexer(trimmed)).trim();
  } catch {
    return escapeTelegramHtml(trimmed);
  }
}

export function isTelegramFormattingError(error: Error): boolean {
  const parsed = telegramFormattingErrorSchema.safeParse(error);
  return parsed.success && FORMATTING_ERROR_PATTERN.test(parsed.data.telegramDescription);
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
      return `<b>${renderInlineTokens(token.tokens)}</b>`;
    case "paragraph":
      return renderInlineTokens(token.tokens);
    case "blockquote": {
      const content = renderBlockTokens(token.tokens, blockquoteDepth + 1);
      if (!content) {
        return "";
      }
      return blockquoteDepth === 0
        ? `<blockquote>${content}</blockquote>`
        : prefixLines(content, "&gt; ");
    }
    case "list":
      return renderList(token, blockquoteDepth);
    case "code":
      return renderCodeBlock(token);
    case "table":
      return renderTable(token);
    case "hr":
      return "────────";
    case "html":
      return escapeTelegramHtml(token.text || token.raw);
    case "text":
      return token.tokens
        ? renderInlineTokens(token.tokens)
        : escapeTelegramHtml(token.text);
    default:
      return renderUnknownToken(token);
  }
}

function renderList(token: Tokens.List, blockquoteDepth: number): string {
  const start = token.start === "" ? 1 : token.start;

  return token.items
    .map((item, index) => {
      const prefix = item.task
        ? item.checked ? "☑ " : "☐ "
        : token.ordered ? `${start + index}. ` : "• ";
      const content = item.tokens
        .filter(isMarkedToken)
        .map((child) => renderBlockToken(child, blockquoteDepth))
        .filter(Boolean)
        .join("\n")
        .trim();

      if (!content) {
        return "";
      }

      const [firstLine, ...remainingLines] = content.split("\n");
      return [
        `${prefix}${firstLine}`,
        ...remainingLines.map((line) => `  ${line}`),
      ].join("\n");
    })
    .filter(Boolean)
    .join("\n");
}

function renderCodeBlock(token: Tokens.Code): string {
  const code = escapeTelegramHtml(token.text);
  const language = token.lang?.trim().split(/\s+/, 1)[0];

  if (language && /^[A-Za-z0-9_+.#-]{1,32}$/.test(language)) {
    return `<pre><code class="language-${escapeTelegramHtml(language)}">${code}</code></pre>`;
  }

  return `<pre>${code}</pre>`;
}

function renderTable(token: Tokens.Table): string {
  const header = token.header.map((cell) => renderInlineTokens(cell.tokens));
  const rows = token.rows.map((row) =>
    row.map((cell) => renderInlineTokens(cell.tokens)).join(" | ")
  );

  return [
    header.length > 0 ? `<b>${header.join(" | ")}</b>` : "",
    ...rows,
  ].filter(Boolean).join("\n");
}

function renderInlineTokens(tokens: Token[] | undefined): string {
  if (!tokens || tokens.length === 0) {
    return "";
  }

  return tokens.filter(isMarkedToken).map(renderInlineToken).join("");
}

function renderInlineToken(token: Token): string {
  switch (token.type) {
    case "text":
      return token.tokens
        ? renderInlineTokens(token.tokens)
        : escapeTelegramHtml(token.text);
    case "strong":
      return `<b>${renderInlineTokens(token.tokens)}</b>`;
    case "em":
      return `<i>${renderInlineTokens(token.tokens)}</i>`;
    case "del":
      return `<s>${renderInlineTokens(token.tokens)}</s>`;
    case "codespan":
      return `<code>${escapeTelegramHtml(token.text)}</code>`;
    case "link":
      if (!isLinkToken(token)) return "";
      return renderLink(token);
    case "image":
      if (!isImageToken(token)) return "";
      return renderImage(token);
    case "br":
      return "\n";
    case "escape":
      return escapeTelegramHtml(token.text);
    case "html":
      return escapeTelegramHtml(token.text || token.raw);
    default:
      if (!isMarkedToken(token)) return "";
      return renderUnknownToken(token);
  }
}

function renderLink(token: Tokens.Link): string {
  const label = renderInlineTokens(token.tokens) || escapeTelegramHtml(token.href);
  const href = normalizeTelegramLink(token.href);
  if (!href) {
    return label;
  }

  return `<a href="${escapeTelegramHtml(href)}">${label}</a>`;
}

function renderImage(token: Tokens.Image): string {
  const label = renderInlineTokens(token.tokens) ||
    escapeTelegramHtml(token.text) ||
    "Image";
  const href = normalizeTelegramLink(token.href);
  if (!href) {
    return label;
  }

  return `<a href="${escapeTelegramHtml(href)}">${label}</a>`;
}

function renderUnknownToken(_token: MarkedToken): string {
  return "";
}

const markedTokenTypeSchema = z.enum([
  "blockquote", "br", "code", "codespan", "def", "del", "em", "escape",
  "heading", "hr", "html", "image", "link", "list", "list_item", "paragraph",
  "space", "strong", "table", "text",
]);

function isMarkedToken(token: Token): token is MarkedToken {
  return markedTokenTypeSchema.safeParse(token.type).success;
}

function isLinkToken(token: Token): token is Tokens.Link {
  return token.type === "link" && isMarkedToken(token);
}

function isImageToken(token: Token): token is Tokens.Image {
  return token.type === "image" && isMarkedToken(token);
}

function normalizeTelegramLink(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return href;
    }
    if (url.protocol === "tg:" && /^tg:\/\/user\?id=\d+$/i.test(href)) {
      return href;
    }
  } catch {
    // Relative and malformed links are rendered as text.
  }

  return null;
}

function prefixLines(value: string, prefix: string): string {
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
