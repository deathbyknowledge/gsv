import type { KnowledgeDoc, KnowledgeSourceRef, KnowledgeWriteArgs } from "./knowledge-types";
import { deriveTitle } from "./knowledge-paths";

export function createEmptyDoc(path: string): KnowledgeDoc {
  return {
    frontmatter: {},
    title: deriveTitle(path),
    summary: [],
    facts: [],
    preferences: [],
    evidence: [],
    aliases: [],
    tags: [],
    links: [],
    sources: [],
    otherSections: [],
  };
}

export function extractSummaryText(markdown: string, path: string): string {
  const doc = parseKnowledgeDoc(markdown, path);
  if (doc.summary.length > 0) {
    return doc.summary.join("\n\n");
  }
  return markdown.trim();
}

export function parseKnowledgeDoc(markdown: string, path: string): KnowledgeDoc {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let title = typeof frontmatter.title === "string" && frontmatter.title.trim() ? frontmatter.title.trim() : "";
  let index = 0;
  while (index < lines.length && !lines[index].trim()) index += 1;
  if (!title && lines[index]?.startsWith("# ")) {
    title = lines[index].slice(2).trim();
    index += 1;
  }
  if (!title) {
    title = deriveTitle(path);
  }

  const preamble: string[] = [];
  const sections: Array<{ heading: string; lines: string[] }> = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      current = { heading: heading[1].trim(), lines: [] };
      sections.push(current);
      continue;
    }
    if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }

  const doc: KnowledgeDoc = {
    frontmatter,
    title,
    summary: compactParagraphs(preamble),
    facts: [],
    preferences: [],
    evidence: [],
    aliases: arrayFromFrontmatter(frontmatter.aliases),
    tags: arrayFromFrontmatter(frontmatter.tags),
    links: arrayFromFrontmatter(frontmatter.links),
    sources: [],
    otherSections: [],
  };

  for (const section of sections) {
    const key = normalizeHeading(section.heading);
    if (key === "summary") doc.summary = compactParagraphs(section.lines);
    else if (key === "facts") doc.facts = parseBulletSection(section.lines);
    else if (key === "preferences") doc.preferences = parseBulletSection(section.lines);
    else if (key === "evidence") doc.evidence = parseBulletSection(section.lines);
    else if (key === "aliases") doc.aliases = union(doc.aliases, parseBulletSection(section.lines));
    else if (key === "tags") doc.tags = union(doc.tags, parseBulletSection(section.lines));
    else if (key === "links") doc.links = union(doc.links, parseBulletSection(section.lines));
    else if (key === "sources") doc.sources = dedupeSourceRefs(parseSourceSection(section.lines));
    else doc.otherSections.push(section);
  }
  return doc;
}

export function renderKnowledgeDoc(doc: KnowledgeDoc): string {
  const frontmatter: Record<string, unknown> = {
    ...doc.frontmatter,
    updated_at: new Date().toISOString(),
  };
  if (doc.aliases.length > 0) frontmatter.aliases = doc.aliases;
  else delete frontmatter.aliases;
  if (doc.tags.length > 0) frontmatter.tags = doc.tags;
  else delete frontmatter.tags;
  if (doc.links.length > 0) frontmatter.links = doc.links;
  else delete frontmatter.links;
  if (frontmatter.title === doc.title) delete frontmatter.title;

  const parts: string[] = [];
  const renderedFrontmatter = renderFrontmatter(frontmatter);
  if (renderedFrontmatter) {
    parts.push(renderedFrontmatter.trimEnd());
  }
  parts.push(`# ${doc.title}`);
  if (doc.summary.length > 0) {
    parts.push(doc.summary.join("\n\n"));
  }
  appendBulletSection(parts, "Facts", doc.facts);
  appendBulletSection(parts, "Preferences", doc.preferences);
  appendBulletSection(parts, "Evidence", doc.evidence);
  appendSourceSection(parts, doc.sources);
  for (const section of doc.otherSections) {
    const content = trimEmptyLines(section.lines).join("\n").trim();
    if (content) {
      parts.push(`## ${section.heading}\n${content}`);
    }
  }
  return `${parts.filter(Boolean).join("\n\n").trim()}\n`;
}

