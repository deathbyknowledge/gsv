import {
  RipgitClient,
  type RipgitApplyOp,
  type RipgitPathResult,
  type RipgitRepoRef,
} from "../fs/ripgit/client";
import { homeKnowledgeRepoRef } from "../fs/ripgit/repos";
import type {
  KnowledgeCompileArgs,
  KnowledgeCompileResult,
  KnowledgeDbInitArgs,
  KnowledgeDbInitResult,
  KnowledgeDbListArgs,
  KnowledgeDbListResult,
  KnowledgeIngestArgs,
  KnowledgeIngestResult,
  KnowledgeListArgs,
  KnowledgeListResult,
  KnowledgeMergeArgs,
  KnowledgeMergeResult,
  KnowledgePromoteArgs,
  KnowledgePromoteResult,
  KnowledgeQueryArgs,
  KnowledgeQueryResult,
  KnowledgeReadArgs,
  KnowledgeReadResult,
  KnowledgeSearchArgs,
  KnowledgeSearchResult,
  KnowledgeSourceRef,
  KnowledgeWriteArgs,
  KnowledgeWriteResult,
} from "../syscalls/knowledge";
import type { KernelContext } from "./context";

type KnowledgeRepoClient = Pick<RipgitClient, "readPath" | "apply">;

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

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const KNOWLEDGE_ROOT = "knowledge";
const DIR_MARKER = ".dir";
const DEFAULT_LIMIT = 100;
const DEFAULT_QUERY_LIMIT = 5;
const DEFAULT_QUERY_MAX_BYTES = 4_096;

export class KnowledgeStore {
  constructor(
    private readonly client: KnowledgeRepoClient,
    private readonly repo: RipgitRepoRef,
    private readonly author: string,
    private readonly email: string,
  ) {}

  async listDbs(args: KnowledgeDbListArgs): Promise<KnowledgeDbListResult> {
    const limit = clampLimit(args.limit, DEFAULT_LIMIT);
    const root = await this.client.readPath(this.repo, KNOWLEDGE_ROOT);
    if (root.kind !== "tree") {
      return { dbs: [] };
    }

    const dbs: KnowledgeDbListResult["dbs"] = [];
    for (const entry of [...root.entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.type !== "tree" || entry.name === "inbox" || entry.name === DIR_MARKER) {
        continue;
      }
      const dbId = entry.name;
      const indexNode = await this.client.readPath(this.repo, `${KNOWLEDGE_ROOT}/${dbId}/index.md`);
      if (indexNode.kind !== "file") {
        continue;
      }
      const title = deriveDbTitleFromIndex(decodeBytes(indexNode.bytes), dbId);
      dbs.push({ id: dbId, title });
      if (dbs.length >= limit) {
        break;
      }
    }

    return { dbs };
  }

  async initDb(args: KnowledgeDbInitArgs): Promise<KnowledgeDbInitResult> {
    const db = normalizeDbId(args.id);
    const existingIndex = await this.client.readPath(this.repo, `${KNOWLEDGE_ROOT}/${db}/index.md`);
    const created = existingIndex.kind === "missing";

    const ops: RipgitApplyOp[] = [];
    const title = args.title?.trim() || deriveTitle(db);
    const description = args.description?.trim();

    if (existingIndex.kind === "missing") {
      ops.push({
        type: "put",
        path: `${KNOWLEDGE_ROOT}/${db}/index.md`,
        contentBytes: [...encodeText(renderDbIndex(db, title, description, []))],
      });
    }

    const pagesDir = await this.client.readPath(this.repo, `${KNOWLEDGE_ROOT}/${db}/pages`);
    if (pagesDir.kind === "missing") {
      ops.push({
        type: "put",
        path: `${KNOWLEDGE_ROOT}/${db}/pages/.dir`,
        contentBytes: [],
      });
    }

    const inboxDir = await this.client.readPath(this.repo, `${KNOWLEDGE_ROOT}/${db}/inbox`);
    if (inboxDir.kind === "missing") {
      ops.push({
        type: "put",
        path: `${KNOWLEDGE_ROOT}/${db}/inbox/.dir`,
        contentBytes: [],
      });
    }

    if (ops.length > 0) {
      await this.apply(`gsv: init knowledge db ${db}`, ops);
    }

    return {
      ok: true,
      id: db,
      created,
    };
  }

