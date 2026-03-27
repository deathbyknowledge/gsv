import type {
  FileContent,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import type { WorkspaceStore } from "../kernel/workspaces";
import type { ProcessIdentity } from "../syscalls/system";
import type { ExtendedMountStat, MountBackend, FsSearchBackendResult } from "./mount-backend";
import {
  RipgitClient,
  type RipgitApplyOp,
  type RipgitRepoRef,
} from "./ripgit-client";
import { normalizePath } from "./utils";

type WorkspaceRepoRef = {
  workspaceId: string;
  ownerUid: number;
  repo: RipgitRepoRef;
  relativePath: string;
  absolutePath: string;
};

const DIRECTORY_MARKER = ".dir";
const MAX_SEARCH_MATCHES = 500;
const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

export function createWorkspaceBackend(
  env: Env,
  identity: ProcessIdentity,
  workspaces: WorkspaceStore | undefined,
): MountBackend | null {
  if (!workspaces) {
    return null;
  }

  const binding = env.RIPGIT;
  if (!binding) {
    return null;
  }

  return new WorkspaceMountBackend(
    new RipgitClient(binding, env.RIPGIT_INTERNAL_KEY ?? null),
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

class WorkspaceMountBackend implements MountBackend {
  constructor(
    private readonly client: RipgitClient,
    private readonly identity: ProcessIdentity,
    private readonly workspaces: WorkspaceStore,
  ) {}

  handles(path: string): boolean {
    return path === "/workspaces" || path.startsWith("/workspaces/");
  }

  async readFile(path: string): Promise<string> {
    const bytes = await this.readFileBuffer(path);
    return TEXT_DECODER.decode(bytes);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    if (normalizePath(path) === "/workspaces") {
      throw new Error("EISDIR: illegal operation on a directory, read '/workspaces'");
    }
    const repo = this.resolveRepo(path);
    if (repo.relativePath === "") {
      throw new Error(`EISDIR: illegal operation on a directory, read '${repo.absolutePath}'`);
    }

    const result = await this.client.readPath(repo.repo, repo.relativePath);
    if (result.kind === "missing") {
      throw new Error(`ENOENT: no such file or directory, open '${repo.absolutePath}'`);
    }
    if (result.kind === "tree") {
      throw new Error(`EISDIR: illegal operation on a directory, read '${repo.absolutePath}'`);
    }

    return result.bytes;
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
    if (normalizePath(path) === "/workspaces") {
      return true;
    }
    try {
      await this.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<ExtendedMountStat> {
    if (normalizePath(path) === "/workspaces") {
      return {
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
        mode: 0o755,
        size: 0,
        mtime: new Date(),
        uid: 0,
        gid: 0,
      };
    }
    const repo = this.resolveRepo(path);

    if (repo.relativePath === "") {
      return this.makeDirStat(repo);
    }

    const result = await this.client.readPath(repo.repo, repo.relativePath);
    if (result.kind === "missing") {
      throw new Error(`ENOENT: no such file or directory, stat '${repo.absolutePath}'`);
    }
    if (result.kind === "tree") {
      return this.makeDirStat(repo);
    }

    const workspace = this.requireWorkspace(repo.workspaceId);
    return {
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      mode: 0o644,
      size: result.size,
      mtime: new Date(workspace.updatedAt),
      uid: workspace.ownerUid,
      gid: workspace.ownerUid,
    };
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    if (normalizePath(path) === "/workspaces") {
      return;
    }
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
    if (normalizePath(path) === "/workspaces") {
      const workspaces = this.identity.uid === 0
        ? this.workspaces.list()
        : this.workspaces.list(this.identity.uid);
      return workspaces.map((workspace) => workspace.workspaceId).sort();
    }
    const repo = this.resolveRepo(path);
    const result = await this.client.readPath(repo.repo, repo.relativePath);
    if (result.kind === "missing") {
      throw new Error(`ENOENT: no such file or directory, scandir '${repo.absolutePath}'`);
    }
    if (result.kind !== "tree") {
      throw new Error(`ENOTDIR: not a directory, scandir '${repo.absolutePath}'`);
    }

    const entries = result.entries
      .map((entry) => entry.name)
      .filter((name) => name !== DIRECTORY_MARKER);

    return [...new Set(entries)].sort();
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    if (normalizePath(path) === "/workspaces") {
      throw new Error("EPERM: cannot remove workspace mount '/workspaces'");
    }
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

      const ops: RipgitApplyOp[] = [
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

  async search(path: string, pattern: RegExp, include?: string): Promise<FsSearchBackendResult> {
    if (normalizePath(path) === "/workspaces") {
      return { matches: [] };
    }
    const root = this.resolveRepo(path);
    const matches: FsSearchBackendResult["matches"] = [];
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
    ops: RipgitApplyOp[],
    message: string,
  ): Promise<void> {
    await this.client.apply(
      repo.repo,
      this.identity.username,
      `${this.identity.username}@gsv.internal`,
      message,
      ops,
    );
  }

  private makeDirStat(repo: WorkspaceRepoRef): ExtendedMountStat {
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
      repo: {
        owner: ripgitWorkspaceOwner(workspace.ownerUid),
        repo: workspaceId,
      },
      relativePath,
      absolutePath: normalized,
    };
  }
}

function asBytes(content: FileContent): Uint8Array {
  if (typeof content === "string") {
    return TEXT_ENCODER.encode(content);
  }
  return content;
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
