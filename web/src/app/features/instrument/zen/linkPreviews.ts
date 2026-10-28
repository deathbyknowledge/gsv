import { marked } from "marked";

/**
 * The web links a Ship message shows, deduplicated in the order they appear. The text goes through the same
 * GFM lexer that renders it, so markdown links, autolinks and bare URLs yield exactly the links the person
 * sees, and code spans, fenced code and images yield none.
 */
export function extractMessageLinks(text: string): string[] {
  const links = new Set<string>();
  marked.walkTokens(marked.lexer(text, { gfm: true, breaks: true }), (token) => {
    if (token.type !== "link") return;
    const href = token.href.trim();
    if (!/^https?:\/\//i.test(href)) return;
    try {
      if (!new URL(href).hostname) return;
    } catch {
      return;
    }
    links.add(href);
  });
  return [...links];
}
