import type { ManagedOutboundMailQuote } from "@humansandmachines/gsv/protocol";
import { lexer, type MarkedToken, type Token, type Tokens } from "marked";

/** The operator's line under every message, e.g. "Sent from my Ship" linking to its site. */
export type MailFooter = {
  text: string;
  url?: string;
};

export type RenderedMail = {
  text: string;
  html: string;
};

type RenderOptions = {
  footer?: MailFooter;
  quote?: ManagedOutboundMailQuote;
};

const KNOWN_TOKEN_TYPES: ReadonlySet<string> = new Set([
  "blockquote", "br", "code", "codespan", "def", "del", "em", "escape",
  "heading", "hr", "html", "image", "link", "list", "list_item", "paragraph",
  "space", "strong", "table", "text",
]);

// Outlook shows HTML without a font in Times New Roman; Gmail drops body styles.
const BODY_FONT = "font-family:Arial,Helvetica,sans-serif";
const MUTED = "#6b6b6b";
const RULE = "#d9d9d9";
const MONOSPACE = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

const CHARACTER_REFERENCE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]*));/g;
const NAMED_REFERENCES = new Map([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", "\""], ["apos", "'"], ["nbsp", "\u00A0"],
  ["copy", "©"], ["reg", "®"], ["trade", "™"], ["hellip", "…"], ["mdash", "—"], ["ndash", "–"],
  ["lsquo", "‘"], ["rsquo", "’"], ["ldquo", "“"], ["rdquo", "”"], ["laquo", "«"], ["raquo", "»"],
  ["euro", "€"], ["pound", "£"], ["yen", "¥"], ["cent", "¢"], ["deg", "°"], ["times", "×"],
  ["divide", "÷"], ["middot", "·"], ["bull", "•"], ["rarr", "→"], ["larr", "←"],
]);

/**
 * Turns what a Ship wrote, Markdown as in chat, into the two parts a mail
 * client shows: plain HTML that reads like a person's email, and a text
 * alternative without Markdown marks. Raw HTML in the source stays visible
 * text, only web and mail links survive, and images become links, so a
 * message can't carry markup or load remote content.
 */
export function renderMail(markdown: string, options: RenderOptions = {}): RenderedMail {
  const tokens = lexer(markdown.replace(/\r\n?/g, "\n").trim(), { gfm: true, breaks: true });
  const textParts = [blocksText(tokens)];
  const htmlParts = [`<div dir="auto">${blocksHtml(tokens)}</div>`];
  if (options.footer) {
    textParts.push(footerText(options.footer));
    htmlParts.push(footerHtml(options.footer));
  }
  if (options.quote) {
    textParts.push(quoteText(options.quote));
    htmlParts.push(quoteHtml(options.quote));
  }
  return {
    text: `${textParts.filter(Boolean).join("\n\n")}\n`,
    html: [
      "<!DOCTYPE html>",
      "<html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head>",
      `<body><div style="${BODY_FONT}">${htmlParts.join("\n")}</div></body></html>`,
      "",
    ].join("\n"),
  };
}

function footerText(footer: MailFooter): string {
  return footer.url ? `${footer.text} (${footer.url})` : footer.text;
}

function footerHtml(footer: MailFooter): string {
  const label = escapeHtml(footer.text);
  const content = footer.url
    ? `<a href="${escapeHtml(footer.url)}" style="color:${MUTED};text-decoration:none">${label}</a>`
    : label;
  return `<p style="margin:1.5em 0 0;font-size:12px;color:${MUTED}">${content}</p>`;
}