  async list(args: KnowledgeListArgs): Promise<KnowledgeListResult> {
    const prefix = normalizeKnowledgePath(args.prefix ?? "");
    const recursive = args.recursive ?? false;
    const limit = clampLimit(args.limit, DEFAULT_LIMIT);
    const entries = await this.collectListEntries(prefix, recursive, limit);
    return { entries };
  }

  async read(args: KnowledgeReadArgs): Promise<KnowledgeReadResult> {
    const path = normalizeKnowledgePath(args.path);
    const node = await this.client.readPath(this.repo, toRepoPath(path));
    if (node.kind === "missing") {
      return {
        path,
        exists: false,
      };
    }
    if (node.kind !== "file") {
      throw new Error(`Knowledge path '${path}' is not a file`);
    }

    const markdown = decodeBytes(node.bytes);
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

  async write(args: KnowledgeWriteArgs): Promise<KnowledgeWriteResult> {
    const path = normalizeKnowledgePath(args.path);
    const pageRef = parseDbPagePath(path);
    if (pageRef) {
      const init = await this.initDb({ id: pageRef.db });
      if (!init.ok) {
        return { ok: false, error: init.error };
      }
    }
    const repoPath = toRepoPath(path);
    const existing = await this.client.readPath(this.repo, repoPath);
    const existingMarkdown = existing.kind === "file" ? decodeBytes(existing.bytes) : null;
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
      const base = existingMarkdown ? parseKnowledgeDoc(existingMarkdown, path) : createEmptyDoc(path);
      markdown = renderKnowledgeDoc(applyKnowledgePatch(base, args.patch, mode));
    } else {
      return { ok: false, error: "Knowledge write requires markdown or patch" };
    }

    const ops: RipgitApplyOp[] = [
      {
        type: "put",
        path: repoPath,
        contentBytes: [...encodeText(markdown)],
      },
    ];
    if (pageRef) {
      ops.push(...(await this.buildDbIndexUpdateOps(pageRef.db, [pageRef.pageEntry])));
    }
    await this.apply(`gsv: update knowledge ${path}`, ops);

    return {
      ok: true,
      path,
      created,
      updated: !created,
    };
  }

  async search(args: KnowledgeSearchArgs): Promise<KnowledgeSearchResult> {
    const prefix = normalizeKnowledgePath(args.prefix ?? "");
    const limit = clampLimit(args.limit, DEFAULT_LIMIT);
    const matches = await this.collectSearchMatches(args.query, prefix, limit);
    return { matches };
  }

  async merge(args: KnowledgeMergeArgs): Promise<KnowledgeMergeResult> {
    const sourcePath = normalizeKnowledgePath(args.sourcePath);
    const targetPath = normalizeKnowledgePath(args.targetPath);
    if (sourcePath === targetPath) {
      return { ok: false, error: "Source and target must differ" };
    }

    const [sourceNode, targetNode] = await Promise.all([
      this.client.readPath(this.repo, toRepoPath(sourcePath)),
      this.client.readPath(this.repo, toRepoPath(targetPath)),
    ]);

    if (sourceNode.kind !== "file") {
      return { ok: false, error: `Knowledge note '${sourcePath}' does not exist` };
    }
    if (targetNode.kind !== "file") {
      return { ok: false, error: `Knowledge note '${targetPath}' does not exist` };
    }

    const sourceDoc = parseKnowledgeDoc(decodeBytes(sourceNode.bytes), sourcePath);
    const targetDoc = parseKnowledgeDoc(decodeBytes(targetNode.bytes), targetPath);
    const merged = mergeKnowledgeDocs(sourceDoc, targetDoc, args.mode ?? "union");

    const ops: RipgitApplyOp[] = [
      {
        type: "put",
        path: toRepoPath(targetPath),
        contentBytes: [...encodeText(renderKnowledgeDoc(merged))],
      },
    ];
    if (!args.keepSource) {
      ops.push({
        type: "delete",
        path: toRepoPath(sourcePath),
      });
    }

    await this.apply(`gsv: merge knowledge ${sourcePath} -> ${targetPath}`, ops);
    return {
      ok: true,
      sourcePath,
      targetPath,
      removedSource: !args.keepSource,
    };
  }

