import type {
  FileContent,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import type { WorkspaceStore } from "../../kernel/workspaces";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import type { ExtendedMountStat, MountBackend, FsSearchBackendResult } from "../mount";
import {
  RipgitClient,
  type RipgitApplyOp,
} from "../ripgit/client";
import { workspaceRepoRef } from "../ripgit/repos";
import { normalizePath } from "../utils";

type WorkspaceRepoRef = {
  workspaceId: string;
  ownerUid: number;
  repo: ReturnType<typeof workspaceRepoRef>;
  relativePath: string;
  absolutePath: string;
};

const DIRECTORY_MARKER = ".dir";
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
    new RipgitClient(binding),
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

  async search(path: string, query: string, include?: string): Promise<FsSearchBackendResult> {
    if (normalizePath(path) === "/workspaces") {
      return { matches: [] };
    }
    const root = this.resolveRepo(path);
    const glob = include ? compileGlob(include) : null;
    const targetStat = await this.stat(path).catch(() => null);
    const exactPath = targetStat?.isFile ? root.relativePath : null;
    const result = await this.client.search(
      root.repo,
      query,
      root.relativePath.length > 0 ? root.relativePath : undefined,
    );

    const matches = result.matches
      .filter((match) => {
        if (exactPath && match.path !== exactPath) {
          return false;
        }
        if (!isTextPath(match.path)) {
          return false;
        }
        if (!glob) {
          return true;
        }
        return glob.test(match.path.split("/").pop() ?? match.path);
      })
      .map((match) => ({
        path: `${workspaceRootPath(root.workspaceId)}/${match.path}`.replace(/\/+/g, "/"),
        line: match.line,
        content: match.content,
      }));

    return { matches, truncated: result.truncated };
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
      repo: workspaceRepoRef(workspaceId, workspace.ownerUid),
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
