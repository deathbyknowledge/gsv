import { marked } from "marked";

/**
 * The web links a Ship message shows cards for, deduplicated in the order they appear and capped per message. The text goes through the same
 * GFM lexer that renders it, so markdown links, autolinks and bare URLs yield exactly the links the person
 * sees, and code spans, fenced code and images yield none.
 */
export const MAX_MESSAGE_LINK_CARDS = 10;

export function extractMessageLinks(text: string, limit = MAX_MESSAGE_LINK_CARDS): string[] {
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
  // A message's cards stop at a small bound, so rendering a long reply never fans out unbounded Kernel fetches.
  return [...links].slice(0, limit);
}