  async promote(args: KnowledgePromoteArgs): Promise<KnowledgePromoteResult> {
    const mode = args.mode ?? (args.targetPath ? "direct" : "inbox");
    const now = new Date().toISOString();

    if (args.source.kind === "candidate") {
      const sourcePath = normalizeKnowledgePath(args.source.path);
      if (mode === "inbox") {
        return {
          ok: true,
          path: sourcePath,
          created: false,
          requiresReview: true,
        };
      }
      if (!args.targetPath) {
        return { ok: false, error: "Direct promotion requires a targetPath" };
      }

      const candidate = await this.read({ path: sourcePath });
      if (!candidate.exists || !candidate.markdown) {
        return { ok: false, error: `Candidate note '${sourcePath}' does not exist` };
      }

      const directResult = await this.write({
        path: normalizeKnowledgePath(args.targetPath),
        mode: "append",
        patch: {
          summary: extractSummaryText(candidate.markdown, sourcePath),
          addEvidence: [`Promoted from candidate ${sourcePath} on ${now}`],
        },
        create: true,
      });
      if (!directResult.ok) {
        return directResult;
      }

      return {
        ok: true,
        path: directResult.path,
        created: directResult.created,
        requiresReview: false,
      };
    }

    if (args.source.kind === "process") {
      return {
        ok: false,
        error: "Process promotion is not wired yet; use direct text promotion or a candidate note first",
      };
    }

    const sourceText = args.source.text.trim();
    if (!sourceText) {
      return { ok: false, error: "Promotion source text cannot be empty" };
    }

    if (mode === "direct") {
      if (!args.targetPath) {
        return { ok: false, error: "Direct promotion requires a targetPath" };
      }
      const directResult = await this.write({
        path: normalizeKnowledgePath(args.targetPath),
        mode: "append",
        patch: {
          summary: sourceText,
          addEvidence: [`Promoted from text on ${now}`],
        },
        create: true,
      });
      if (!directResult.ok) {
        return directResult;
      }
      return {
        ok: true,
        path: directResult.path,
        created: directResult.created,
        requiresReview: false,
      };
    }

    const candidatePath = buildInboxPath(args.targetPath, sourceText);
    const candidateMarkdown = renderKnowledgeDoc({
      frontmatter: {
        proposed_target: args.targetPath ? normalizeKnowledgePath(args.targetPath) : undefined,
        created_at: now,
      },
      title: buildCandidateTitle(args.targetPath, sourceText),
      summary: [sourceText],
      facts: [],
      preferences: [],
      evidence: [
        `Promoted from text on ${now}`,
        ...(args.targetPath ? [`Suggested target: ${normalizeKnowledgePath(args.targetPath)}`] : []),
      ],
      aliases: [],
      tags: ["candidate"],
      links: [],
      sources: [],
      otherSections: [],
    });

    await this.apply(`gsv: promote knowledge candidate ${candidatePath}`, [
      {
        type: "put",
        path: toRepoPath(candidatePath),
        contentBytes: [...encodeText(candidateMarkdown)],
      },
    ]);

    return {
      ok: true,
      path: candidatePath,
      created: true,
      requiresReview: true,
    };
  }

  async query(args: KnowledgeQueryArgs): Promise<KnowledgeQueryResult> {
    const limit = clampLimit(args.limit, DEFAULT_QUERY_LIMIT);
    const maxBytes = Math.max(256, args.maxBytes ?? DEFAULT_QUERY_MAX_BYTES);
    const prefixes = (args.prefixes ?? []).map((prefix) => normalizeKnowledgePath(prefix));
    const searchPrefixes = prefixes.length > 0 ? prefixes : [""];

    const collected: SearchMatch[] = [];
    for (const prefix of searchPrefixes) {
      const matches = await this.collectSearchMatches(args.query, prefix, limit);
      for (const match of matches) {
        if (!collected.some((existing) => existing.path === match.path)) {
          collected.push(match);
        }
      }
    }
    collected.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const topMatches = collected.slice(0, limit);

    const refs = topMatches.map((match) => ({ path: match.path, title: match.title }));
    let remaining = maxBytes;
    const lines: string[] = ["## Relevant knowledge"];

    for (const match of topMatches) {
      if (remaining <= 0) break;
      const node = await this.client.readPath(this.repo, toRepoPath(match.path));
      if (node.kind !== "file") continue;
      const markdown = decodeBytes(node.bytes);
      const doc = parseKnowledgeDoc(markdown, match.path);
      const excerpt = compactExcerpt(doc, remaining);
      if (!excerpt) continue;
      const heading = `### ${doc.title} (${match.path})`;
      lines.push(heading, excerpt);
      remaining -= encoder.encode(`${heading}\n${excerpt}\n`).length;
    }

    if (lines.length === 1) {
      lines.push("- No relevant knowledge found.");
    }

    return {
      brief: `${lines.join("\n\n")}\n`,
      refs,
    };
  }

