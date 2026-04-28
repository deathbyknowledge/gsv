import type {
  RepoApplyArgs,
  RepoApplyResult,
  RepoCompareArgs,
  RepoCompareResult,
  RepoCreateArgs,
  RepoCreateResult,
  RepoDiffArgs,
  RepoDiffResult,
  RepoImportArgs,
  RepoImportResult,
  RepoListArgs,
  RepoListResult,
  RepoLogArgs,
  RepoLogResult,
  RepoReadArgs,
  RepoReadResult,
  RepoRefsArgs,
  RepoRefsResult,
  RepoSearchArgs,
  RepoSearchResult,
  RepoSummary,
} from "@gsv/protocol/syscalls/repositories";
import type { KernelContext } from "./context";
import { RipgitClient, type RipgitApplyOp, type RipgitRepoRef } from "../fs/ripgit/client";
import { homeKnowledgeRepoRef, workspaceRepoRef } from "../fs/ripgit/repos";
import { visiblePackageScopesForActor } from "./packages";

const TEXT_DECODER = new TextDecoder();
const STRICT_TEXT_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const TEXT_ENCODER = new TextEncoder();
const DEFAULT_REF = "main";

export function handleRepoList(
  args: RepoListArgs | undefined,
  ctx: KernelContext,
): RepoListResult {
  const identity = requireIdentity(ctx);
  const requestedOwner = typeof args?.owner === "string" && args.owner.trim().length > 0
    ? normalizeRepoOwner(args.owner)
    : null;
  const repos = new Map<string, RepoSummary>();

  const add = (summary: RepoSummary) => {
    if (requestedOwner && summary.owner !== requestedOwner) {
      return;
    }
    if (!canReadRepo(summary.repo, ctx)) {
      return;
    }
    const existing = repos.get(summary.repo);
    if (!existing) {
      repos.set(summary.repo, summary);
      return;
    }
    repos.set(summary.repo, {
      ...existing,
      writable: existing.writable || summary.writable,
      public: existing.public || summary.public,
      kind: existing.kind === "user" ? summary.kind : existing.kind,
      updatedAt: Math.max(existing.updatedAt ?? 0, summary.updatedAt ?? 0) || undefined,
    });
  };

  add(toSummary(homeKnowledgeRepoRef(identity.process.username), "home", ctx));

  const workspaceRecords = identity.process.uid === 0
    ? ctx.workspaces.list()
    : ctx.workspaces.list(identity.process.uid);
  for (const workspace of workspaceRecords) {
    add({
      ...toSummary(workspaceRepoRef(workspace.workspaceId, workspace.ownerUsername), "workspace", ctx),
      description: workspace.label ?? undefined,
      updatedAt: workspace.updatedAt,
    });
  }

  for (const record of ctx.packages.list({ scopes: visiblePackageScopesForActor(identity.process) })) {
    const repo = parseRepoSlug(record.manifest.source.repo);
    add({
      ...toSummary(repo, "package", ctx),
      description: record.manifest.name,
      updatedAt: record.updatedAt,
    });
  }

  for (const row of ctx.config.list("repos")) {
    const parsed = parseRegisteredRepoKey(row.key);
    if (!parsed || parsed.field !== "created_at") {
      continue;
    }
    const repo = { owner: parsed.owner, repo: parsed.repo };
    add({
      ...toSummary(repo, "user", ctx),
      description: ctx.config.get(repoConfigKey(repo, "description")) ?? undefined,
      updatedAt: parseOptionalNumber(ctx.config.get(repoConfigKey(repo, "updated_at"))) ?? parseOptionalNumber(row.value),
    });
  }

  return {
    repos: [...repos.values()].sort((left, right) => left.repo.localeCompare(right.repo)),
  };
}

