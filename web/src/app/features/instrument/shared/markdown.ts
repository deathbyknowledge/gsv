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
    if (href && /^https?:\/\//i.test(href)) {
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