  async ingest(args: KnowledgeIngestArgs): Promise<KnowledgeIngestResult> {
    const db = normalizeDbId(args.db);
    const initResult = await this.initDb({ id: db });
    if (!initResult.ok) {
      return { ok: false, error: initResult.error };
    }
    if (args.sources.length === 0) {
      return { ok: false, error: "Knowledge ingest requires at least one source" };
    }

    const mode = args.mode ?? "inbox";
    const path = args.path
      ? normalizeKnowledgePath(args.path)
      : buildDbNotePath(db, mode, args.title ?? args.sources[0]?.title ?? "source");
    const existing = await this.client.readPath(this.repo, toRepoPath(path));
    const created = existing.kind === "missing";

    const doc: KnowledgeDoc = {
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
    };

    const ops: RipgitApplyOp[] = [
      {
        type: "put",
        path: toRepoPath(path),
        contentBytes: [...encodeText(renderKnowledgeDoc(doc))],
      },
    ];
    if (mode === "page") {
      const pageRef = parseDbPagePath(path);
      const indexOps = await this.buildDbIndexUpdateOps(
        db,
        pageRef ? [pageRef.pageEntry] : [`pages/${basename(path)}`],
      );
      ops.push(...indexOps);
    }

    await this.apply(`gsv: ingest knowledge ${path}`, ops);
    return {
      ok: true,
      db,
      path,
      created,
      requiresReview: mode !== "page",
    };
  }

  async compile(args: KnowledgeCompileArgs): Promise<KnowledgeCompileResult> {
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
    const removedSource = !args.keepSource && sourcePath !== targetPath;
    const compiledDoc: KnowledgeDoc = {
      ...sourceDoc,
      frontmatter: {
        ...sourceDoc.frontmatter,
        db,
        compiled_at: new Date().toISOString(),
      },
      title: args.title?.trim() || sourceDoc.title,
      tags: sourcePath.includes("/inbox/") ? sourceDoc.tags.filter((tag) => tag.toLowerCase() !== "candidate") : sourceDoc.tags,
    };

    const ops: RipgitApplyOp[] = [
      {
        type: "put",
        path: toRepoPath(targetPath),
        contentBytes: [...encodeText(renderKnowledgeDoc(compiledDoc))],
      },
    ];
    if (removedSource) {
      ops.push({
        type: "delete",
        path: toRepoPath(sourcePath),
      });
    }
    const pageRef = parseDbPagePath(targetPath);
    ops.push(...(await this.buildDbIndexUpdateOps(
      db,
      pageRef ? [pageRef.pageEntry] : [`pages/${basename(targetPath)}`],
    )));

    await this.apply(`gsv: compile knowledge ${sourcePath}`, ops);
    return {
      ok: true,
      db,
      path: targetPath,
      sourcePath,
      removedSource,
    };
  }

