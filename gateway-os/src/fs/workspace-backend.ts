import type {
  BufferEncoding,
  FileContent,
  FsStat,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import type { WorkspaceStore } from "../kernel/workspaces";
import type { ProcessIdentity } from "../syscalls/system";
import type { FsSearchMatch } from "../syscalls/search";

export type ExtendedWorkspaceStat = FsStat & { uid: number; gid: number };

export interface WorkspaceBackend {
  handles(path: string): boolean;
  readFile(path: string, options?: { encoding?: BufferEncoding | null } | BufferEncoding): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: FileContent, options?: { encoding?: BufferEncoding } | BufferEncoding): Promise<void>;
  appendFile(path: string, content: FileContent, options?: { encoding?: BufferEncoding } | BufferEncoding): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<ExtendedWorkspaceStat>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rm(path: string, options?: RmOptions): Promise<void>;
  search(path: string, pattern: RegExp, include?: string): Promise<{ matches: FsSearchMatch[]; truncated?: boolean }>;
}

type RipgitBinding = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

type WorkspaceTreeEntry = {
  name: string;
  mode: string;
  hash: string;
  type: "tree" | "blob" | "symlink";
};

type WorkspaceApplyOp =
  | {
      type: "put";
      path: string;
      contentBytes: number[];
      message?: string;
    }
  | {
      type: "delete";
      path: string;
      recursive?: boolean;
    }
  | {
      type: "move";
      from: string;
      to: string;
    };

type WorkspaceApplyResponse = {
  ok: boolean;
  head?: string | null;
  conflict?: boolean;
  error?: string;
};

type WorkspaceRepoRef = {
  workspaceId: string;
  ownerUid: number;
  ownerName: string;
  repoName: string;
  relativePath: string;
  absolutePath: string;
};

const DEFAULT_BRANCH = "main";
const DIRECTORY_MARKER = ".dir";
const MAX_SEARCH_MATCHES = 500;
const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

export function createWorkspaceBackend(
  env: Env,
  identity: ProcessIdentity,
  workspaces: WorkspaceStore | undefined,
): WorkspaceBackend | null {
  if (!workspaces) {
    return null;
  }

  const binding = getRipgitBinding(env);
  if (!binding) {
    return null;
  }

  return new RipgitWorkspaceBackend(
    binding,
    getRipgitInternalKey(env),
    identity,
    workspaces,
  );
}

export function workspaceRootPath(workspaceId: string): string {
  return `/workspaces/${workspaceId}`;
}

export function isWorkspaceMountPath(path: string): boolean {
  return path === "/workspaces" || path.startsWith("/workspaces/");
}

class RipgitWorkspaceBackend implements WorkspaceBackend {
  constructor(
    private readonly binding: RipgitBinding,
    private readonly internalKey: string | null,
    private readonly identity: ProcessIdentity,
    private readonly workspaces: WorkspaceStore,
  ) {}

  handles(path: string): boolean {
    return path.startsWith("/workspaces/") && path !== "/workspaces";
  }