function quoteAttribution(quote: ManagedOutboundMailQuote): string {
  const parts = new Map(new Intl.DateTimeFormat("en-GB", {
    timeZone: quote.timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(quote.sentAt).map((part) => [part.type, part.value]));
  const date = `${parts.get("weekday")}, ${parts.get("day")} ${parts.get("month")} ${parts.get("year")}`;
  return `On ${date} at ${parts.get("hour")}:${parts.get("minute")}, ${quote.from} wrote:`;
}

function quoteText(quote: ManagedOutboundMailQuote): string {
  const quoted = quote.text.split("\n").map((line) => line ? `> ${line}` : ">").join("\n");
  return `${quoteAttribution(quote)}\n\n${quoted}`;
}

// Gmail folds a gmail_quote away behind "…"; Apple Mail marks a cite blockquote.
function quoteHtml(quote: ManagedOutboundMailQuote): string {
  return [
    "<div class=\"gmail_quote\" style=\"margin-top:1.5em\">",
    `<div class="gmail_attr">${escapeHtml(quoteAttribution(quote))}<br></div>`,
    `<blockquote class="gmail_quote" type="cite" style="margin:0 0 0 0.8ex;border-left:1px solid ${RULE};padding-left:1ex">`,
    escapeHtml(quote.text).replaceAll("\n", "<br>\n"),
    "</blockquote></div>",
  ].join("");
}

function blocksText(tokens: Token[]): string {
  return tokens
    .filter(isMarkedToken)
    .map(blockText)
    .filter((value) => value.length > 0)
    .join("\n\n");
}

function blockText(token: MarkedToken): string {
  switch (token.type) {
    case "space":
    case "def":
      return "";
    case "heading":
    case "paragraph":
      return inlineText(token.tokens);
    case "text":
      return token.tokens ? inlineText(token.tokens) : decodeReferences(token.text);
    case "blockquote":
      return blocksText(token.tokens).split("\n").map((line) => line ? `> ${line}` : ">").join("\n");
    case "list":
      return listText(token);
    case "code":
      return token.text;
    case "table":
      return [token.header, ...token.rows]
        .map((row) => row.map((cell) => inlineText(cell.tokens)).join(" | "))
        .join("\n");
    case "hr":
      return "---";
    case "html":
      return token.text.trim();
    default:
      return "";
  }
}

function listText(token: Tokens.List): string {
  const start = token.start === "" ? 1 : token.start;
  return token.items.map((item, index) => {
    const marker = item.task
      ? item.checked ? "[x] " : "[ ] "
      : token.ordered ? `${start + index}. ` : "- ";
    const content = item.tokens
      .filter(isMarkedToken)
      .map(blockText)
      .filter(Boolean)
      .join("\n");
    const [first = "", ...rest] = content.split("\n");
    return [`${marker}${first}`, ...rest.map((line) => line ? `  ${line}` : line)].join("\n");
  }).join("\n");
}

function inlineText(tokens: Token[] | undefined): string {
  return (tokens ?? []).filter(isMarkedToken).map((token) => {
    switch (token.type) {
      case "text":
        return token.tokens ? inlineText(token.tokens) : decodeReferences(token.text);
      case "strong":
      case "em":
      case "del":
        return inlineText(token.tokens);
      case "codespan":
      case "escape":
        return token.text;
      case "br":
        return "\n";
      case "link": {
        const label = inlineText(token.tokens);
        const href = safeHref(token.href);
        if (!href) return label;
        const target = href.startsWith("mailto:") ? href.slice("mailto:".length) : href;
        return !label || label === target ? target : `${label} (${target})`;
      }
      case "image": {
        const href = safeHref(token.href);
        const label = decodeReferences(token.text) || "image";
        return href ? `${label} (${href})` : label;
      }
      case "html":
        return token.text;
      default:
        return "";
    }
  }).join("");
}

function blocksHtml(tokens: Token[]): string {
  return tokens
    .filter(isMarkedToken)
    .map(blockHtml)
    .filter((value) => value.length > 0)
    .join("\n");
}

function blockHtml(token: MarkedToken): string {
  switch (token.type) {
    case "space":
    case "def":
      return "";
    case "heading":
      return `<p><strong>${inlineHtml(token.tokens)}</strong></p>`;
    case "paragraph":
      return `<p>${inlineHtml(token.tokens)}</p>`;
    case "text":
      return token.tokens ? inlineHtml(token.tokens) : escapeHtml(decodeReferences(token.text));
    case "blockquote":
      return `<blockquote style="margin:0 0 1em;padding-left:1em;border-left:3px solid ${RULE};color:${MUTED}">${blocksHtml(token.tokens)}</blockquote>`;
    case "list":
      return listHtml(token);
    case "code":
      return `<pre style="font-family:${MONOSPACE};white-space:pre-wrap;background:#f5f5f5;padding:8px 12px;border-radius:4px">${escapeHtml(token.text)}</pre>`;
    case "table":
      return tableHtml(token);
    case "hr":
      return `<hr style="border:none;border-top:1px solid ${RULE}">`;
    case "html":
      return `<p>${escapeHtml(token.text.trim()).replaceAll("\n", "<br>")}</p>`;
    default:
      return "";
  }
}

function listHtml(token: Tokens.List): string {
  const items = token.items.map((item) => {
    const content = item.tokens
      .filter(isMarkedToken)
      .map(blockHtml)
      .filter(Boolean)
      .join("\n");
    // The box replaces the bullet. Neither mark is an emoji, which clients would draw in color.
    return item.task
      ? `<li style="list-style:none">${item.checked ? "✓" : "☐"} ${content}</li>`
      : `<li>${content}</li>`;
  }).join("");
  if (!token.ordered) return `<ul>${items}</ul>`;
  const start = token.start === "" || token.start === 1 ? "" : ` start="${token.start}"`;
  return `<ol${start}>${items}</ol>`;
}

function tableHtml(token: Tokens.Table): string {
  const cell = (tag: "th" | "td", content: Token[]) =>
    `<${tag} style="border:1px solid ${RULE};padding:4px 8px;text-align:left">${inlineHtml(content)}</${tag}>`;
  const header = `<tr>${token.header.map((entry) => cell("th", entry.tokens)).join("")}</tr>`;
  const rows = token.rows.map((row) => `<tr>${row.map((entry) => cell("td", entry.tokens)).join("")}</tr>`).join("");
  return `<table style="border-collapse:collapse;margin:0 0 1em">${header}${rows}</table>`;
}

function inlineHtml(tokens: Token[] | undefined): string {
  return (tokens ?? []).filter(isMarkedToken).map((token) => {
    switch (token.type) {
      case "text":
        return token.tokens ? inlineHtml(token.tokens) : escapeHtml(decodeReferences(token.text));
      case "strong":
        return `<strong>${inlineHtml(token.tokens)}</strong>`;
      case "em":
        return `<em>${inlineHtml(token.tokens)}</em>`;
      case "del":
        return `<s>${inlineHtml(token.tokens)}</s>`;
      case "codespan":
        return `<code style="font-family:${MONOSPACE};background:#f5f5f5;padding:0 3px;border-radius:3px">${escapeHtml(token.text)}</code>`;
      case "escape":
        return escapeHtml(token.text);
      case "br":
        return "<br>";
      case "link": {
        const label = inlineHtml(token.tokens) || escapeHtml(decodeReferences(token.href));
        const href = safeHref(token.href);
        return href ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
      }
      case "image": {
        const label = escapeHtml(decodeReferences(token.text) || "image");
        const href = safeHref(token.href);
        return href ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
      }
      case "html":
        return escapeHtml(token.text);
      default:
        return "";
    }
  }).join("");
}

// Checks the decoded destination, which is the one a mail client opens.
function safeHref(href: string): string | null {
  const target = decodeReferences(href);
  try {
    const url = new URL(target);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? target : null;
  } catch {
    // Relative and malformed links stay as their label.
    return null;
  }
}

/**
 * Decodes Markdown character references, which marked leaves as written and
 * CommonMark keeps literal only in code. A Ship mostly writes `&amp;` in a
 * link copied out of HTML; a name outside this table stays as written.
 */
function decodeReferences(value: string): string {
  return value.replace(CHARACTER_REFERENCE, (reference, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED_REFERENCES.get(name) ?? reference;
    const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? "0", 16);
    // CommonMark replaces U+0000 and anything that is not a Unicode scalar value with U+FFFD.
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "\uFFFD" : String.fromCodePoint(code);
  });
}

function isMarkedToken(token: Token): token is MarkedToken {
  return KNOWN_TOKEN_TYPES.has(token.type);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
