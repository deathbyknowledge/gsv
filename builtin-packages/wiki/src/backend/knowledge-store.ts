import type {
  RepoApplyOp,
  RepoReadResult,
  RepoSummary,
} from "@gsv/protocol/syscalls/repositories";

export type WikiKernelClient = {
  request<T = unknown>(name: string, args: unknown): Promise<T>;
};

export type KnowledgeSourceRef = { target: string; path: string; title?: string };

export type KnowledgeWriteArgs = {
  path: string;
  mode?: "replace" | "merge" | "append";
  markdown?: string;
  patch?: {
    title?: string;
    summary?: string;
    addFacts?: string[];
    addPreferences?: string[];
    addEvidence?: string[];
    addAliases?: string[];
    addTags?: string[];
    addLinks?: string[];
    addSources?: KnowledgeSourceRef[];
    sections?: Array<{
      heading: string;
      mode?: "replace" | "append" | "delete";
      content?: string | string[];
    }>;
  };
  create?: boolean;
};

export type KnowledgePromoteArgs = {
  source:
    | { kind: "text"; text: string }
    | { kind: "candidate"; path: string }
    | { kind: "process"; pid: string; runId?: string; messageIds?: number[] };
  targetPath?: string;
  mode?: "inbox" | "direct";
};

export type KnowledgeCompileArgs = { db: string; sourcePath: string; targetPath?: string; title?: string; keepSource?: boolean };
export type KnowledgeDbDeleteArgs = { id: string };
export type KnowledgeDbInitArgs = { id: string; title?: string; description?: string };
export type KnowledgeIngestArgs = {
  db: string;
  sources: KnowledgeSourceRef[];
  title?: string;
  summary?: string;
  path?: string;
  mode?: "inbox" | "page";
};
export type KnowledgeListArgs = { prefix?: string; recursive?: boolean; limit?: number };
export type KnowledgeMergeArgs = { sourcePath: string; targetPath: string; mode?: "prefer-target" | "prefer-source" | "union"; keepSource?: boolean };
export type KnowledgeQueryArgs = { query: string; prefixes?: string[]; limit?: number; maxBytes?: number };
export type KnowledgeReadArgs = { path: string };
export type KnowledgeSearchArgs = { query: string; prefix?: string; limit?: number };

type KnowledgeDoc = {
  frontmatter: Record<string, unknown>;
  title: string;
  summary: string[];
  facts: string[];
  preferences: string[];
  evidence: string[];
  aliases: string[];
  tags: string[];
  links: string[];
  sources: KnowledgeSourceRef[];
  otherSections: Array<{ heading: string; lines: string[] }>;
};

type SearchMatch = {
  path: string;
  title?: string;
  snippet: string;
  score: number;
};

const KNOWLEDGE_ROOT = "knowledge";
const DIR_MARKER = ".dir";
const DEFAULT_LIMIT = 100;
const DEFAULT_QUERY_LIMIT = 5;
const DEFAULT_QUERY_MAX_BYTES = 4096;
const encoder = new TextEncoder();

export class WikiKnowledgeStore {
  private homeRepo: string | null = null;

  constructor(private readonly kernel: WikiKernelClient) {}

  async listDbs(args: { limit?: number }) {
    const limit = clampLimit(args.limit, DEFAULT_LIMIT);
    const root = await this.readPath(KNOWLEDGE_ROOT);
    if (root.kind !== "tree") {
      return { dbs: [] };
    }

    const dbs: Array<{ id: string; title?: string }> = [];
    for (const entry of [...root.entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.type !== "tree" || entry.name === "inbox" || entry.name === DIR_MARKER) {
        continue;
      }
      const index = await this.readPath(`${KNOWLEDGE_ROOT}/${entry.name}/index.md`);
      if (index.kind !== "file") {
        continue;
      }
      dbs.push({
        id: entry.name,
        title: deriveDbTitleFromIndex(index.content ?? "", entry.name),
      });
      if (dbs.length >= limit) {
        break;
      }
    }
    return { dbs };
  }