  async readFile(path: string): Promise<string> {
    const bytes = await this.readFileBuffer(path);
    return TEXT_DECODER.decode(bytes);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const repo = this.resolveRepo(path);
    if (repo.relativePath === "") {
      throw new Error(`EISDIR: illegal operation on a directory, read '${repo.absolutePath}'`);
    }

    const response = await this.fetchFile(repo);
    if (response.status === 404) {
      throw new Error(`ENOENT: no such file or directory, open '${repo.absolutePath}'`);
    }
    if (!response.ok) {
      throw new Error(await this.readError(response, `open '${repo.absolutePath}'`));
    }

    if (this.isTreeResponse(response)) {
      throw new Error(`EISDIR: illegal operation on a directory, read '${repo.absolutePath}'`);
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  async writeFile(path: string, content: FileContent): Promise<void> {
    const repo = this.resolveRepo(path);
    if (repo.relativePath === "") {
      throw new Error(`EISDIR: illegal operation on a directory, write '${repo.absolutePath}'`);
    }

    await this.apply(repo, [
      {
        type: "put",
        path: repo.relativePath,
        contentBytes: Array.from(asBytes(content)),
      },
    ], `gsv: write ${repo.relativePath}`);
  }

  async appendFile(path: string, content: FileContent): Promise<void> {
    const repo = this.resolveRepo(path);
    if (repo.relativePath === "") {
      throw new Error(`EISDIR: illegal operation on a directory, append '${repo.absolutePath}'`);
    }

    let current = "";
    const exists = await this.exists(path);
    if (exists) {
      current = await this.readFile(path);
    }

    const appended = current + TEXT_DECODER.decode(asBytes(content));
    await this.apply(repo, [
      {
        type: "put",
        path: repo.relativePath,
        contentBytes: Array.from(TEXT_ENCODER.encode(appended)),
      },
    ], `gsv: append ${repo.relativePath}`);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<ExtendedWorkspaceStat> {
    const repo = this.resolveRepo(path);

    if (repo.relativePath === "") {
      return this.makeDirStat(repo);
    }

    const response = await this.fetchFile(repo);
    if (response.status === 404) {
      throw new Error(`ENOENT: no such file or directory, stat '${repo.absolutePath}'`);
    }
    if (!response.ok) {
      throw new Error(await this.readError(response, `stat '${repo.absolutePath}'`));
    }

    if (this.isTreeResponse(response)) {
      return this.makeDirStat(repo);
    }

    const size = parseInt(response.headers.get("X-Blob-Size") ?? "0", 10);
    const workspace = this.requireWorkspace(repo.workspaceId);
    return {
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      mode: 0o644,
      size: Number.isFinite(size) ? size : 0,
      mtime: new Date(workspace.updatedAt),
      uid: workspace.ownerUid,
      gid: workspace.ownerUid,
    };
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const repo = this.resolveRepo(path);
    if (repo.relativePath === "") {
      return;
    }

    const exists = await this.exists(path);
    if (exists) {
      if (!options?.recursive) {
        throw new Error(`EEXIST: file already exists, mkdir '${repo.absolutePath}'`);
      }
      return;
    }

    if (!options?.recursive) {
      const parent = dirname(repo.absolutePath);
      const parentExists = await this.exists(parent);
      if (!parentExists) {
        throw new Error(`ENOENT: no such file or directory, mkdir '${repo.absolutePath}'`);
      }
    }

    const markerPath = joinRelative(repo.relativePath, DIRECTORY_MARKER);
    await this.apply(repo, [
      {
        type: "put",
        path: markerPath,
        contentBytes: [],
      },
    ], `gsv: mkdir ${repo.relativePath}`);
  }

  async readdir(path: string): Promise<string[]> {
    const repo = this.resolveRepo(path);
    const response = await this.fetchFile(repo);

    if (response.status === 404) {
      throw new Error(`ENOENT: no such file or directory, scandir '${repo.absolutePath}'`);
    }
    if (!response.ok) {
      throw new Error(await this.readError(response, `scandir '${repo.absolutePath}'`));
    }
    if (!this.isTreeResponse(response)) {
      throw new Error(`ENOTDIR: not a directory, scandir '${repo.absolutePath}'`);
    }

    const entries = (await response.json<WorkspaceTreeEntry[]>())
      .map((entry) => entry.name)
      .filter((name) => name !== DIRECTORY_MARKER);

    return [...new Set(entries)].sort();
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const repo = this.resolveRepo(path);
    if (repo.relativePath === "") {
      throw new Error(`EPERM: cannot remove workspace root '${repo.absolutePath}'`);
    }

    const stat = await this.stat(path).catch(() => null);
    if (!stat) {
      if (options?.force) {
        return;
      }
      throw new Error(`ENOENT: no such file or directory, unlink '${repo.absolutePath}'`);
    }

    if (stat.isDirectory) {
      const entries = await this.readdir(path);
      if (entries.length > 0 && !options?.recursive) {
        throw new Error(`ENOTEMPTY: directory not empty, rmdir '${repo.absolutePath}'`);
      }

      const ops: WorkspaceApplyOp[] = [
        { type: "delete", path: joinRelative(repo.relativePath, DIRECTORY_MARKER) },
      ];
      if (options?.recursive) {
        ops.unshift({ type: "delete", path: repo.relativePath, recursive: true });
      }

      await this.apply(repo, ops, `gsv: rm ${repo.relativePath}`);
      return;
    }

    await this.apply(repo, [
      { type: "delete", path: repo.relativePath },
    ], `gsv: rm ${repo.relativePath}`);
  }

  async search(path: string, pattern: RegExp, include?: string): Promise<{ matches: FsSearchMatch[]; truncated?: boolean }> {
    const root = this.resolveRepo(path);
    const matches: FsSearchMatch[] = [];
    const glob = include ? compileGlob(include) : null;

    for await (const file of this.walkFiles(root.absolutePath)) {
      if (glob && !glob.test(file.split("/").pop() ?? file)) {
        continue;
      }
      if (!isTextPath(file)) {
        continue;
      }

      const text = await this.readFile(file).catch(() => null);
      if (text === null) {
        continue;
      }

      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        pattern.lastIndex = 0;
        if (pattern.test(lines[i])) {
          matches.push({ path: file, line: i + 1, content: lines[i] });
          if (matches.length >= MAX_SEARCH_MATCHES) {
            return { matches, truncated: true };
          }
        }
      }
    }

    return { matches };
  }

  private async *walkFiles(path: string): AsyncGenerator<string> {
    const stat = await this.stat(path).catch(() => null);
    if (!stat) {
      return;
    }

    if (stat.isFile) {
      yield path;
      return;
    }

    for (const entry of await this.readdir(path)) {
      const child = path === "/" ? `/${entry}` : `${path.replace(/\/+$/, "")}/${entry}`;
      yield* this.walkFiles(child);
    }
  }

  private async apply(
    repo: WorkspaceRepoRef,
    ops: WorkspaceApplyOp[],
    message: string,
  ): Promise<void> {
    if (!this.internalKey) {
      throw new Error("RIPGIT_INTERNAL_KEY is not configured");
    }

    const response = await this.binding.fetch(this.makeUrl(repo.ownerName, repo.repoName, "/_gsv/apply"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ripgit-Internal-Key": this.internalKey,
      },
      body: JSON.stringify({
        defaultBranch: DEFAULT_BRANCH,
        author: this.identity.username,
        email: `${this.identity.username}@gsv.internal`,
        message,
        ops,
      }),
    });

    if (!response.ok) {
      throw new Error(await this.readError(response, `apply '${repo.absolutePath}'`));
    }

    const payload = await response.json<WorkspaceApplyResponse>();
    if (!payload.ok) {
      throw new Error(payload.error ?? `Failed to apply workspace changes for ${repo.absolutePath}`);
    }
  }

  private async fetchFile(repo: WorkspaceRepoRef): Promise<Response> {
    const url = this.makeUrl(
      repo.ownerName,
      repo.repoName,
      `/file?ref=${encodeURIComponent(DEFAULT_BRANCH)}&path=${encodeURIComponent(repo.relativePath)}`,
    );
    return this.binding.fetch(url);
  }

  private isTreeResponse(response: Response): boolean {
    const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
    return contentType.startsWith("application/json");
  }

  private makeUrl(owner: string, repo: string, suffix: string): URL {
    return new URL(`https://ripgit/${owner}/${repo}${suffix}`);
  }

  private makeDirStat(repo: WorkspaceRepoRef): ExtendedWorkspaceStat {
    const workspace = this.requireWorkspace(repo.workspaceId);
    return {
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
      mode: 0o755,
      size: 0,
      mtime: new Date(workspace.updatedAt),
      uid: workspace.ownerUid,
      gid: workspace.ownerUid,
    };
  }

  private requireWorkspace(workspaceId: string) {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`ENOENT: workspace not found '${workspaceId}'`);
    }

