import type {
  RepoApplyOp,
  RepoReadResult,
  RepoSummary,
} from "@humansandmachines/gsv/protocol";
import type { PackageStorageBinding } from "@humansandmachines/gsv/sdk/context";
import {
  applyKnowledgePatch,
  createEmptyDoc,
  dedupeSourceRefs,
  mergeKnowledgeDocs,
  parseKnowledgeDoc,
  renderKnowledgeDoc,
} from "./knowledge-doc";
import {
  DEFAULT_LIMIT,
  DIR_MARKER,
  buildDbNotePath,
  clampLimit,
  deriveTitle,
  mergeDbIndexPages,
  normalizeDbId,
  normalizeKnowledgePath,
  renderDbIndex,
} from "./knowledge-paths";
import { buildSnippet, normalizeQueryTerms, scoreMatch } from "./knowledge-search";
import {
  WikiRepoDiscoveryCache,
  manifestFromRepoCacheEntry,
  repoCacheEntryMatchesRepo,
  type WikiCacheManifest,
} from "./wiki-cache";
import type {
  KnowledgeDbDeleteArgs,
  KnowledgeDbInitArgs,
  KnowledgeIngestArgs,
  KnowledgeListArgs,
  KnowledgeMergeArgs,
  KnowledgeReadArgs,
  KnowledgeSearchArgs,
  KnowledgeWriteArgs,
  RepoNode,
  SearchMatch,
  WikiCollection,
  WikiInfoArgs,
  WikiInfoResult,
  WikiInfoTreeEntry,
  WikiKernelClient,
} from "./knowledge-types";

export type {
  KnowledgeDbDeleteArgs,
  KnowledgeDbInitArgs,
  KnowledgeIngestArgs,
  KnowledgeListArgs,
  KnowledgeMergeArgs,
  KnowledgeReadArgs,
  KnowledgeSearchArgs,
  KnowledgeSourceRef,
  KnowledgeWriteArgs,
  WikiCollection,
  WikiInfoArgs,
  WikiInfoResult,
  WikiInfoTreeEntry,
  WikiKernelClient,
} from "./knowledge-types";

const WIKI_MANIFEST_PATH = "wiki.json";
const WIKI_MANIFEST_KIND = "gsv.wiki";
const WIKI_REPO_PREFIX = "";

export class WikiKnowledgeStore {
  private homeRepo: string | null = null;
  private collections: WikiCollection[] | null = null;
  private repoList: RepoSummary[] | null = null;
  private readonly repoCache: WikiRepoDiscoveryCache;

  constructor(
    private readonly kernel: WikiKernelClient,
    storage?: PackageStorageBinding,
  ) {
    this.repoCache = new WikiRepoDiscoveryCache(storage);
  }

  async listDbs(args: { limit?: number }) {
    const limit = clampLimit(args.limit, DEFAULT_LIMIT);
    const collections = await this.listCollections();
    return {
      dbs: collections
        .slice(0, limit)
        .map((collection) => ({
          id: collection.id,
          title: collection.title,
        })),
    };
  }

  async info(args: WikiInfoArgs): Promise<WikiInfoResult> {
    const id = normalizeDbId(args.id);
    const collection = await this.findCollection(id);
    if (!collection) {
      throw new Error(`Wiki collection '${id}' does not exist`);
    }
    return {
      id: collection.id,
      title: collection.title,
      repo: collection.repo,
      writable: collection.writable,
      tree: await this.collectInfoTree(collection),
    };
  }

  async initDb(args: KnowledgeDbInitArgs) {
    const db = normalizeDbId(args.id);
    const existing = await this.findCollection(db);
    if (existing) {
      const existingIndex = await this.readPath(existing, "index.md");
      const ops: RepoApplyOp[] = [];
      if (existingIndex.kind === "missing") {
        ops.push({
          type: "put",
          path: "index.md",
          content: renderDbIndex(db, args.title?.trim() || existing.title || deriveTitle(db), args.description?.trim(), []),
        });
      }
      if ((await this.readPath(existing, "pages")).kind === "missing") {
        ops.push({ type: "put", path: "pages/.dir", content: "" });
      }
      if (ops.length > 0) {
        await this.apply(existing, `wiki: init ${db}`, ops);
      }
      return { ok: true, id: db, created: false };
    }

    const repo = await this.createWikiRepo(db, args.title?.trim() || deriveTitle(db), args.description?.trim());
    this.collections = null;
    this.repoList = null;
    return { ok: true, id: db, created: repo.created };
  }