  private async collectListEntries(
    prefix: string,
    recursive: boolean,
    limit: number,
  ): Promise<KnowledgeListResult["entries"]> {
    const root = toRepoPath(prefix);
    const rootNode = await this.client.readPath(this.repo, root);
    if (rootNode.kind === "missing") {
      return [];
    }
    if (rootNode.kind === "file") {
      return [{ path: prefix, kind: "file", title: deriveTitle(prefix) }];
    }

    const results: KnowledgeListResult["entries"] = [];
    const queue: Array<{ repoPath: string; relPath: string }> = [{ repoPath: root, relPath: prefix }];

    while (queue.length > 0 && results.length < limit) {
      const current = queue.shift()!;
      const node =
        current.repoPath === root ? rootNode : await this.client.readPath(this.repo, current.repoPath);
      if (node.kind !== "tree") continue;

      const entries = [...node.entries].sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name === DIR_MARKER) continue;
        const relPath = current.relPath ? `${current.relPath}/${entry.name}` : entry.name;
        if (entry.type === "tree") {
          results.push({ path: relPath, kind: "dir" });
          if (recursive && results.length < limit) {
            queue.push({ repoPath: `${current.repoPath}/${entry.name}`, relPath });
          }
        } else {
          results.push({ path: relPath, kind: "file", title: deriveTitle(relPath) });
        }
        if (results.length >= limit) break;
      }
    }

    return results;
  }

  private async collectSearchMatches(
    query: string,
    prefix: string,
    limit: number,
  ): Promise<SearchMatch[]> {
    const terms = normalizeQueryTerms(query);
    if (terms.length === 0) {
      return [];
    }

    const files = await this.collectFilePaths(prefix, Math.max(limit * 5, limit));
    const matches: SearchMatch[] = [];

    for (const path of files) {
      const node = await this.client.readPath(this.repo, toRepoPath(path));
      if (node.kind !== "file") continue;
      const markdown = decodeBytes(node.bytes);
      const doc = parseKnowledgeDoc(markdown, path);
      const score = scoreMatch(path, doc, markdown, terms);
      if (score <= 0) continue;
      matches.push({
        path,
        title: doc.title,
        snippet: buildSnippet(markdown, doc.title, query),
        score,
      });
    }

    matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return matches.slice(0, limit);
  }

  private async collectFilePaths(prefix: string, limit: number): Promise<string[]> {
    const root = toRepoPath(prefix);
    const rootNode = await this.client.readPath(this.repo, root);
    if (rootNode.kind === "missing") {
      return [];
    }
    if (rootNode.kind === "file") {
      return [prefix];
    }

    const files: string[] = [];
    const queue: Array<{ repoPath: string; relPath: string; node?: RipgitPathResult }> = [
      { repoPath: root, relPath: prefix, node: rootNode },
    ];
    while (queue.length > 0 && files.length < limit) {
      const current = queue.shift()!;
      const node = current.node ?? (await this.client.readPath(this.repo, current.repoPath));
      if (node.kind !== "tree") continue;

      for (const entry of node.entries) {
        if (entry.name === DIR_MARKER) continue;
        const relPath = current.relPath ? `${current.relPath}/${entry.name}` : entry.name;
        if (entry.type === "tree") {
          queue.push({ repoPath: `${current.repoPath}/${entry.name}`, relPath });
        } else {
          files.push(relPath);
        }
        if (files.length >= limit) break;
      }
    }
    return files;
  }

  private async buildDbIndexUpdateOps(db: string, pageEntries: string[]): Promise<RipgitApplyOp[]> {
    const path = `${KNOWLEDGE_ROOT}/${db}/index.md`;
    const existing = await this.client.readPath(this.repo, path);
    const current = existing.kind === "file" ? decodeBytes(existing.bytes) : renderDbIndex(db, deriveTitle(db), undefined, []);
    const updated = mergeDbIndexPages(current, pageEntries);
    if (updated === current) {
      return [];
    }
    return [{
      type: "put",
      path,
      contentBytes: [...encodeText(updated)],
    }];
  }

  private async apply(message: string, ops: RipgitApplyOp[]): Promise<void> {
    await this.client.apply(this.repo, this.author, this.email, message, ops);
  }
}

export async function handleKnowledgeList(
  ctx: KernelContext,
  args: KnowledgeListArgs,
): Promise<KnowledgeListResult> {
  return createKnowledgeStore(ctx).list(args);
}

export async function handleKnowledgeDbList(
  ctx: KernelContext,
  args: KnowledgeDbListArgs,
): Promise<KnowledgeDbListResult> {
  return createKnowledgeStore(ctx).listDbs(args);
}

export async function handleKnowledgeDbInit(
  ctx: KernelContext,
  args: KnowledgeDbInitArgs,
): Promise<KnowledgeDbInitResult> {
  return createKnowledgeStore(ctx).initDb(args);
}

export async function handleKnowledgeRead(
  ctx: KernelContext,
  args: KnowledgeReadArgs,
): Promise<KnowledgeReadResult> {
  return createKnowledgeStore(ctx).read(args);
}

export async function handleKnowledgeWrite(
  ctx: KernelContext,
  args: KnowledgeWriteArgs,
): Promise<KnowledgeWriteResult> {
  return createKnowledgeStore(ctx).write(args);
}