export function applyKnowledgePatch(
  base: KnowledgeDoc,
  patch: NonNullable<KnowledgeWriteArgs["patch"]>,
  mode: "replace" | "merge" | "append",
): KnowledgeDoc {
  const next: KnowledgeDoc = {
    frontmatter: { ...base.frontmatter },
    title: patch.title?.trim() || base.title,
    summary: [...base.summary],
    facts: [...base.facts],
    preferences: [...base.preferences],
    evidence: [...base.evidence],
    aliases: [...base.aliases],
    tags: [...base.tags],
    links: [...base.links],
    sources: [...base.sources],
    otherSections: base.otherSections.map((section) => ({
      heading: section.heading,
      lines: [...section.lines],
    })),
  };

  if (patch.summary) {
    next.summary = mode === "append" && next.summary.length > 0
      ? union(next.summary, [patch.summary.trim()])
      : [patch.summary.trim()];
  }
  if (patch.addFacts) {
    next.facts = mode === "append" ? [...next.facts, ...sanitizeList(patch.addFacts)] : union(next.facts, patch.addFacts);
  }
  if (patch.addPreferences) {
    next.preferences = mode === "append"
      ? [...next.preferences, ...sanitizeList(patch.addPreferences)]
      : union(next.preferences, patch.addPreferences);
  }
  if (patch.addEvidence) {
    next.evidence = mode === "append" ? [...next.evidence, ...sanitizeList(patch.addEvidence)] : union(next.evidence, patch.addEvidence);
  }
  if (patch.addAliases) {
    next.aliases = union(next.aliases, patch.addAliases);
  }
  if (patch.addTags) {
    next.tags = union(next.tags, patch.addTags);
  }
  if (patch.addLinks) {
    next.links = union(next.links, patch.addLinks);
  }
  if (patch.addSources) {
    next.sources = dedupeSourceRefs([...next.sources, ...patch.addSources]);
  }
  if (patch.sections) {
    for (const section of patch.sections) {
      applyGenericSectionPatch(next, section);
    }
  }
  return next;
}

export function applyGenericSectionPatch(
  doc: KnowledgeDoc,
  section: NonNullable<NonNullable<KnowledgeWriteArgs["patch"]>["sections"]>[number],
): void {
  const heading = section.heading.trim();
  if (!heading) {
    return;
  }
  const mode = section.mode ?? "replace";
  const key = normalizeHeading(heading);

  if (mode === "delete") {
    if (key === "summary") doc.summary = [];
    else if (key === "facts") doc.facts = [];
    else if (key === "preferences") doc.preferences = [];
    else if (key === "evidence") doc.evidence = [];
    else if (key === "aliases") doc.aliases = [];
    else if (key === "tags") doc.tags = [];
    else if (key === "links") doc.links = [];
    else if (key === "sources") doc.sources = [];
    else doc.otherSections = doc.otherSections.filter((entry) => normalizeHeading(entry.heading) !== key);
    return;
  }

  const lines = sectionContentToLines(section.content);
  if (key === "summary") {
    const paragraphs = compactParagraphs(lines);
    doc.summary = mode === "append" ? union(doc.summary, paragraphs) : paragraphs;
    return;
  }
  if (key === "facts") {
    const items = parseLooseList(lines);
    doc.facts = mode === "append" ? union(doc.facts, items) : items;
    return;
  }
  if (key === "preferences") {
    const items = parseLooseList(lines);
    doc.preferences = mode === "append" ? union(doc.preferences, items) : items;
    return;
  }
  if (key === "evidence") {
    const items = parseLooseList(lines);
    doc.evidence = mode === "append" ? union(doc.evidence, items) : items;
    return;
  }
  if (key === "aliases") {
    const items = parseLooseList(lines);
    doc.aliases = mode === "append" ? union(doc.aliases, items) : items;
    return;
  }
  if (key === "tags") {
    const items = parseLooseList(lines);
    doc.tags = mode === "append" ? union(doc.tags, items) : items;
    return;
  }
  if (key === "links") {
    const items = parseLooseList(lines);
    doc.links = mode === "append" ? union(doc.links, items) : items;
    return;
  }
  if (key === "sources") {
    const items = parseSourceSection(lines);
    doc.sources = mode === "append" ? dedupeSourceRefs([...doc.sources, ...items]) : dedupeSourceRefs(items);
    return;
  }

  const existing = doc.otherSections.find((entry) => normalizeHeading(entry.heading) === key);
  if (!existing) {
    doc.otherSections.push({ heading, lines });
    return;
  }
  existing.lines = mode === "append" ? [...trimTrailingEmptyLines(existing.lines), "", ...lines] : lines;
}

export function mergeKnowledgeDocs(
  source: KnowledgeDoc,
  target: KnowledgeDoc,
  mode: "prefer-target" | "prefer-source" | "union",
): KnowledgeDoc {
  const preferSource = mode === "prefer-source";
  const preferTarget = mode === "prefer-target";
  return {
    frontmatter: {
      ...source.frontmatter,
      ...target.frontmatter,
    },
    title: preferSource ? source.title : target.title,
    summary: preferTarget
      ? target.summary
      : preferSource
        ? source.summary.length > 0 ? source.summary : target.summary
        : union(target.summary, source.summary),
    facts: union(target.facts, source.facts),
    preferences: union(target.preferences, source.preferences),
    evidence: union(target.evidence, source.evidence),
    aliases: union(union(target.aliases, source.aliases), [source.title, target.title]),
    tags: union(target.tags, source.tags),
    links: union(target.links, source.links),
    sources: dedupeSourceRefs([...target.sources, ...source.sources]),
    otherSections: preferSource ? source.otherSections : target.otherSections,
  };
}