    if (this.identity.uid !== 0 && workspace.ownerUid !== this.identity.uid) {
      throw new Error(`EACCES: permission denied, workspace '${workspaceId}'`);
    }

    return workspace;
  }

  private resolveRepo(path: string): WorkspaceRepoRef {
    const normalized = normalizePath(path);
    if (!normalized.startsWith("/workspaces/")) {
      throw new Error(`ENOENT: workspace path required '${normalized}'`);
    }

    const parts = normalized.slice("/workspaces/".length).split("/").filter(Boolean);
    if (parts.length === 0) {
      throw new Error(`ENOENT: workspace path required '${normalized}'`);
    }

    const workspaceId = parts[0];
    const workspace = this.requireWorkspace(workspaceId);
    const relativePath = parts.slice(1).join("/");

    return {
      workspaceId,
      ownerUid: workspace.ownerUid,
      ownerName: ripgitWorkspaceOwner(workspace.ownerUid),
      repoName: workspaceId,
      relativePath,
      absolutePath: normalized,
    };
  }

  private async readError(response: Response, context: string): Promise<string> {
    const text = await response.text().catch(() => "");
    if (text) {
      return text;
    }
    return `ripgit ${context} failed with ${response.status}`;
  }
}

function getRipgitBinding(env: Env): RipgitBinding | null {
  const maybeEnv = env as Env & { RIPGIT?: RipgitBinding };
  return maybeEnv.RIPGIT ?? null;
}

function getRipgitInternalKey(env: Env): string | null {
  const maybeEnv = env as Env & { RIPGIT_INTERNAL_KEY?: string };
  const value = maybeEnv.RIPGIT_INTERNAL_KEY;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asBytes(content: FileContent): Uint8Array {
  if (typeof content === "string") {
    return TEXT_ENCODER.encode(content);
  }
  return content;
}

function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return "/" + segments.join("/");
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") {
    return "/";
  }
  const parts = normalized.split("/");
  parts.pop();
  const dir = parts.join("/");
  return dir === "" ? "/" : dir;
}

function joinRelative(prefix: string, name: string): string {
  return prefix ? `${prefix.replace(/\/+$/, "")}/${name}` : name;
}

function compileGlob(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = "^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  return new RegExp(regex);
}

function isTextPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (!ext) {
    return true;
  }

  return ![
    "png", "jpg", "jpeg", "gif", "webp", "svg", "ico",
    "zip", "gz", "tar", "tgz", "bz2", "xz",
    "wasm", "so", "dll", "exe", "bin", "pdf",
    "mp3", "wav", "ogg", "mp4", "mov", "avi",
  ].includes(ext);
}

function ripgitWorkspaceOwner(uid: number): string {
  return `uid-${uid}`;
}
