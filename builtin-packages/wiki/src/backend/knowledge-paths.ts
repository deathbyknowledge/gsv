export const KNOWLEDGE_ROOT = "knowledge";
export const DIR_MARKER = ".dir";
export const DEFAULT_LIMIT = 100;

export function normalizeKnowledgePath(input: string): string {
  const trimmed = input.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }
  const parts = trimmed.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === "..") {
      throw new Error(`Invalid knowledge path '${input}'`);
    }
  }
  return parts.join("/");
}

export function normalizeDbId(input: string): string {
  const db = normalizeKnowledgePath(input);
  if (!db) {
    throw new Error("Knowledge db id cannot be empty");
  }
  return db;
}

export function toRepoPath(relPath: string): string {
  const normalized = normalizeKnowledgePath(relPath);
  return normalized ? `${KNOWLEDGE_ROOT}/${normalized}` : KNOWLEDGE_ROOT;
}

export function parseDbPagePath(path: string): { db: string; pageEntry: string } | null {
  const parts = path.split("/");
  if (parts.length < 3 || parts[1] !== "pages") {
    return null;
  }
  return { db: parts[0], pageEntry: parts.slice(1).join("/") };
}

export function deriveTitle(path: string): string {
  const leaf = path.split("/").filter(Boolean).pop() ?? "knowledge";
  return leaf.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim() || "knowledge";
}

export function deriveDbTitleFromIndex(markdown: string, db: string): string {
  const line = markdown.replace(/\r\n/g, "\n").split("\n").find((entry) => entry.startsWith("# "));
  return line?.slice(2).trim() || deriveTitle(db);
}

export function buildDbNotePath(db: string, mode: "inbox" | "page", seed: string): string {
  const stem = slugify(seed).slice(0, 64) || "note";
  if (mode === "page") {
    return `${db}/pages/${stem}.md`;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${db}/inbox/${stamp}-${stem}.md`;
}

export function defaultCompiledPath(db: string, sourcePath: string, title: string): string {
  if (sourcePath.startsWith(`${db}/pages/`)) {
    return sourcePath;
  }
  return `${db}/pages/${slugify(title || basename(sourcePath)).slice(0, 64) || "note"}.md`;
}

export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

export function renderDbIndex(_db: string, title: string, description?: string, pages?: string[]): string {
  const cleanPages = dedupeKeepOrder((pages ?? []).map((page) => page.trim()).filter(Boolean));
  const parts = [`# ${title}`];
  if (description) {
    parts.push(description.trim());
  }
  parts.push("## Pages");
  parts.push(cleanPages.length === 0 ? "- _No pages yet._" : cleanPages.map((page) => `- ${page}`).join("\n"));
  return `${parts.join("\n\n")}\n`;
}

export function mergeDbIndexPages(markdown: string, pageEntries: string[]): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const titleLine = lines.find((line) => line.startsWith("# "));
  const title = titleLine?.slice(2).trim() || "Knowledge DB";
  const headerEnd = lines.findIndex((line) => line.trim() === "## Pages");
  const descriptionLines = headerEnd > 1 ? trimEmptyLines(lines.slice(1, headerEnd)) : [];
  const existingPages = lines
    .slice(headerEnd >= 0 ? headerEnd + 1 : 0)
    .map((line) => line.match(/^\s*-\s+(.*)$/)?.[1] ?? "")
    .filter((line) => line && line !== "_No pages yet._");
  const merged = dedupeKeepOrder([...existingPages, ...pageEntries.map((entry) => entry.trim()).filter(Boolean)]).sort();
  return renderDbIndex("", title, descriptionLines.join("\n"), merged);
}

export function buildInboxPath(targetPath: string | undefined, sourceText: string): string {
  const slugBase = targetPath ? targetPath.split("/").pop() ?? targetPath : sourceText;
  const slug = slugify(slugBase).slice(0, 48) || "candidate";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const pageRef = targetPath ? parseDbPagePath(targetPath) : null;
  return pageRef ? `${pageRef.db}/inbox/${stamp}-${slug}.md` : `inbox/${stamp}-${slug}.md`;
}

export function buildCandidateTitle(targetPath: string | undefined, sourceText: string): string {
  if (targetPath) {
    return `Candidate for ${normalizeKnowledgePath(targetPath)}`;
  }
  const sentence = sourceText.split(/\n+/)[0]?.trim() ?? "Candidate knowledge";
  return sentence.slice(0, 80) || "Candidate knowledge";
}

export function clampLimit(limit: number | undefined, fallback: number): number {
  if (!Number.isFinite(limit) || !limit || limit < 1) {
    return fallback;
  }
  return Math.min(500, Math.floor(limit));
}

export function slugify(input: string): string {
  return input.toLowerCase().replace(/\.md$/i, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function trimEmptyLines(lines: string[]): string[] {
  const copy = [...lines];
  while (copy.length > 0 && !copy[0].trim()) copy.shift();
  while (copy.length > 0 && !copy[copy.length - 1].trim()) copy.pop();
  return copy;
}

function dedupeKeepOrder(values: string[]): string[] {
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