export async function handleRepoCreate(
  args: RepoCreateArgs,
  ctx: KernelContext,
): Promise<RepoCreateResult> {
  const repo = parseRepoSlug(args.repo);
  assertCanWriteRepo(repo, ctx);
  const ref = normalizeRef(args.ref);
  const ripgit = requireRipgitClient(ctx);
  const refs = await ripgit.refs(repo);
  const currentHead = refs.heads?.[ref] ?? null;
  if (currentHead) {
    registerRepo(ctx, repo, args.description);
    return { repo: repoSlug(repo), ref, head: currentHead, created: false };
  }

  const actor = requireIdentity(ctx).process;
  const result = await ripgit.apply(
    { ...repo, branch: ref },
    actor.username,
    `${actor.username}@gsv.local`,
    `repo: create ${repoSlug(repo)}`,
    [],
    { allowEmpty: true },
  );
  registerRepo(ctx, repo, args.description);
  return { repo: repoSlug(repo), ref, head: result.head ?? null, created: true };
}

export async function handleRepoRefs(
  args: RepoRefsArgs,
  ctx: KernelContext,
): Promise<RepoRefsResult> {
  const repo = parseRepoSlug(args.repo);
  assertCanReadRepo(repo, ctx);
  const refs = await requireRipgitClient(ctx).refs(repo);
  return {
    repo: repoSlug(repo),
    heads: refs.heads ?? {},
    tags: refs.tags ?? {},
  };
}

export async function handleRepoRead(
  args: RepoReadArgs,
  ctx: KernelContext,
): Promise<RepoReadResult> {
  const repo = parseRepoSlug(args.repo);
  assertCanReadRepo(repo, ctx);
  const ref = normalizeReadRef(args.ref);
  const path = normalizeRepoPath(args.path, true);
  const result = await requireRipgitClient(ctx).readPath({ ...repo, branch: ref }, path);
  if (result.kind === "missing") {
    throw new Error(`Path not found: ${path || "/"}`);
  }
  if (result.kind === "tree") {
    return {
      repo: repoSlug(repo),
      ref,
      path,
      kind: "tree",
      entries: result.entries.map((entry) => ({
        name: entry.name,
        path: path ? `${path}/${entry.name}` : entry.name,
        mode: entry.mode,
        hash: entry.hash,
        type: entry.type,
      })),
    };
  }
  return {
    repo: repoSlug(repo),
    ref,
    path,
    kind: "file",
    size: result.size,
    isBinary: isBinaryBytes(result.bytes),
    content: decodeRepoFile(result.bytes),
  };
}

export async function handleRepoSearch(
  args: RepoSearchArgs,
  ctx: KernelContext,
): Promise<RepoSearchResult> {
  const repo = parseRepoSlug(args.repo);
  assertCanReadRepo(repo, ctx);
  const ref = normalizeReadRef(args.ref);
  const query = String(args.query ?? "").trim();
  if (!query) {
    throw new Error("query is required");
  }
  const prefix = normalizeRepoPath(args.prefix, true);
  const result = await requireRipgitClient(ctx).search(
    { ...repo, branch: ref },
    query,
    prefix || undefined,
  );
  return {
    repo: repoSlug(repo),
    ref,
    query,
    prefix: prefix || undefined,
    truncated: result.truncated,
    matches: result.matches.map((match) => ({
      path: match.path,
      line: match.line,
      content: match.content,
    })),
  };
}

export async function handleRepoLog(
  args: RepoLogArgs,
  ctx: KernelContext,
): Promise<RepoLogResult> {
  const repo = parseRepoSlug(args.repo);
  assertCanReadRepo(repo, ctx);
  const ref = normalizeReadRef(args.ref);
  const limit = clampRepoLimit(args.limit);
  const offset = clampRepoOffset(args.offset);
  const entries = await requireRipgitClient(ctx).log({ ...repo, branch: ref }, { limit, offset });
  return {
    repo: repoSlug(repo),
    ref,
    limit,
    offset,
    entries: entries.map((entry) => ({
      hash: entry.hash,
      treeHash: entry.tree_hash,
      author: entry.author,
      authorEmail: entry.author_email,
      authorTime: entry.author_time,
      committer: entry.committer,
      committerEmail: entry.committer_email,
      commitTime: entry.commit_time,
      message: entry.message,
      parents: Array.isArray(entry.parents) ? entry.parents : [],
    })),
  };
}