export async function handleKnowledgeSearch(
  ctx: KernelContext,
  args: KnowledgeSearchArgs,
): Promise<KnowledgeSearchResult> {
  return createKnowledgeStore(ctx).search(args);
}

export async function handleKnowledgeMerge(
  ctx: KernelContext,
  args: KnowledgeMergeArgs,
): Promise<KnowledgeMergeResult> {
  return createKnowledgeStore(ctx).merge(args);
}

export async function handleKnowledgePromote(
  ctx: KernelContext,
  args: KnowledgePromoteArgs,
): Promise<KnowledgePromoteResult> {
  return createKnowledgeStore(ctx).promote(args);
}

export async function handleKnowledgeQuery(
  ctx: KernelContext,
  args: KnowledgeQueryArgs,
): Promise<KnowledgeQueryResult> {
  return createKnowledgeStore(ctx).query(args);
}

export async function handleKnowledgeIngest(
  ctx: KernelContext,
  args: KnowledgeIngestArgs,
): Promise<KnowledgeIngestResult> {
  return createKnowledgeStore(ctx).ingest(args);
}

export async function handleKnowledgeCompile(
  ctx: KernelContext,
  args: KnowledgeCompileArgs,
): Promise<KnowledgeCompileResult> {
  return createKnowledgeStore(ctx).compile(args);
}

function createKnowledgeStore(ctx: KernelContext): KnowledgeStore {
  if (!ctx.env.RIPGIT) {
    throw new Error("RIPGIT binding is required for knowledge operations");
  }
  const identity = ctx.identity?.process;
  if (!identity) {
    throw new Error("Knowledge operations require a process identity");
  }
  const username = identity.username || `uid-${identity.uid}`;
  return new KnowledgeStore(
    new RipgitClient(ctx.env.RIPGIT),
    homeKnowledgeRepoRef(identity.uid),
    username,
    `${username}@gsv.local`,
  );
}

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

function toRepoPath(relPath: string): string {
  return relPath ? `${KNOWLEDGE_ROOT}/${relPath}` : KNOWLEDGE_ROOT;
}

function parseKnowledgeDoc(markdown: string, path: string): KnowledgeDoc {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const lines = body.replace(/\r\n/g, "\n").split("\n");

  let title =
    typeof frontmatter.title === "string" && frontmatter.title.trim()
      ? String(frontmatter.title).trim()
      : "";
  let index = 0;
  while (index < lines.length && lines[index].trim() === "") index += 1;
  if (!title && index < lines.length && lines[index].startsWith("# ")) {
    title = lines[index].slice(2).trim();
    index += 1;
  }
  if (!title) {
    title = deriveTitle(path);
  }

  const preamble: string[] = [];
  const sections: Array<{ heading: string; lines: string[] }> = [];
  let currentSection: { heading: string; lines: string[] } | null = null;

  for (; index < lines.length; index += 1) {
    const line = lines[index];
    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      currentSection = { heading: headingMatch[1].trim(), lines: [] };
      sections.push(currentSection);
      continue;
    }
    if (currentSection) {
      currentSection.lines.push(line);
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
    if (key === "summary") {
      doc.summary = compactParagraphs(section.lines);
      continue;
    }
    if (key === "facts") {
      doc.facts = parseBulletSection(section.lines);
      continue;
    }
    if (key === "preferences") {
      doc.preferences = parseBulletSection(section.lines);
      continue;
    }
    if (key === "evidence") {
      doc.evidence = parseBulletSection(section.lines);
      continue;
    }
    if (key === "aliases") {
      doc.aliases = union(doc.aliases, parseBulletSection(section.lines));
      continue;
    }
    if (key === "tags") {
      doc.tags = union(doc.tags, parseBulletSection(section.lines));
      continue;
    }
    if (key === "links") {
      doc.links = union(doc.links, parseBulletSection(section.lines));
      continue;
    }
    if (key === "sources") {
      doc.sources = dedupeSourceRefs(parseSourceSection(section.lines));
      continue;
    }
    doc.otherSections.push(section);
  }

  return doc;
}