  async initDb(args: KnowledgeDbInitArgs) {
    const db = normalizeDbId(args.id);
    const indexPath = `${KNOWLEDGE_ROOT}/${db}/index.md`;
    const existingIndex = await this.readPath(indexPath);
    const created = existingIndex.kind === "missing";

    const ops: RepoApplyOp[] = [];
    if (existingIndex.kind === "missing") {
      ops.push({
        type: "put",
        path: indexPath,
        content: renderDbIndex(db, args.title?.trim() || deriveTitle(db), args.description?.trim(), []),
      });
    }
    if ((await this.readPath(`${KNOWLEDGE_ROOT}/${db}/pages`)).kind === "missing") {
      ops.push({ type: "put", path: `${KNOWLEDGE_ROOT}/${db}/pages/.dir`, content: "" });
    }
    if ((await this.readPath(`${KNOWLEDGE_ROOT}/${db}/inbox`)).kind === "missing") {
      ops.push({ type: "put", path: `${KNOWLEDGE_ROOT}/${db}/inbox/.dir`, content: "" });
    }
    if (ops.length > 0) {
      await this.apply(`wiki: init ${db}`, ops);
    }
    return { ok: true, id: db, created };
  }

  async list(args: KnowledgeListArgs) {
    const prefix = normalizeKnowledgePath(args.prefix ?? "");
    const recursive = args.recursive === true;
    const limit = clampLimit(args.limit, DEFAULT_LIMIT);
    const node = await this.readPath(toRepoPath(prefix));
    if (node.kind === "missing") {
      return { entries: [] };
    }
    if (node.kind === "file") {
      return { entries: [{ path: prefix, kind: "file" as const, title: deriveTitle(prefix) }] };
    }

    const entries: Array<{ path: string; kind: "file" | "dir"; title?: string }> = [];
    const queue: Array<{ repoPath: string; relPath: string; node?: Extract<RepoNode, { kind: "tree" }> }> = [
      { repoPath: toRepoPath(prefix), relPath: prefix, node },
    ];
    while (queue.length > 0 && entries.length < limit) {
      const current = queue.shift()!;
      const currentNode = current.node ?? await this.readPath(current.repoPath);
      if (currentNode.kind !== "tree") {
        continue;
      }
      for (const entry of [...currentNode.entries].sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === DIR_MARKER) {
          continue;
        }
        const relPath = current.relPath ? `${current.relPath}/${entry.name}` : entry.name;
        if (entry.type === "tree") {
          entries.push({ path: relPath, kind: "dir" });
          if (recursive && entries.length < limit) {
            queue.push({ repoPath: `${current.repoPath}/${entry.name}`, relPath });
          }
        } else {
          entries.push({ path: relPath, kind: "file", title: deriveTitle(relPath) });
        }
        if (entries.length >= limit) {
          break;
        }
      }
    }
    return { entries };
  }

  async read(args: KnowledgeReadArgs) {
    const path = normalizeKnowledgePath(args.path);
    const node = await this.readPath(toRepoPath(path));
    if (node.kind === "missing") {
      return { path, exists: false };
    }
    if (node.kind !== "file") {
      throw new Error(`Knowledge path '${path}' is not a file`);
    }
    const markdown = node.content ?? "";
    const doc = parseKnowledgeDoc(markdown, path);
    return {
      path,
      exists: true,
      title: doc.title,
      frontmatter: Object.keys(doc.frontmatter).length > 0 ? doc.frontmatter : undefined,
      markdown,
      sources: doc.sources,
    };
  }

  async write(args: KnowledgeWriteArgs) {
    const path = normalizeKnowledgePath(args.path);
    const pageRef = parseDbPagePath(path);
    if (pageRef) {
      const init = await this.initDb({ id: pageRef.db });
      if (!init.ok) {
        return { ok: false, error: "Failed to initialize database" };
      }
    }
    const existing = await this.readPath(toRepoPath(path));
    const created = existing.kind === "missing";
    if (!created && existing.kind !== "file") {
      return { ok: false, error: `Knowledge path '${path}' is not a file` };
    }
    if (created && args.create === false) {
      return { ok: false, error: `Knowledge note '${path}' does not exist` };
    }

    let markdown: string;
    if (typeof args.markdown === "string") {
      markdown = args.markdown;
    } else if (args.patch) {
      const mode = args.mode ?? "merge";
      const base = existing.kind === "file" ? parseKnowledgeDoc(existing.content ?? "", path) : createEmptyDoc(path);
      markdown = renderKnowledgeDoc(applyKnowledgePatch(base, args.patch, mode));
    } else {
      return { ok: false, error: "Knowledge write requires markdown or patch" };
    }

    const ops: RepoApplyOp[] = [{ type: "put", path: toRepoPath(path), content: markdown }];
    if (pageRef) {
      ops.push(...await this.dbIndexUpdateOps(pageRef.db, [pageRef.pageEntry]));
    }
    await this.apply(`wiki: update ${path}`, ops);
    return { ok: true, path, created, updated: !created };
  }

  async search(args: KnowledgeSearchArgs) {
    const prefix = normalizeKnowledgePath(args.prefix ?? "");
    const limit = clampLimit(args.limit, DEFAULT_LIMIT);
    return { matches: await this.collectSearchMatches(args.query, prefix, limit) };
  }

  async query(args: KnowledgeQueryArgs) {
    const limit = clampLimit(args.limit, DEFAULT_QUERY_LIMIT);
    const maxBytes = Math.max(256, args.maxBytes ?? DEFAULT_QUERY_MAX_BYTES);
    const prefixes = (args.prefixes ?? []).map((prefix) => normalizeKnowledgePath(prefix));
    const searchPrefixes = prefixes.length > 0 ? prefixes : [""];

    const collected: SearchMatch[] = [];
    for (const prefix of searchPrefixes) {
      for (const match of await this.collectSearchMatches(args.query, prefix, limit)) {
        if (!collected.some((existing) => existing.path === match.path)) {
          collected.push(match);
        }
      }
    }
    collected.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const topMatches = collected.slice(0, limit);
    const refs = topMatches.map((match) => ({ path: match.path, title: match.title }));

    let remaining = maxBytes;
    const lines = ["## Relevant knowledge"];
    for (const match of topMatches) {
      const note = await this.read({ path: match.path });
      if (!note.exists || !note.markdown) {
        continue;
      }
      const doc = parseKnowledgeDoc(note.markdown, match.path);
      const excerpt = compactExcerpt(doc, remaining);
      if (!excerpt) {
        continue;
      }
      const heading = `### ${doc.title} (${match.path})`;
      lines.push(heading, excerpt);
      remaining -= encoder.encode(`${heading}\n${excerpt}\n`).length;
      if (remaining <= 0) {
        break;
      }
    }
    if (lines.length === 1) {
      lines.push("- No relevant knowledge found.");
    }
    return { brief: `${lines.join("\n\n")}\n`, refs };
  }

  async merge(args: KnowledgeMergeArgs) {
    const sourcePath = normalizeKnowledgePath(args.sourcePath);
    const targetPath = normalizeKnowledgePath(args.targetPath);
    if (sourcePath === targetPath) {
      return { ok: false, error: "Source and target must differ" };
    }

    const [source, target] = await Promise.all([
      this.read({ path: sourcePath }),
      this.read({ path: targetPath }),
    ]);
    if (!source.exists || !source.markdown) {
      return { ok: false, error: `Knowledge note '${sourcePath}' does not exist` };
    }
    if (!target.exists || !target.markdown) {
      return { ok: false, error: `Knowledge note '${targetPath}' does not exist` };
    }

    const merged = mergeKnowledgeDocs(
      parseKnowledgeDoc(source.markdown, sourcePath),
      parseKnowledgeDoc(target.markdown, targetPath),
      args.mode ?? "union",
    );
    const ops: RepoApplyOp[] = [{ type: "put", path: toRepoPath(targetPath), content: renderKnowledgeDoc(merged) }];
    if (!args.keepSource) {
      ops.push({ type: "delete", path: toRepoPath(sourcePath) });
    }
    await this.apply(`wiki: merge ${sourcePath} -> ${targetPath}`, ops);
    return { ok: true, sourcePath, targetPath, removedSource: !args.keepSource };
  }

  async promote(args: KnowledgePromoteArgs) {
    const mode = args.mode ?? (args.targetPath ? "direct" : "inbox");
    const now = new Date().toISOString();
    const targetPath = args.targetPath ? normalizeKnowledgePath(args.targetPath) : undefined;
    const targetPageRef = targetPath ? parseDbPagePath(targetPath) : null;

    if (targetPageRef) {
      const init = await this.initDb({ id: targetPageRef.db });
      if (!init.ok) {
        return { ok: false, error: "Failed to initialize database" };
      }
    }

    if (args.source.kind === "candidate") {
      const sourcePath = normalizeKnowledgePath(args.source.path);
      if (mode === "inbox") {
        return { ok: true, path: sourcePath, created: false, requiresReview: true };
      }
      if (!targetPath) {
        return { ok: false, error: "Direct promotion requires a targetPath" };
      }
      const candidate = await this.read({ path: sourcePath });
      if (!candidate.exists || !candidate.markdown) {
        return { ok: false, error: `Candidate note '${sourcePath}' does not exist` };
      }
      const direct = await this.write({
        path: targetPath,
        mode: "append",
        patch: {
          summary: extractSummaryText(candidate.markdown, sourcePath),
          addEvidence: [`Promoted from candidate ${sourcePath} on ${now}`],
        },
        create: true,
      });
      return direct.ok
        ? { ok: true, path: direct.path, created: direct.created, requiresReview: false }
        : direct;
    }

    if (args.source.kind === "process") {
      return { ok: false, error: "Process promotion is not wired yet; use direct text promotion or a candidate note first" };
    }

    const sourceText = args.source.text.trim();
    if (!sourceText) {
      return { ok: false, error: "Promotion source text cannot be empty" };
    }

    if (mode === "direct") {
      if (!targetPath) {
        return { ok: false, error: "Direct promotion requires a targetPath" };
      }
      const direct = await this.write({
        path: targetPath,
        mode: "append",
        patch: {
          summary: sourceText,
          addEvidence: [`Promoted from text on ${now}`],
        },
        create: true,
      });
      return direct.ok
        ? { ok: true, path: direct.path, created: direct.created, requiresReview: false }
        : direct;
    }

    const candidatePath = buildInboxPath(targetPath, sourceText);
    const candidateMarkdown = renderKnowledgeDoc({
      frontmatter: {
        proposed_target: targetPath,
        created_at: now,
      },
      title: buildCandidateTitle(targetPath, sourceText),
      summary: [sourceText],
      facts: [],
      preferences: [],
      evidence: [
        `Promoted from text on ${now}`,
        ...(targetPath ? [`Suggested target: ${targetPath}`] : []),
      ],
      aliases: [],
      tags: ["candidate"],
      links: [],
      sources: [],
      otherSections: [],
    });

    await this.apply(`wiki: promote candidate ${candidatePath}`, [
      { type: "put", path: toRepoPath(candidatePath), content: candidateMarkdown },
    ]);
    return { ok: true, path: candidatePath, created: true, requiresReview: true };
  }

  async ingest(args: KnowledgeIngestArgs) {
    const db = normalizeDbId(args.db);
    const init = await this.initDb({ id: db });
    if (!init.ok) {
      return { ok: false, error: "Failed to initialize database" };
    }
    if (!Array.isArray(args.sources) || args.sources.length === 0) {
      return { ok: false, error: "Knowledge ingest requires at least one source" };
    }
    const mode = args.mode ?? "inbox";
    const path = args.path
      ? normalizeKnowledgePath(args.path)
      : buildDbNotePath(db, mode, args.title ?? args.sources[0]?.title ?? "source");
    const existing = await this.readPath(toRepoPath(path));
    const created = existing.kind === "missing";
    const markdown = renderKnowledgeDoc({
      frontmatter: {
        db,
        created_at: new Date().toISOString(),
      },
      title: args.title?.trim() || deriveTitle(path),
      summary: args.summary?.trim() ? [args.summary.trim()] : [],
      facts: [],
      preferences: [],
      evidence: [],
      aliases: [],
      tags: mode === "inbox" ? ["candidate"] : [],
      links: [],
      sources: dedupeSourceRefs(args.sources),
      otherSections: [],
    });

    const ops: RepoApplyOp[] = [{ type: "put", path: toRepoPath(path), content: markdown }];
    if (mode === "page") {
      const pageRef = parseDbPagePath(path);
      ops.push(...await this.dbIndexUpdateOps(db, pageRef ? [pageRef.pageEntry] : [`pages/${basename(path)}`]));
    }
    await this.apply(`wiki: ingest ${path}`, ops);
    return { ok: true, db, path, created, requiresReview: mode !== "page" };
  }

  async compile(args: KnowledgeCompileArgs) {
    const db = normalizeDbId(args.db);
    const sourcePath = normalizeKnowledgePath(args.sourcePath);
    const source = await this.read({ path: sourcePath });
    if (!source.exists || !source.markdown) {
      return { ok: false, error: `Knowledge note '${sourcePath}' does not exist` };
    }

    const sourceDoc = parseKnowledgeDoc(source.markdown, sourcePath);
    const targetPath = args.targetPath
      ? normalizeKnowledgePath(args.targetPath)
      : defaultCompiledPath(db, sourcePath, sourceDoc.title);
    const removedSource = args.keepSource !== true && sourcePath !== targetPath;
    const compiledDoc: KnowledgeDoc = {
      ...sourceDoc,
      frontmatter: {
        ...sourceDoc.frontmatter,
        db,
        compiled_at: new Date().toISOString(),
      },
      title: args.title?.trim() || sourceDoc.title,
      tags: sourceDoc.tags.filter((tag) => tag.toLowerCase() !== "candidate"),
    };

    const ops: RepoApplyOp[] = [{ type: "put", path: toRepoPath(targetPath), content: renderKnowledgeDoc(compiledDoc) }];
    if (removedSource) {
      ops.push({ type: "delete", path: toRepoPath(sourcePath) });
    }
    const pageRef = parseDbPagePath(targetPath);
    ops.push(...await this.dbIndexUpdateOps(db, pageRef ? [pageRef.pageEntry] : [`pages/${basename(targetPath)}`]));
    await this.apply(`wiki: compile ${sourcePath}`, ops);
    return { ok: true, db, path: targetPath, sourcePath, removedSource };
  }

  async deleteDb(args: KnowledgeDbDeleteArgs) {
    const id = normalizeDbId(args.id);
    const repoPath = toRepoPath(id);
    const existing = await this.readPath(repoPath);
    if (existing.kind === "missing") {
      return { ok: true, id, removed: false };
    }
    await this.apply(`wiki: delete db ${id}`, [{ type: "delete", path: repoPath, recursive: true }]);
    return { ok: true, id, removed: true };
  }

  private async collectSearchMatches(query: string, prefix: string, limit: number): Promise<SearchMatch[]> {
    const terms = normalizeQueryTerms(query);
    if (terms.length === 0) {
      return [];
    }
    const files = await this.collectFilePaths(prefix, Math.max(limit * 5, limit));
    const matches: SearchMatch[] = [];
    for (const path of files) {
      const note = await this.read({ path });
      if (!note.exists || !note.markdown) {
        continue;
      }
      const doc = parseKnowledgeDoc(note.markdown, path);
      const score = scoreMatch(path, doc, note.markdown, terms);
      if (score <= 0) {
        continue;
      }
      matches.push({
        path,
        title: doc.title,
        snippet: buildSnippet(note.markdown, doc.title, query),
        score,
      });
    }
    matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return matches.slice(0, limit);
  }

  private async collectFilePaths(prefix: string, limit: number): Promise<string[]> {
    const root = await this.readPath(toRepoPath(prefix));
    if (root.kind === "missing") {
      return [];
    }
    if (root.kind === "file") {
      return [prefix];
    }

    const files: string[] = [];
    const queue: Array<{ repoPath: string; relPath: string; node?: Extract<RepoNode, { kind: "tree" }> }> = [
      { repoPath: toRepoPath(prefix), relPath: prefix, node: root },
    ];
    while (queue.length > 0 && files.length < limit) {
      const current = queue.shift()!;
      const node = current.node ?? await this.readPath(current.repoPath);
      if (node.kind !== "tree") {
        continue;
      }
      for (const entry of node.entries) {
        if (entry.name === DIR_MARKER) {
          continue;
        }
        const relPath = current.relPath ? `${current.relPath}/${entry.name}` : entry.name;
        if (entry.type === "tree") {
          queue.push({ repoPath: `${current.repoPath}/${entry.name}`, relPath });
        } else {
          files.push(relPath);
        }
        if (files.length >= limit) {
          break;
        }
      }
    }
    return files;
  }

  private async dbIndexUpdateOps(db: string, pageEntries: string[]): Promise<RepoApplyOp[]> {
    const path = `${KNOWLEDGE_ROOT}/${db}/index.md`;
    const existing = await this.readPath(path);
    const current = existing.kind === "file" ? existing.content ?? "" : renderDbIndex(db, deriveTitle(db), undefined, []);
    const updated = mergeDbIndexPages(current, pageEntries);
    return updated === current ? [] : [{ type: "put", path, content: updated }];
  }

  private async readPath(path: string): Promise<RepoNode> {
    try {
      const result = await this.kernel.request<RepoReadResult>("repo.read", {
        repo: await this.getHomeRepo(),
        path,
      });
      if (result.kind === "tree") {
        return {
          kind: "tree",
          entries: result.entries,
        };
      }
      return {
        kind: "file",
        content: result.content,
        isBinary: result.isBinary,
        size: result.size,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Path not found")) {
        return { kind: "missing" };
      }
      throw error;
    }
  }

  private async apply(message: string, ops: RepoApplyOp[]): Promise<void> {
    await this.kernel.request("repo.apply", {
      repo: await this.getHomeRepo(),
      message,
      ops,
    });
  }

  private async getHomeRepo(): Promise<string> {
    if (this.homeRepo) {
      return this.homeRepo;
    }
    const result = await this.kernel.request<{ repos: RepoSummary[] }>("repo.list", {});
    const home = result.repos.find((repo) => repo.kind === "home");
    if (!home) {
      throw new Error("Home repository is not available");
    }
    this.homeRepo = home.repo;
    return home.repo;
  }
}