export async function handleRepoDiff(
  args: RepoDiffArgs,
  ctx: KernelContext,
): Promise<RepoDiffResult> {
  const repo = parseRepoSlug(args.repo);
  assertCanReadRepo(repo, ctx);
  const commit = String(args.commit ?? "").trim();
  if (!commit) {
    throw new Error("commit is required");
  }
  const diff = await requireRipgitClient(ctx).diffCommit(repo, commit, {
    context: clampContext(args.context),
  });
  return {
    repo: repoSlug(repo),
    commitHash: diff.commit_hash,
    parentHash: diff.parent_hash ?? null,
    stats: toDiffStats(diff.stats),
    files: toDiffFiles(diff.files),
  };
}

export async function handleRepoCompare(
  args: RepoCompareArgs,
  ctx: KernelContext,
): Promise<RepoCompareResult> {
  const repo = parseRepoSlug(args.repo);
  assertCanReadRepo(repo, ctx);
  const base = String(args.base ?? "").trim();
  const head = String(args.head ?? "").trim();
  if (!base || !head) {
    throw new Error("base and head are required");
  }
  const comparison = await requireRipgitClient(ctx).compare(repo, base, head, {
    context: clampContext(args.context),
    stat: args.stat === true,
  });
  return {
    repo: repoSlug(repo),
    base: comparison.base_hash,
    head: comparison.head_hash,
    stats: toDiffStats(comparison.stats),
    files: toDiffFiles(comparison.files),
  };
}

export async function handleRepoApply(
  args: RepoApplyArgs,
  ctx: KernelContext,
): Promise<RepoApplyResult> {
  const repo = parseRepoSlug(args.repo);
  assertCanWriteRepo(repo, ctx);
  const ref = normalizeRef(args.ref);
  const message = String(args.message ?? "").trim();
  if (!message) {
    throw new Error("message is required");
  }
  const ops = normalizeApplyOps(args.ops);
  const actor = requireIdentity(ctx).process;
  const result = await requireRipgitClient(ctx).apply(
    { ...repo, branch: ref },
    actor.username,
    `${actor.username}@gsv.local`,
    message,
    ops,
    {
      expectedHead: typeof args.expectedHead === "string" && args.expectedHead.trim().length > 0
        ? args.expectedHead.trim()
        : undefined,
      allowEmpty: args.allowEmpty === true,
    },
  );
  registerRepo(ctx, repo);
  return {
    ok: true,
    repo: repoSlug(repo),
    ref,
    head: result.head ?? null,
  };
}

export async function handleRepoImport(
  args: RepoImportArgs,
  ctx: KernelContext,
): Promise<RepoImportResult> {
  const repo = parseRepoSlug(args.repo);
  assertCanWriteRepo(repo, ctx);
  const ref = normalizeRef(args.ref);
  const remoteUrl = String(args.remoteUrl ?? "").trim();
  if (!remoteUrl) {
    throw new Error("remoteUrl is required");
  }
  const remoteRef = typeof args.remoteRef === "string" && args.remoteRef.trim().length > 0
    ? args.remoteRef.trim()
    : ref;
  const actor = requireIdentity(ctx).process;
  const imported = await requireRipgitClient(ctx).importFromUpstream(
    { ...repo, branch: ref },
    actor.username,
    `${actor.username}@gsv.local`,
    args.message?.trim() || `repo: import ${remoteUrl}#${remoteRef}`,
    remoteUrl,
    remoteRef,
  );
  registerRepo(ctx, repo);
  return {
    repo: repoSlug(repo),
    ref,
    head: imported.head ?? null,
    changed: imported.changed,
    remoteUrl: imported.remoteUrl,
    remoteRef: imported.remoteRef,
  };
}

function requireIdentity(ctx: KernelContext): NonNullable<KernelContext["identity"]> {
  if (!ctx.identity) {
    throw new Error("Authenticated identity required");
  }
  return ctx.identity;
}

function requireRipgitClient(ctx: KernelContext): RipgitClient {
  if (!ctx.env.RIPGIT) {
    throw new Error("RIPGIT binding is required");
  }
  return new RipgitClient(ctx.env.RIPGIT);
}

function assertCanReadRepo(repo: RipgitRepoRef, ctx: KernelContext): void {
  if (!canReadRepo(repoSlug(repo), ctx)) {
    throw new Error(`Forbidden: cannot read repo ${repoSlug(repo)}`);
  }
}