  async list(args: KnowledgeListArgs) {
    const prefix = normalizeKnowledgePath(args.prefix ?? "");
    const recursive = args.recursive === true;
    const limit = clampLimit(args.limit, DEFAULT_LIMIT);
    if (!prefix) {
      const collections = await this.listCollections();
      return {
        entries: collections.slice(0, limit).map((collection) => ({
          path: collection.id,
          kind: "dir" as const,
          title: collection.title,
        })),
      };
    }

    const target = await this.resolveExistingPath(prefix);
    if (!target) {
      return { entries: [] };
    }
    const node = await this.readPath(target.collection, target.path);
    if (node.kind === "missing") {
      return { entries: [] };
    }
    if (node.kind === "file") {
      return { entries: [{ path: prefix, kind: "file" as const, title: deriveTitle(prefix) }] };
    }

    const entries: Array<{ path: string; kind: "file" | "dir"; title?: string }> = [];
    const queue: Array<{ storagePath: string; relPath: string; node?: Extract<RepoNode, { kind: "tree" }> }> = [
      { storagePath: target.path, relPath: prefix, node },
    ];
    while (queue.length > 0 && entries.length < limit) {
      const current = queue.shift()!;
      const currentNode = current.node ?? await this.readPath(target.collection, current.storagePath);
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
            queue.push({ storagePath: joinPath(current.storagePath, entry.name), relPath });
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
    const target = await this.resolveExistingPath(path);
    if (!target) {
      return { path, exists: false };
    }
    const node = await this.readPath(target.collection, target.path);
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
    const target = await this.resolveWritablePath(path, { createDb: args.create !== false });
    if (!target) {
      return { ok: false, error: `Knowledge note '${path}' does not exist` };
    }
    const existing = await this.readPath(target.collection, target.path);
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

    const ops: RepoApplyOp[] = [{ type: "put", path: this.repoPath(target.collection, target.path), content: markdown }];
    const pageEntry = pageEntryForCollectionPath(target.path);
    if (pageEntry) {
      ops.push(...await this.dbIndexUpdateOps(target.collection, target.collection.id, [pageEntry]));
    }
    await this.apply(target.collection, `wiki: update ${path}`, ops);
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
    const targetStorage = await this.resolveWritablePath(targetPath, { createDb: false });
    if (!targetStorage) {
      return { ok: false, error: `Knowledge note '${targetPath}' does not exist` };
    }
    const ops: RepoApplyOp[] = [{ type: "put", path: this.repoPath(targetStorage.collection, targetStorage.path), content: renderKnowledgeDoc(merged) }];
    let removedSource = false;
    if (!args.keepSource) {
      const sourceStorage = await this.resolveExistingPath(sourcePath);
      if (sourceStorage && sourceStorage.collection.repo === targetStorage.collection.repo) {
        ops.push({ type: "delete", path: this.repoPath(sourceStorage.collection, sourceStorage.path) });
        removedSource = true;
      }
    }
    await this.apply(targetStorage.collection, `wiki: merge ${sourcePath} -> ${targetPath}`, ops);
    return { ok: true, sourcePath, targetPath, removedSource };
  }

  async ingest(args: KnowledgeIngestArgs) {
    const db = normalizeDbId(args.db);
    const collection = await this.resolveCollection(db, { create: true });
    if (!Array.isArray(args.sources) || args.sources.length === 0) {
      return { ok: false, error: "Knowledge ingest requires at least one source" };
    }
    const path = args.path
      ? normalizeKnowledgePath(args.path)
      : buildDbNotePath(db, args.title ?? args.sources[0]?.title ?? args.sources[0]?.path ?? "source");
    const target = this.pathInCollection(collection, path);
    const storedPath = `${collection.id}/${target.path}`.replace(/\/+$/g, "");
    const existing = await this.readPath(collection, target.path);
    const created = existing.kind === "missing";
    const markdown = renderKnowledgeDoc({
      frontmatter: {
        db,
        created_at: new Date().toISOString(),
      },
      title: args.title?.trim() || deriveTitle(storedPath),
      summary: args.summary?.trim() ? [args.summary.trim()] : [],
      facts: [],
      preferences: [],
      evidence: [],
      aliases: [],
      tags: [],
      links: [],
      sources: dedupeSourceRefs(args.sources),
      otherSections: [],
    });

    const ops: RepoApplyOp[] = [{ type: "put", path: this.repoPath(collection, target.path), content: markdown }];
    const pageEntry = pageEntryForCollectionPath(target.path);
    if (pageEntry) {
      ops.push(...await this.dbIndexUpdateOps(collection, collection.id, [pageEntry]));
    }
    await this.apply(collection, `wiki: ingest ${storedPath}`, ops);
    return { ok: true, db, path: storedPath, created };
  }

  async deleteDb(args: KnowledgeDbDeleteArgs) {
    const id = normalizeDbId(args.id);
    const collection = await this.findCollection(id);
    if (!collection) {
      return { ok: true, id, removed: false };
    }
    await this.apply(collection, `wiki: delete db ${id}`, [
      { type: "delete", path: WIKI_MANIFEST_PATH },
      { type: "delete", path: "index.md" },
      { type: "delete", path: "pages", recursive: true },
    ]);
    this.collections = null;
    this.repoList = null;
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
    if (!prefix) {
      const files: string[] = [];
      for (const collection of await this.listCollections()) {
        files.push(...await this.collectFilePaths(collection.id, limit - files.length));
        if (files.length >= limit) {
          break;
        }
      }
      return files.slice(0, limit);
    }

    const target = await this.resolveExistingPath(prefix);
    if (!target) {
      return [];
    }
    const root = await this.readPath(target.collection, target.path);
    if (root.kind === "missing") {
      return [];
    }
    if (root.kind === "file") {
      return [prefix];
    }

    const files: string[] = [];
    const queue: Array<{ storagePath: string; relPath: string; node?: Extract<RepoNode, { kind: "tree" }> }> = [
      { storagePath: target.path, relPath: prefix, node: root },
    ];
    while (queue.length > 0 && files.length < limit) {
      const current = queue.shift()!;
      const node = current.node ?? await this.readPath(target.collection, current.storagePath);
      if (node.kind !== "tree") {
        continue;
      }
      for (const entry of node.entries) {
        if (entry.name === DIR_MARKER) {
          continue;
        }
        const relPath = current.relPath ? `${current.relPath}/${entry.name}` : entry.name;
        if (entry.type === "tree") {
          queue.push({ storagePath: joinPath(current.storagePath, entry.name), relPath });
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

  private async collectInfoTree(collection: WikiCollection): Promise<WikiInfoTreeEntry[]> {
    const root = await this.readPath(collection, "");
    if (root.kind !== "tree") {
      return [];
    }

    const entries: WikiInfoTreeEntry[] = [];
    await this.collectInfoTreeEntries(collection, "", root, entries);
    return entries;
  }

  private async collectInfoTreeEntries(
    collection: WikiCollection,
    path: string,
    node: Extract<RepoNode, { kind: "tree" }>,
    entries: WikiInfoTreeEntry[],
  ): Promise<void> {
    for (const entry of [...node.entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === DIR_MARKER || entry.name === WIKI_MANIFEST_PATH) {
        continue;
      }

      const childPath = joinPath(path, entry.name);
      if (entry.type === "tree") {
        const before = entries.length;
        entries.push({ path: childPath, kind: "dir" });
        const childNode = await this.readPath(collection, childPath);
        if (childNode.kind === "tree") {
          await this.collectInfoTreeEntries(collection, childPath, childNode, entries);
        }
        if (entries.length === before + 1) {
          entries.splice(before, 1);
        }
        continue;
      }

      entries.push(await this.infoFileEntry(collection, childPath));
    }
  }

  private async infoFileEntry(collection: WikiCollection, path: string): Promise<WikiInfoTreeEntry> {
    if (!/\.md$/i.test(path)) {
      return { path, kind: "file" };
    }
    const node = await this.readPath(collection, path);
    if (node.kind !== "file" || node.isBinary) {
      return { path, kind: "file", title: deriveTitle(path) };
    }
    return {
      path,
      kind: "file",
      title: parseKnowledgeDoc(node.content ?? "", path).title,
    };
  }

  private async dbIndexUpdateOps(collection: WikiCollection, db: string, pageEntries: string[]): Promise<RepoApplyOp[]> {
    const path = "index.md";
    const existing = await this.readPath(collection, path);
    const current = existing.kind === "file" ? existing.content ?? "" : renderDbIndex(db, deriveTitle(db), undefined, []);
    const updated = mergeDbIndexPages(current, pageEntries);
    return updated === current ? [] : [{ type: "put", path: this.repoPath(collection, path), content: updated }];
  }

  private async readPath(collection: WikiCollection, path: string): Promise<RepoNode> {
    try {
      const result = await this.kernel.request<RepoReadResult>("repo.read", {
        repo: collection.repo,
        path: this.repoPath(collection, path),
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

  private async apply(collection: WikiCollection, message: string, ops: RepoApplyOp[]): Promise<void> {
    await this.kernel.request("repo.apply", {
      repo: collection.repo,
      message,
      ops,
    });
  }

  private async listCollections(): Promise<WikiCollection[]> {
    if (this.collections) {
      return this.collections;
    }

    const repos = await this.listRepos();
    const collections: WikiCollection[] = [];
    const cached = await this.readRepoCache();

    for (const repo of repos) {
      const cachedEntry = cached?.get(repo.repo);
      const manifest = cachedEntry && repoCacheEntryMatchesRepo(cachedEntry, repo)
        ? manifestFromRepoCacheEntry(cachedEntry)
        : await this.probeWikiManifest(repo);
      if (!manifest) {
        continue;
      }
      const id = normalizeDbId(manifest.id || repo.name);
      collections.push({
        id,
        title: manifest.title || deriveTitle(id),
        repo: repo.repo,
        prefix: WIKI_REPO_PREFIX,
        writable: repo.writable,
      });
    }

    this.collections = collections.sort((left, right) => {
      const leftLabel = left.title || left.id;
      const rightLabel = right.title || right.id;
      return leftLabel.localeCompare(rightLabel) || left.id.localeCompare(right.id);
    });
    return this.collections;
  }

  private async probeWikiManifest(repo: RepoSummary): Promise<WikiCacheManifest | null> {
    const manifest = await this.readWikiManifest(repo.repo);
    await this.repoCache.write(repo, manifest);
    return manifest;
  }

  private async findCollection(id: string): Promise<WikiCollection | null> {
    const normalized = normalizeDbId(id);
    return (await this.listCollections()).find((collection) => collection.id === normalized) ?? null;
  }

  private async resolveCollection(id: string, options: { create: boolean }): Promise<WikiCollection> {
    const existing = await this.findCollection(id);
    if (existing) {
      return existing;
    }
    if (!options.create) {
      throw new Error(`Wiki collection '${id}' does not exist`);
    }
    await this.initDb({ id });
    const created = await this.findCollection(id);
    if (!created) {
      throw new Error(`Failed to create wiki collection '${id}'`);
    }
    return created;
  }

  private async resolveExistingPath(path: string): Promise<{ collection: WikiCollection; path: string } | null> {
    const normalized = normalizeKnowledgePath(path);
    if (!normalized) {
      return null;
    }
    const [db] = normalized.split("/", 1);
    if (!db) {
      return null;
    }
    const collection = await this.findCollection(db);
    return collection ? this.pathInCollection(collection, normalized) : null;
  }

  private async resolveWritablePath(
    path: string,
    options: { createDb: boolean },
  ): Promise<{ collection: WikiCollection; path: string } | null> {
    const normalized = normalizeKnowledgePath(path);
    const [db] = normalized.split("/", 1);
    if (!db) {
      return null;
    }
    const collection = options.createDb
      ? await this.resolveCollection(db, { create: true })
      : await this.findCollection(db);
    if (!collection) {
      return null;
    }
    return this.pathInCollection(collection, normalized);
  }

  private pathInCollection(collection: WikiCollection, externalPath: string): { collection: WikiCollection; path: string } {
    const normalized = normalizeKnowledgePath(externalPath);
    const prefix = `${collection.id}/`;
    if (normalized === collection.id) {
      return { collection, path: "" };
    }
    const localPath = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
    return { collection, path: localPath };
  }

  private repoPath(collection: WikiCollection, path: string): string {
    const normalized = normalizeKnowledgePath(path);
    return joinPath(collection.prefix, normalized);
  }

  private async createWikiRepo(db: string, title: string, description?: string) {
    if (db.includes("/")) {
      throw new Error("Wiki collection id must not contain '/'");
    }
    const owner = (await this.getHomeRepo()).split("/")[0];
    if (!owner) {
      throw new Error("Home repository owner is not available");
    }
    const repo = `${owner}/${db}`;
    const created = await this.kernel.request<{ created: boolean }>("repo.create", {
      repo,
      description: description || `Wiki: ${title}`,
    });
    const collection: WikiCollection = {
      id: db,
      title,
      repo,
      prefix: WIKI_REPO_PREFIX,
      writable: true,
    };
    const existingIndex = await this.readPath(collection, "index.md");
    const ops: RepoApplyOp[] = [
      {
        type: "put",
        path: WIKI_MANIFEST_PATH,
        content: JSON.stringify({
          kind: WIKI_MANIFEST_KIND,
          version: 1,
          id: db,
          title,
        }, null, 2) + "\n",
      },
    ];
    if (existingIndex.kind === "missing") {
      ops.push({ type: "put", path: "index.md", content: renderDbIndex(db, title, description, []) });
    }
    if ((await this.readPath(collection, "pages")).kind === "missing") {
      ops.push({ type: "put", path: "pages/.dir", content: "" });
    }
    await this.apply(collection, `wiki: init ${db}`, ops);
    return created;
  }

  private async readWikiManifest(repo: string): Promise<WikiCacheManifest | null> {
    const manifest = await this.readRawPath(repo, WIKI_MANIFEST_PATH);
    if (manifest.kind !== "file" || !manifest.content) {
      return null;
    }
    try {
      const parsed = JSON.parse(manifest.content) as Record<string, unknown>;
      if (parsed.kind !== WIKI_MANIFEST_KIND) {
        return null;
      }
      return {
        id: typeof parsed.id === "string" ? parsed.id.trim() : undefined,
        title: typeof parsed.title === "string" ? parsed.title.trim() : undefined,
      };
    } catch {
      return null;
    }
  }

  private async readRepoCache() {
    return this.repoCache.readAll();
  }

  private async readRawPath(repo: string, path: string): Promise<RepoNode> {
    try {
      const result = await this.kernel.request<RepoReadResult>("repo.read", {
        repo,
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

  private async listRepos(): Promise<RepoSummary[]> {
    if (this.repoList) {
      return this.repoList;
    }
    const result = await this.kernel.request<{ repos: RepoSummary[] }>("repo.list", {});
    this.repoList = result.repos;
    return this.repoList;
  }

  private async getHomeRepo(): Promise<string> {
    if (this.homeRepo) {
      return this.homeRepo;
    }
    const repos = await this.listRepos();
    const home = repos.find((repo) => repo.kind === "home");
    if (!home) {
      throw new Error("Home repository is not available");
    }
    this.homeRepo = home.repo;
    return home.repo;
  }
}

function pageEntryForCollectionPath(path: string): string | null {
  const normalized = normalizeKnowledgePath(path);
  const parts = normalized.split("/");
  if (parts.length < 2 || parts[0] !== "pages" || parts[parts.length - 1] === DIR_MARKER) {
    return null;
  }
  return normalized;
}

function joinPath(left: string, right: string): string {
  return [left, right]
    .map((part) => normalizeKnowledgePath(part))
    .filter(Boolean)
    .join("/");
}
