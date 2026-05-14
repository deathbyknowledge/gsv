import type { KnowledgeDoc } from "./knowledge-types";

export function normalizeQueryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).map((term) => term.trim()).filter(Boolean);
}

export function scoreMatch(path: string, doc: KnowledgeDoc, markdown: string, terms: string[]): number {
  const haystacks = {
    title: doc.title.toLowerCase(),
    path: path.toLowerCase(),
    aliases: doc.aliases.join(" ").toLowerCase(),
    tags: doc.tags.join(" ").toLowerCase(),
    body: markdown.toLowerCase(),
  };
  let score = 0;
  for (const term of terms) {
    if (haystacks.title.includes(term)) score += 120;
    if (haystacks.aliases.includes(term)) score += 80;
    if (haystacks.tags.includes(term)) score += 60;
    if (haystacks.path.includes(term)) score += 40;
    if (haystacks.body.includes(term)) score += 10;
  }
  return score;
}

export function buildSnippet(markdown: string, title: string, query: string): string {
  const text = markdown.replace(/\s+/g, " ").trim();
  if (!text) {
    return title;
  }
  const lower = text.toLowerCase();
  const target = query.trim().toLowerCase();
  const index = target ? lower.indexOf(target) : -1;
  if (index < 0) {
    return text.slice(0, 160);
  }
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + target.length + 100);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}