type RepoNode =
  | { kind: "missing" }
  | { kind: "tree"; entries: Extract<RepoReadResult, { kind: "tree" }>["entries"] }
  | { kind: "file"; content: string | null; isBinary: boolean; size: number };

function normalizeKnowledgePath(input: string): string {
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

function normalizeDbId(input: string): string {
  const db = normalizeKnowledgePath(input);
  if (!db) {
    throw new Error("Knowledge db id cannot be empty");
  }
  return db;
}

function toRepoPath(relPath: string): string {
  const normalized = normalizeKnowledgePath(relPath);
  return normalized ? `${KNOWLEDGE_ROOT}/${normalized}` : KNOWLEDGE_ROOT;
}

function parseDbPagePath(path: string): { db: string; pageEntry: string } | null {
  const parts = path.split("/");
  if (parts.length < 3 || parts[1] !== "pages") {
    return null;
  }
  return { db: parts[0], pageEntry: parts.slice(1).join("/") };
}

function parseKnowledgeDoc(markdown: string, path: string): KnowledgeDoc {
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

function renderKnowledgeDoc(doc: KnowledgeDoc): string {
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

function applyKnowledgePatch(
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

function applyGenericSectionPatch(
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

function mergeKnowledgeDocs(
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

function splitFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; body: string } {
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

function parseFrontmatterBlock(raw: string): Record<string, unknown> {
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

function renderFrontmatter(frontmatter: Record<string, unknown>): string {
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

function appendBulletSection(parts: string[], heading: string, items: string[]): void {
  const clean = dedupeKeepOrder(items.map((item) => item.trim()).filter(Boolean));
  if (clean.length > 0) {
    parts.push(`## ${heading}\n${clean.map((item) => `- ${item}`).join("\n")}`);
  }
}

function appendSourceSection(parts: string[], sources: KnowledgeSourceRef[]): void {
  const clean = dedupeSourceRefs(sources);
  if (clean.length > 0) {
    parts.push(`## Sources\n${clean.map((source) => `- ${renderSourceRef(source)}`).join("\n")}`);
  }
}

function parseBulletSection(lines: string[]): string[] {
  return dedupeKeepOrder(lines
    .map((line) => line.match(/^\s*[-*]\s+(.*)$/)?.[1] ?? "")
    .map((line) => line.trim())
    .filter(Boolean));
}

function sectionContentToLines(content: string | string[] | undefined): string[] {
  if (Array.isArray(content)) {
    return content.flatMap((line) => String(line).replace(/\r\n/g, "\n").split("\n"));
  }
  if (typeof content === "string") {
    return content.replace(/\r\n/g, "\n").split("\n");
  }
  return [];
}

function parseLooseList(lines: string[]): string[] {
  return dedupeKeepOrder(lines
    .map((line) => line.match(/^\s*[-*]\s+(.*)$/)?.[1] ?? line)
    .map((line) => line.trim())
    .filter(Boolean));
}

function parseSourceSection(lines: string[]): KnowledgeSourceRef[] {
  return lines
    .map((line) => line.match(/^\s*[-*]\s+(.*)$/)?.[1]?.trim() ?? line.trim())
    .map(parseSourceRef)
    .filter((value): value is KnowledgeSourceRef => value !== null);
}

function parseSourceRef(value: string): KnowledgeSourceRef | null {
  const match = value.match(/^\[([^\]]+)\]\s+(.+?)(?:\s+\|\s+(.+))?$/);
  if (!match) {
    return null;
  }
  const [, target, path, title] = match;
  return { target: target.trim(), path: path.trim(), title: title?.trim() || undefined };
}

function renderSourceRef(source: KnowledgeSourceRef): string {
  const base = `[${source.target}] ${source.path}`;
  return source.title?.trim() ? `${base} | ${source.title.trim()}` : base;
}

function dedupeSourceRefs(sources: KnowledgeSourceRef[]): KnowledgeSourceRef[] {
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

function compactParagraphs(lines: string[]): string[] {
  return trimEmptyLines(lines)
    .join("\n")
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function trimEmptyLines(lines: string[]): string[] {
  const copy = [...lines];
  while (copy.length > 0 && !copy[0].trim()) copy.shift();
  while (copy.length > 0 && !copy[copy.length - 1].trim()) copy.pop();
  return copy;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  const copy = [...lines];
  while (copy.length > 0 && !copy[copy.length - 1].trim()) copy.pop();
  return copy;
}

function arrayFromFrontmatter(value: unknown): string[] {
  if (Array.isArray(value)) {
    return dedupeKeepOrder(value.map((item) => String(item).trim()).filter(Boolean));
  }
  return typeof value === "string" && value.trim() ? [value.trim()] : [];
}

function normalizeHeading(heading: string): string {
  return heading.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function union(existing: string[], incoming: string[]): string[] {
  return dedupeKeepOrder([...existing.map((item) => item.trim()).filter(Boolean), ...incoming.map((item) => item.trim()).filter(Boolean)]);
}

function sanitizeList(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
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

function deriveTitle(path: string): string {
  const leaf = path.split("/").filter(Boolean).pop() ?? "knowledge";
  return leaf.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim() || "knowledge";
}

function deriveDbTitleFromIndex(markdown: string, db: string): string {
  const line = markdown.replace(/\r\n/g, "\n").split("\n").find((entry) => entry.startsWith("# "));
  return line?.slice(2).trim() || deriveTitle(db);
}

function buildDbNotePath(db: string, mode: "inbox" | "page", seed: string): string {
  const stem = slugify(seed).slice(0, 64) || "note";
  if (mode === "page") {
    return `${db}/pages/${stem}.md`;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${db}/inbox/${stamp}-${stem}.md`;
}

function defaultCompiledPath(db: string, sourcePath: string, title: string): string {
  if (sourcePath.startsWith(`${db}/pages/`)) {
    return sourcePath;
  }
  return `${db}/pages/${slugify(title || basename(sourcePath)).slice(0, 64) || "note"}.md`;
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function renderDbIndex(_db: string, title: string, description?: string, pages?: string[]): string {
  const cleanPages = dedupeKeepOrder((pages ?? []).map((page) => page.trim()).filter(Boolean));
  const parts = [`# ${title}`];
  if (description) {
    parts.push(description.trim());
  }
  parts.push("## Pages");
  parts.push(cleanPages.length === 0 ? "- _No pages yet._" : cleanPages.map((page) => `- ${page}`).join("\n"));
  return `${parts.join("\n\n")}\n`;
}

function mergeDbIndexPages(markdown: string, pageEntries: string[]): string {
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

function normalizeQueryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).map((term) => term.trim()).filter(Boolean);
}

function scoreMatch(path: string, doc: KnowledgeDoc, markdown: string, terms: string[]): number {
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

function buildSnippet(markdown: string, title: string, query: string): string {
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

function compactExcerpt(doc: KnowledgeDoc, maxBytes: number): string {
  const parts: string[] = [];
  if (doc.summary.length > 0) parts.push(doc.summary.join(" "));
  if (doc.facts.length > 0) parts.push(...doc.facts.map((fact) => `- ${fact}`));
  if (doc.preferences.length > 0) parts.push(...doc.preferences.map((pref) => `- ${pref}`));
  if (parts.length === 0) parts.push("- No structured summary available.");

  let excerpt = parts.join("\n").trim();
  while (encoder.encode(excerpt).length > maxBytes && excerpt.length > 32) {
    excerpt = `${excerpt.slice(0, Math.max(32, Math.floor(excerpt.length * 0.8))).trim()}...`;
  }
  return excerpt;
}

function createEmptyDoc(path: string): KnowledgeDoc {
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

function buildInboxPath(targetPath: string | undefined, sourceText: string): string {
  const slugBase = targetPath ? targetPath.split("/").pop() ?? targetPath : sourceText;
  const slug = slugify(slugBase).slice(0, 48) || "candidate";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const pageRef = targetPath ? parseDbPagePath(targetPath) : null;
  return pageRef ? `${pageRef.db}/inbox/${stamp}-${slug}.md` : `inbox/${stamp}-${slug}.md`;
}

function buildCandidateTitle(targetPath: string | undefined, sourceText: string): string {
  if (targetPath) {
    return `Candidate for ${normalizeKnowledgePath(targetPath)}`;
  }
  const sentence = sourceText.split(/\n+/)[0]?.trim() ?? "Candidate knowledge";
  return sentence.slice(0, 80) || "Candidate knowledge";
}

function extractSummaryText(markdown: string, path: string): string {
  const doc = parseKnowledgeDoc(markdown, path);
  if (doc.summary.length > 0) {
    return doc.summary.join("\n\n");
  }
  return markdown.trim();
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (!Number.isFinite(limit) || !limit || limit < 1) {
    return fallback;
  }
  return Math.min(500, Math.floor(limit));
}

function slugify(input: string): string {
  return input.toLowerCase().replace(/\.md$/i, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