function renderKnowledgeDoc(doc: KnowledgeDoc): string {
  const frontmatter: Record<string, unknown> = {
    ...doc.frontmatter,
    updated_at: new Date().toISOString(),
  };
  if (doc.aliases.length > 0) {
    frontmatter.aliases = doc.aliases;
  } else {
    delete frontmatter.aliases;
  }
  if (doc.tags.length > 0) {
    frontmatter.tags = doc.tags;
  } else {
    delete frontmatter.tags;
  }
  if (doc.links.length > 0) {
    frontmatter.links = doc.links;
  } else {
    delete frontmatter.links;
  }
  if (frontmatter.title === doc.title) {
    delete frontmatter.title;
  }

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
    if (!content) continue;
    parts.push(`## ${section.heading}\n${content}`);
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
    next.summary =
      mode === "append" && next.summary.length > 0
        ? union(next.summary, [patch.summary.trim()])
        : [patch.summary.trim()];
  }
  if (patch.addFacts) {
    next.facts =
      mode === "append"
        ? [...next.facts, ...sanitizeList(patch.addFacts)]
        : union(next.facts, patch.addFacts);
  }
  if (patch.addPreferences) {
    next.preferences =
      mode === "append"
        ? [...next.preferences, ...sanitizeList(patch.addPreferences)]
        : union(next.preferences, patch.addPreferences);
  }
  if (patch.addEvidence) {
    next.evidence =
      mode === "append"
        ? [...next.evidence, ...sanitizeList(patch.addEvidence)]
        : union(next.evidence, patch.addEvidence);
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
    doc.otherSections.push({
      heading,
      lines,
    });
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
        ? source.summary.length > 0
          ? source.summary
          : target.summary
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

    const arrayItem = line.match(/^\s*-\s+(.*)$/);
    if (arrayItem && currentArrayKey) {
      const existing = Array.isArray(out[currentArrayKey]) ? (out[currentArrayKey] as string[]) : [];
      out[currentArrayKey] = [...existing, arrayItem[1].trim()];
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!rawValue) {
      out[key] = [];
      currentArrayKey = key;
      continue;
    }
    currentArrayKey = null;
    out[key] = rawValue.trim().replace(/^['"]|['"]$/g, "");
  }

  return out;
}

function renderFrontmatter(frontmatter: Record<string, unknown>): string {
  const entries = Object.entries(frontmatter).filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );
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
      continue;
    }
    lines.push(`${key}: ${String(value)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

function appendBulletSection(parts: string[], heading: string, items: string[]): void {
  const clean = dedupeKeepOrder(trimAndFilter(items));
  if (clean.length === 0) {
    return;
  }
  parts.push(`## ${heading}\n${clean.map((item) => `- ${item}`).join("\n")}`);
}

function appendSourceSection(parts: string[], sources: KnowledgeSourceRef[] | undefined): void {
  const clean = dedupeSourceRefs(sources ?? []);
  if (clean.length === 0) {
    return;
  }
  parts.push(`## Sources\n${clean.map((source) => `- ${renderSourceRef(source)}`).join("\n")}`);
}