function assertCanWriteRepo(repo: RipgitRepoRef, ctx: KernelContext): void {
  if (!canWriteRepo(repoSlug(repo), ctx)) {
    throw new Error(`Forbidden: cannot write repo ${repoSlug(repo)}`);
  }
}

function canReadRepo(rawRepo: string, ctx: KernelContext): boolean {
  const repo = parseRepoSlug(rawRepo);
  if (canWriteRepo(repoSlug(repo), ctx)) {
    return true;
  }
  if (isRepoPublic(repoSlug(repo), ctx)) {
    return true;
  }
  const scopes = visiblePackageScopesForActor(ctx.identity?.process);
  return ctx.packages.list({ scopes }).some((record) => record.manifest.source.repo === repoSlug(repo));
}

function canWriteRepo(rawRepo: string, ctx: KernelContext): boolean {
  const repo = parseRepoSlug(rawRepo);
  const identity = requireIdentity(ctx);
  if (identity.process.uid === 0 || identity.capabilities.includes("*")) {
    return true;
  }
  return repo.owner === identity.process.username;
}

function toSummary(
  repo: RipgitRepoRef,
  kind: RepoSummary["kind"],
  ctx: KernelContext,
): RepoSummary {
  const slug = repoSlug(repo);
  return {
    repo: slug,
    owner: repo.owner,
    name: repo.repo,
    kind,
    writable: canWriteRepo(slug, ctx),
    public: isRepoPublic(slug, ctx),
  };
}

function parseRepoSlug(raw: string | RipgitRepoRef): RipgitRepoRef {
  if (typeof raw !== "string") {
    return {
      owner: normalizeRepoOwner(raw.owner),
      repo: normalizeRepoName(raw.repo),
      branch: raw.branch,
    };
  }
  const repo = raw.trim().replace(/^\/+|\/+$/g, "");
  const [owner, name, extra] = repo.split("/");
  if (!owner || !name || extra) {
    throw new Error("repo must be '<owner>/<name>'");
  }
  return {
    owner: normalizeRepoOwner(owner),
    repo: normalizeRepoName(name),
  };
}

function normalizeRepoOwner(owner: string): string {
  const normalized = owner.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error(`Invalid repo owner: ${owner}`);
  }
  return normalized;
}

function normalizeRepoName(name: string): string {
  const normalized = name.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error(`Invalid repo name: ${name}`);
  }
  return normalized;
}

function repoSlug(repo: Pick<RipgitRepoRef, "owner" | "repo">): string {
  return `${repo.owner}/${repo.repo}`;
}

function normalizeRef(ref: string | undefined): string {
  const value = typeof ref === "string" && ref.trim().length > 0 ? ref.trim() : DEFAULT_REF;
  if (!/^(refs\/heads\/)?[A-Za-z0-9._/-]+$/.test(value) || value.includes("..")) {
    throw new Error(`Invalid branch ref: ${value}`);
  }
  return value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
}

function normalizeReadRef(ref: string | undefined): string {
  const value = typeof ref === "string" && ref.trim().length > 0 ? ref.trim() : DEFAULT_REF;
  if (value.includes("..") || value.includes("\0")) {
    throw new Error(`Invalid ref: ${value}`);
  }
  return value;
}

function normalizeRepoPath(path: string | undefined, allowEmpty: boolean): string {
  const raw = typeof path === "string" ? path.trim() : "";
  const parts: string[] = [];
  for (const segment of raw.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === ".." || segment.includes("\0")) {
      throw new Error(`Invalid repo path: ${path}`);
    }
    parts.push(segment);
  }
  const normalized = parts.join("/");
  if (!normalized && !allowEmpty) {
    throw new Error("path is required");
  }
  return normalized;
}