export function splitFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; body: string } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized };
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) {
    return { frontmatter: {}, body: normalized };
  }
  return {
    frontmatter: parseFrontmatterBlock(normalized.slice(4, end)),
    body: normalized.slice(end + 5),
  };
}

export function parseFrontmatterBlock(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let currentArrayKey: string | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && currentArrayKey) {
      const existing = Array.isArray(out[currentArrayKey]) ? out[currentArrayKey] as string[] : [];
      out[currentArrayKey] = [...existing, item[1].trim()];
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!rawValue) {
      out[key] = [];
      currentArrayKey = key;
    } else {
      currentArrayKey = null;
      out[key] = rawValue.trim().replace(/^['"]|['"]$/g, "");
    }
  }
  return out;
}

export function renderFrontmatter(frontmatter: Record<string, unknown>): string {
  const entries = Object.entries(frontmatter).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (entries.length === 0) {
    return "";
  }
  const lines = ["---"];
  for (const [key, value] of entries) {
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${String(item)}`);
      }
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

export function appendBulletSection(parts: string[], heading: string, items: string[]): void {
  const clean = dedupeKeepOrder(items.map((item) => item.trim()).filter(Boolean));
  if (clean.length > 0) {
    parts.push(`## ${heading}\n${clean.map((item) => `- ${item}`).join("\n")}`);
  }
}

export function appendSourceSection(parts: string[], sources: KnowledgeSourceRef[]): void {
  const clean = dedupeSourceRefs(sources);
  if (clean.length > 0) {
    parts.push(`## Sources\n${clean.map((source) => `- ${renderSourceRef(source)}`).join("\n")}`);
  }
}

export function parseBulletSection(lines: string[]): string[] {
  return dedupeKeepOrder(lines
    .map((line) => line.match(/^\s*[-*]\s+(.*)$/)?.[1] ?? "")
    .map((line) => line.trim())
    .filter(Boolean));
}

export function sectionContentToLines(content: string | string[] | undefined): string[] {
  if (Array.isArray(content)) {
    return content.flatMap((line) => String(line).replace(/\r\n/g, "\n").split("\n"));
  }
  if (typeof content === "string") {
    return content.replace(/\r\n/g, "\n").split("\n");
  }
  return [];
}

export function parseLooseList(lines: string[]): string[] {
  return dedupeKeepOrder(lines
    .map((line) => line.match(/^\s*[-*]\s+(.*)$/)?.[1] ?? line)
    .map((line) => line.trim())
    .filter(Boolean));
}

export function parseSourceSection(lines: string[]): KnowledgeSourceRef[] {
  return lines
    .map((line) => line.match(/^\s*[-*]\s+(.*)$/)?.[1]?.trim() ?? line.trim())
    .map(parseSourceRef)
    .filter((value): value is KnowledgeSourceRef => value !== null);
}

export function parseSourceRef(value: string): KnowledgeSourceRef | null {
  const match = value.match(/^\[([^\]]+)\]\s+(.+?)(?:\s+\|\s+(.+))?$/);
  if (!match) {
    return null;
  }
  const [, target, path, title] = match;
  return { target: target.trim(), path: path.trim(), title: title?.trim() || undefined };
}

export function renderSourceRef(source: KnowledgeSourceRef): string {
  const base = `[${source.target}] ${source.path}`;
  return source.title?.trim() ? `${base} | ${source.title.trim()}` : base;
}

export function dedupeSourceRefs(sources: KnowledgeSourceRef[]): KnowledgeSourceRef[] {
  const seen = new Set<string>();
  const out: KnowledgeSourceRef[] = [];
  for (const source of sources) {
    const target = source.target.trim();
    const path = source.path.trim();
    if (!target || !path) continue;
    const key = `${target}\0${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ target, path, title: source.title?.trim() || undefined });
  }
  return out;
}

export function compactParagraphs(lines: string[]): string[] {
  return trimEmptyLines(lines)
    .join("\n")
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function trimEmptyLines(lines: string[]): string[] {
  const copy = [...lines];
  while (copy.length > 0 && !copy[0].trim()) copy.shift();
  while (copy.length > 0 && !copy[copy.length - 1].trim()) copy.pop();
  return copy;
}

export function trimTrailingEmptyLines(lines: string[]): string[] {
  const copy = [...lines];
  while (copy.length > 0 && !copy[copy.length - 1].trim()) copy.pop();
  return copy;
}

export function arrayFromFrontmatter(value: unknown): string[] {
  if (Array.isArray(value)) {
    return dedupeKeepOrder(value.map((item) => String(item).trim()).filter(Boolean));
  }
  return typeof value === "string" && value.trim() ? [value.trim()] : [];
}

export function normalizeHeading(heading: string): string {
  return heading.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function union(existing: string[], incoming: string[]): string[] {
  return dedupeKeepOrder([...existing.map((item) => item.trim()).filter(Boolean), ...incoming.map((item) => item.trim()).filter(Boolean)]);
}

export function sanitizeList(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

export function dedupeKeepOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
