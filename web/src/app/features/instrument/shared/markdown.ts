import DOMPurify from "dompurify";
import { parse as parseMarkdown } from "marked";

/** The same sanitizing path the chat transcript uses: marked, then DOMPurify, never raw provider text. */
const purifier = DOMPurify();

if (purifier.addHook) {
  purifier.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName !== "A") {
      return;
    }
    const href = node.getAttribute("href");
    if (href && /^(?:https?:)?\/\//i.test(href)) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function trimUrlPunctuation(value: string): string {
  let url = value;
  while (url) {
    const last = url.at(-1)!;
    if (/[.,!?;:]/.test(last)) {
      url = url.slice(0, -1);
      continue;
    }
    const opening = last === ")" ? "(" : last === "]" ? "[" : last === "}" ? "{" : null;
    if (!opening || url.split(last).length <= url.split(opening).length) break;
    url = url.slice(0, -1);
  }
  return url;
}

/**
 * A person's text as HTML. It is escaped, with web URLs linked but never parsed as markup; the human moment's
 * `white-space: pre-wrap` shows its line breaks, and runs of blank lines fold to one.
 */
export function renderPlainTextHtml(value: string): string {
  const text = value.replace(/\n(?:[ \t]*\n){2,}/g, "\n\n");
  const urls = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
  let html = "";
  let end = 0;
  for (const match of text.matchAll(urls)) {
    const start = match.index;
    const url = trimUrlPunctuation(match[0]);
    if (!url) continue;
    const href = /^www\./i.test(url) ? `https://${url}` : url;
    try {
      if (!new URL(href).hostname) continue;
    } catch {
      continue;
    }
    html += escapeHtml(text.slice(end, start));
    html += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
    end = start + url.length;
  }
  return html + escapeHtml(text.slice(end));
}

function sanitize(value: string): string {
  if (purifier.sanitize) {
    return String(purifier.sanitize(value));
  }
  // Non-DOM renderers cannot initialize DOMPurify; stay inert rather than trust the text.
  return escapeHtml(value);
}

/** Markdown to sanitized HTML. Falls back to escaped text if parsing fails. */
export function renderMarkdownHtml(value: string): string {
  try {
    const html = parseMarkdown(value, { async: false, breaks: true, gfm: true });
    return sanitize(String(html));
  } catch {
    return sanitize(value);
  }
}