function parseBulletSection(lines: string[]): string[] {
  return dedupeKeepOrder(
    lines
      .map((line) => line.match(/^\s*[-*]\s+(.*)$/)?.[1] ?? "")
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

function parseSourceSection(lines: string[]): KnowledgeSourceRef[] {
  return lines
    .map((line) => line.match(/^\s*[-*]\s+(.*)$/)?.[1]?.trim() ?? line.trim())
    .map(parseSourceRef)
    .filter((value): value is KnowledgeSourceRef => value !== null);
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
  return dedupeKeepOrder(
    lines
      .map((line) => line.match(/^\s*[-*]\s+(.*)$/)?.[1] ?? line)
      .map((line) => line.trim())
      .filter(Boolean),
  );
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
  while (copy.length > 0 && copy[0].trim() === "") copy.shift();
  while (copy.length > 0 && copy[copy.length - 1].trim() === "") copy.pop();
  return copy;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  const copy = [...lines];
  while (copy.length > 0 && copy[copy.length - 1].trim() === "") copy.pop();
  return copy;
}

function normalizeHeading(heading: string): string {
  return heading.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function union(existing: string[], incoming: string[]): string[] {
  return dedupeKeepOrder([...trimAndFilter(existing), ...trimAndFilter(incoming)]);
}

function sanitizeList(values: string[]): string[] {
  return trimAndFilter(values);
}

function trimAndFilter(values: string[]): string[] {
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

function arrayFromFrontmatter(value: unknown): string[] {
  if (Array.isArray(value)) {
    return dedupeKeepOrder(value.map((item) => String(item).trim()).filter(Boolean));
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function parseSourceRef(value: string): KnowledgeSourceRef | null {
  const match = value.match(/^\[([^\]]+)\]\s+(.+?)(?:\s+\|\s+(.+))?$/);
  if (!match) {
    return null;
  }
  const [, target, path, title] = match;
  return {
    target: target.trim(),
    path: path.trim(),
    title: title?.trim() || undefined,
  };
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
    const title = source.title?.trim() || undefined;
    const key = `${target}\0${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ target, path, title });
  }
  return out;
}

function decodeBytes(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

function encodeText(text: string): Uint8Array {
  return encoder.encode(text);
}

function deriveTitle(path: string): string {
  const leaf = path.split("/").filter(Boolean).pop() ?? "knowledge";
  return leaf.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim() || "knowledge";
}

function normalizeDbId(input: string): string {
  const db = normalizeKnowledgePath(input);
  if (!db) {
    throw new Error("Knowledge db id cannot be empty");
  }
  return db;
}

function parseDbPagePath(path: string): { db: string; pageEntry: string } | null {
  const parts = path.split("/");
  if (parts.length < 3 || parts[1] !== "pages") {
    return null;
  }
  return {
    db: parts[0],
    pageEntry: parts.slice(1).join("/"),
  };
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

function deriveDbTitleFromIndex(markdown: string, db: string): string {
  const line = markdown.replace(/\r\n/g, "\n").split("\n").find((entry) => entry.startsWith("# "));
  return line?.slice(2).trim() || deriveTitle(db);
}

function renderDbIndex(_db: string, title: string, description?: string, pages?: string[]): string {
  const cleanPages = dedupeKeepOrder((pages ?? []).map((page) => page.trim()).filter(Boolean));
  const parts = [`# ${title}`];
  if (description) {
    parts.push(description.trim());
  }
  parts.push("## Pages");
  if (cleanPages.length === 0) {
    parts.push("- _No pages yet._");
  } else {
    parts.push(...cleanPages.map((page) => `- ${page}`));
  }
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
  const next = renderDbIndex("", title, descriptionLines.join("\n"), merged);
  return next === normalized || next === `${normalized.trimEnd()}\n` ? normalized.endsWith("\n") ? normalized : `${normalized}\n` : next;
}

function normalizeQueryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
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
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

function compactExcerpt(doc: KnowledgeDoc, maxBytes: number): string {
  const parts: string[] = [];
  if (doc.summary.length > 0) {
    parts.push(doc.summary.join(" "));
  }
  if (doc.facts.length > 0) {
    parts.push(...doc.facts.map((fact) => `- ${fact}`));
  }
  if (doc.preferences.length > 0) {
    parts.push(...doc.preferences.map((pref) => `- ${pref}`));
  }
  if (parts.length === 0) {
    parts.push("- No structured summary available.");
  }

  let excerpt = parts.join("\n").trim();
  while (encoder.encode(excerpt).length > maxBytes && excerpt.length > 32) {
    excerpt = `${excerpt.slice(0, Math.max(32, Math.floor(excerpt.length * 0.8))).trim()}…`;
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

function clampLimit(limit: number | undefined, fallback: number): number {
  if (!Number.isFinite(limit) || !limit || limit < 1) {
    return fallback;
  }
  return Math.min(500, Math.floor(limit));
}

function buildInboxPath(targetPath: string | undefined, sourceText: string): string {
  const slugBase = targetPath ? targetPath.split("/").pop() ?? targetPath : sourceText;
  const slug = slugify(slugBase).slice(0, 48) || "candidate";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `inbox/${stamp}-${slug}.md`;
}

function buildCandidateTitle(targetPath: string | undefined, sourceText: string): string {
  if (targetPath) {
    return `Candidate for ${normalizeKnowledgePath(targetPath)}`;
  }
  const sentence = sourceText.split(/\n+/)[0]?.trim() ?? "Candidate knowledge";
  return sentence.slice(0, 80) || "Candidate knowledge";
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function extractSummaryText(markdown: string, path: string): string {
  const doc = parseKnowledgeDoc(markdown, path);
  if (doc.summary.length > 0) {
    return doc.summary.join("\n\n");
  }
  return markdown.trim();
}
