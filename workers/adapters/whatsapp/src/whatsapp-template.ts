import { lexer, type MarkedToken, type Token, type Tokens } from "marked";
import { z } from "zod";
import { codePointLength, splitTextAtLimit } from "../../shared/src/paragraph-messages";
import type { ManagedWhatsAppTemplate } from "./managed-config";
import { WHATSAPP_WINDOW_CLOSED_ERROR, type WhatsAppOutboundPayload } from "./whatsapp-api";

/**
 * The one Utility template the operator files with Meta. Outside the 24-hour
 * customer service window Meta accepts nothing else, so the adapter sends the
 * person's reply flattened into the template's single parameter and, when it
 * does not fit or carries approval buttons, holds the real message until the
 * quick-reply tap or any other message from the person reopens the window.
 */

/** Body text filed with Meta; `{{1}}` receives the flattened message. */
export const WHATSAPP_TEMPLATE_BODY = "Your GSV: {{1}}";
/** Quick-reply button label filed with Meta; a tap reopens the window. */
export const WHATSAPP_TEMPLATE_BUTTON_LABEL = "Show me";
/** Parameter example filed with Meta for its review. */
export const WHATSAPP_TEMPLATE_PARAMETER_EXAMPLE = "Your report is ready. Tap the button to read it here.";
/**
 * Meta caps a rendered template body at 1024 characters. The parameter keeps
 * headroom for the frame around it (`WHATSAPP_TEMPLATE_BODY` is ten characters
 * without the placeholder) so a slightly longer frame still sends.
 */
export const WHATSAPP_TEMPLATE_PARAMETER_LIMIT = 1000;
/** Payload of the quick-reply button; a tap carrying it releases the held messages. */
export const WHATSAPP_TEMPLATE_RELEASE_PAYLOAD = "gsvt:show";
/** Parameter text when a message flattens to nothing, such as a lone rule. */
const EMPTY_PARAMETER = "You have a new message.";
const BLOCK_SEPARATOR = " · ";
const ELLIPSIS = "…";

export const WHATSAPP_NO_TEMPLATE_ERROR =
  `${WHATSAPP_WINDOW_CLOSED_ERROR}, and no template is configured; see the message templates section of workers/adapters/whatsapp/README.md`;
export const WHATSAPP_WINDOW_CLOSED_MEDIA_ERROR =
  `${WHATSAPP_WINDOW_CLOSED_ERROR}, and attachments cannot wait behind a template; send text only until the person replies`;
export const WHATSAPP_HELD_FULL_ERROR =
  `${WHATSAPP_WINDOW_CLOSED_ERROR}, and too many messages are already waiting for this person's reply`;
export const WHATSAPP_HELD_TOO_LONG_ERROR =
  `${WHATSAPP_WINDOW_CLOSED_ERROR}, and this message is too long to wait for the person's reply`;

export type WhatsAppTemplateParameter = {
  text: string;
  /** True when the whole message is inside `text`, so nothing needs to be held. */
  complete: boolean;
};

/**
 * Flattens Markdown into one template parameter. Blocks join with a middle
 * dot, inline markers and code fences go, whitespace collapses to single
 * spaces because Meta refuses newlines, tabs and more than four spaces in a
 * row, and the result is cut to `limit` code points with an ellipsis.
 */
export function flattenWhatsAppTemplateParameter(
  markdown: string,
  limit = WHATSAPP_TEMPLATE_PARAMETER_LIMIT,
): WhatsAppTemplateParameter {
  const text = plainBlocks(markdown).join(BLOCK_SEPARATOR);
  if (!text) return { text: EMPTY_PARAMETER, complete: false };
  if (codePointLength(text) <= limit) return { text, complete: true };
  const head = splitTextAtLimit(text, limit - codePointLength(ELLIPSIS))[0] ?? "";
  return { text: `${head.replace(/[\s·,;:]+$/u, "")}${ELLIPSIS}`, complete: false };
}

export function buildWhatsAppTemplatePayload(
  to: string,
  template: ManagedWhatsAppTemplate,
  parameter: string,
): WhatsAppOutboundPayload {
  return {
    to,
    type: "template",
    template: {
      name: template.name,
      language: { code: template.language },
      components: [
        { type: "body", parameters: [{ type: "text", text: parameter }] },
        {
          type: "button",
          sub_type: "quick_reply",
          index: "0",
          parameters: [{ type: "payload", payload: WHATSAPP_TEMPLATE_RELEASE_PAYLOAD }],
        },
      ],
    },
  };
}

function plainBlocks(markdown: string): string[] {
  const trimmed = markdown.trim();
  if (!trimmed) return [];
  let tokens: Token[];
  try {
    tokens = lexer(trimmed);
  } catch {
    return [collapse(trimmed)].filter(Boolean);
  }
  return tokens.filter(isMarkedToken).map(plainBlock).map(collapse).filter(Boolean);
}

function plainBlock(token: MarkedToken): string {
  switch (token.type) {
    case "space":
    case "def":
    case "hr":
      return "";
    case "heading":
    case "paragraph":
      return plainInline(token.tokens);
    case "blockquote":
      return token.tokens.filter(isMarkedToken).map(plainBlock).filter(Boolean).join(BLOCK_SEPARATOR);
    case "list":
      return plainList(token);
    case "code":
      return token.text;
    case "table":
      return plainTable(token);
    case "html":
      return token.text || token.raw;
    case "text":
      return token.tokens ? plainInline(token.tokens) : token.text;
    default:
      return "";
  }
}

function plainList(token: Tokens.List): string {
  return token.items
    .map((item) => item.tokens.filter(isMarkedToken).map(plainBlock).filter(Boolean).join(" "))
    .filter(Boolean)
    .join("; ");
}

function plainTable(token: Tokens.Table): string {
  const header = token.header.map((cell) => plainInline(cell.tokens)).join(" | ");
  const rows = token.rows.map((row) => row.map((cell) => plainInline(cell.tokens)).join(" | "));
  return [header, ...rows].filter(Boolean).join("; ");
}

function plainInline(tokens: Token[] | undefined): string {
  if (!tokens || tokens.length === 0) return "";
  return tokens.filter(isMarkedToken).map(plainInlineToken).join("");
}

function plainInlineToken(token: MarkedToken): string {
  switch (token.type) {
    case "text":
      return token.tokens ? plainInline(token.tokens) : token.text;
    case "strong":
    case "em":
    case "del":
      return plainInline(token.tokens);
    case "codespan":
    case "escape":
      return token.text;
    case "link": {
      const label = plainInline(token.tokens).trim();
      return label && label !== token.href ? `${label} (${token.href})` : token.href;
    }
    case "image":
      return plainInline(token.tokens) || token.text;
    case "br":
      return " ";
    case "html":
      return token.text || token.raw;
    default:
      return "";
  }
}

/** Newlines, tabs, control characters and runs of spaces become one space. */
function collapse(value: string): string {
  return value.replace(/[\s\p{Cc}]+/gu, " ").trim();
}

const markedTokenTypeSchema = z.enum([
  "blockquote", "br", "code", "codespan", "def", "del", "em", "escape",
  "heading", "hr", "html", "image", "link", "list", "list_item", "paragraph",
  "space", "strong", "table", "text",
]);

function isMarkedToken(token: Token): token is MarkedToken {
  return markedTokenTypeSchema.safeParse(token.type).success;
}
