import type {
  RepoApplyOp,
  RepoReadResult,
  RepoSummary,
} from "@gsv/protocol/syscalls/repositories";
import {
  applyKnowledgePatch,
  createEmptyDoc,
  dedupeSourceRefs,
  extractSummaryText,
  mergeKnowledgeDocs,
  parseKnowledgeDoc,
  renderKnowledgeDoc,
} from "./knowledge-doc";
import {
  DEFAULT_LIMIT,
  DIR_MARKER,
  KNOWLEDGE_ROOT,
  basename,
  buildCandidateTitle,
  buildDbNotePath,
  buildInboxPath,
  clampLimit,
  defaultCompiledPath,
  deriveDbTitleFromIndex,
  deriveTitle,
  mergeDbIndexPages,
  normalizeDbId,
  normalizeKnowledgePath,
  parseDbPagePath,
  renderDbIndex,
  toRepoPath,
} from "./knowledge-paths";
import { buildSnippet, normalizeQueryTerms, scoreMatch } from "./knowledge-search";
import type {
  KnowledgeCompileArgs,
  KnowledgeDbDeleteArgs,
  KnowledgeDbInitArgs,
  KnowledgeDoc,
  KnowledgeIngestArgs,
  KnowledgeListArgs,
  KnowledgeMergeArgs,
  KnowledgePromoteArgs,
  KnowledgeReadArgs,
  KnowledgeSearchArgs,
  KnowledgeWriteArgs,
  RepoNode,
  SearchMatch,
  WikiKernelClient,
} from "./knowledge-types";

export type {
  KnowledgeCompileArgs,
  KnowledgeDbDeleteArgs,
  KnowledgeDbInitArgs,
  KnowledgeIngestArgs,
  KnowledgeListArgs,
  KnowledgeMergeArgs,
  KnowledgePromoteArgs,
  KnowledgeReadArgs,
  KnowledgeSearchArgs,
  KnowledgeSourceRef,
  KnowledgeWriteArgs,
  WikiKernelClient,
} from "./knowledge-types";

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