function normalizeApplyOps(ops: RepoApplyArgs["ops"]): RipgitApplyOp[] {
  if (!Array.isArray(ops)) {
    throw new Error("ops is required");
  }
  return ops.map((op): RipgitApplyOp => {
    if (op.type === "put") {
      if (typeof op.content === "string" && typeof op.contentBase64 === "string") {
        throw new Error(`put ${op.path} cannot specify both content and contentBase64`);
      }
      return {
        type: "put",
        path: normalizeRepoPath(op.path, false),
        contentBytes: Array.from(
          typeof op.contentBase64 === "string"
            ? decodeBase64(op.contentBase64)
            : TEXT_ENCODER.encode(op.content ?? ""),
        ),
      };
    }
    if (op.type === "delete") {
      return {
        type: "delete",
        path: normalizeRepoPath(op.path, false),
        recursive: op.recursive === true,
      };
    }
    if (op.type === "move") {
      return {
        type: "move",
        from: normalizeRepoPath(op.from, false),
        to: normalizeRepoPath(op.to, false),
      };
    }
    throw new Error(`Unsupported repo op: ${(op as { type?: string }).type ?? "unknown"}`);
  });
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function isBinaryBytes(bytes: Uint8Array): boolean {
  if (bytes.length === 0) {
    return false;
  }
  if (bytes.includes(0)) {
    return true;
  }
  try {
    STRICT_TEXT_DECODER.decode(bytes);
    return false;
  } catch {
    return true;
  }
}

function decodeRepoFile(bytes: Uint8Array): string | null {
  if (isBinaryBytes(bytes)) {
    return null;
  }
  return TEXT_DECODER.decode(bytes);
}

function toDiffStats(stats: { files_changed: number; additions: number; deletions: number }) {
  return {
    filesChanged: stats.files_changed,
    additions: stats.additions,
    deletions: stats.deletions,
  };
}

function toDiffFiles(files: Array<{
  path: string;
  status: "added" | "deleted" | "modified";
  old_hash?: string;
  new_hash?: string;
  hunks?: Array<{
    old_start: number;
    old_count: number;
    new_start: number;
    new_count: number;
    lines: Array<{ tag: "context" | "add" | "delete" | "binary"; content: string }>;
  }>;
}>) {
  return files.map((file) => ({
    path: file.path,
    status: file.status,
    oldHash: file.old_hash,
    newHash: file.new_hash,
    hunks: Array.isArray(file.hunks)
      ? file.hunks.map((hunk) => ({
        oldStart: hunk.old_start,
        oldCount: hunk.old_count,
        newStart: hunk.new_start,
        newCount: hunk.new_count,
        lines: Array.isArray(hunk.lines) ? hunk.lines.map((line) => ({
          tag: line.tag,
          content: line.content,
        })) : [],
      }))
      : undefined,
  }));
}

function clampRepoLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return 30;
  }
  return Math.max(1, Math.min(100, Math.trunc(limit)));
}

function clampRepoOffset(offset: number | undefined): number {
  if (typeof offset !== "number" || !Number.isFinite(offset)) {
    return 0;
  }
  return Math.max(0, Math.trunc(offset));
}

function clampContext(context: number | undefined): number {
  if (typeof context !== "number" || !Number.isFinite(context)) {
    return 3;
  }
  return Math.max(0, Math.min(20, Math.trunc(context)));
}

function isRepoPublic(repo: string, ctx: KernelContext): boolean {
  return ctx.config.get(`config/pkg/public-repos/${repo}`) === "true";
}

function registerRepo(
  ctx: KernelContext,
  repo: Pick<RipgitRepoRef, "owner" | "repo">,
  description?: string,
): void {
  const now = String(Date.now());
  const createdKey = repoConfigKey(repo, "created_at");
  if (ctx.config.get(createdKey) === null) {
    ctx.config.set(createdKey, now);
  }
  ctx.config.set(repoConfigKey(repo, "updated_at"), now);
  if (typeof description === "string" && description.trim().length > 0) {
    ctx.config.set(repoConfigKey(repo, "description"), description.trim());
  }
}

function repoConfigKey(repo: Pick<RipgitRepoRef, "owner" | "repo">, field: string): string {
  return `repos/${repo.owner}/${repo.repo}/${field}`;
}

function parseRegisteredRepoKey(key: string): { owner: string; repo: string; field: string } | null {
  const parts = key.split("/");
  if (parts.length !== 4 || parts[0] !== "repos") {
    return null;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(parts[1]) || !/^[A-Za-z0-9._-]+$/.test(parts[2])) {
    return null;
  }
  return {
    owner: parts[1],
    repo: parts[2],
    field: parts[3],
  };
}

function parseOptionalNumber(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
