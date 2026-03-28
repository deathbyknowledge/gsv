import type {
  FileContent,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import type { ProcessIdentity } from "../../syscalls/system";
import type { ExtendedMountStat, MountBackend, FsSearchBackendResult } from "../mount";
import type { KnowledgeStore } from "../knowledge-store";
import { createHomeKnowledgeStore } from "../knowledge-store";
import { R2MountBackend } from "./r2";
import { normalizePath } from "../utils";

const DIRECTORY_MARKER = ".dir";
const MAX_SEARCH_MATCHES = 500;
const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

export function createHomeKnowledgeBackend(
  env: Pick<Env, "RIPGIT" | "RIPGIT_INTERNAL_KEY">,
  bucket: R2Bucket,
  identity: ProcessIdentity,
): MountBackend | null {
  const store = createHomeKnowledgeStore(env, identity.uid);
  if (!store) {
    return null;
  }

  return new HomeKnowledgeMountBackend(
    store,
    new R2MountBackend(bucket, identity),
    identity,
  );
}

export class HomeKnowledgeMountBackend implements MountBackend {
  private readonly homePath: string;
  private readonly constitutionPath: string;
  private readonly contextRootPath: string;
  private readonly homeAncestors: Set<string>;

  constructor(
    private readonly store: KnowledgeStore,
    private readonly fallback: MountBackend,
    private readonly identity: ProcessIdentity,
  ) {
    this.homePath = normalizePath(identity.home);
    this.constitutionPath = `${this.homePath}/CONSTITUTION.md`.replace(/\/+/g, "/");
    this.contextRootPath = `${this.homePath}/context.d`.replace(/\/+/g, "/");
    this.homeAncestors = new Set(parentPaths(this.homePath).filter((path) => path !== "/"));
  }

  handles(path: string): boolean {
    const normalized = normalizePath(path);
    return (
      normalized === this.homePath ||
      normalized.startsWith(`${this.homePath}/`) ||
      this.homeAncestors.has(normalized)
    );
  }

  async readFile(path: string): Promise<string> {
    const bytes = await this.readFileBuffer(path);
    return TEXT_DECODER.decode(bytes);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const normalized = normalizePath(path);
    if (normalized === this.contextRootPath) {
      throw new Error(`EISDIR: illegal operation on a directory, read '${normalized}'`);
    }

    const repoPath = this.toKnowledgePath(normalized);
    if (!repoPath) {
      return this.fallback.readFileBuffer(normalized);
    }

    const result = await this.store.read(repoPath);
    if (result.kind === "missing") {
      throw new Error(`ENOENT: no such file or directory, open '${normalized}'`);
    }
    if (result.kind === "directory") {
      throw new Error(`EISDIR: illegal operation on a directory, read '${normalized}'`);
    }

    return result.bytes;
  }

  async writeFile(path: string, content: FileContent): Promise<void> {
    const normalized = normalizePath(path);
    if (this.isSyntheticDirectory(normalized) || normalized === this.contextRootPath) {
      throw new Error(`EISDIR: illegal operation on a directory, write '${normalized}'`);
    }

    const repoPath = this.toKnowledgePath(normalized);
    if (!repoPath) {
      await this.fallback.writeFile(normalized, content);
      return;
    }

    await this.store.write(repoPath, asBytes(content), this.writeOptions(`gsv: write ${repoPath}`));
  }

  async appendFile(path: string, content: FileContent): Promise<void> {
    const normalized = normalizePath(path);
    if (this.isSyntheticDirectory(normalized) || normalized === this.contextRootPath) {
      throw new Error(`EISDIR: illegal operation on a directory, append '${normalized}'`);
    }

    const repoPath = this.toKnowledgePath(normalized);
    if (!repoPath) {
      await this.fallback.appendFile(normalized, content);
      return;
    }

    let current = "";
    const existing = await this.store.read(repoPath);
    if (existing.kind === "file") {
      current = TEXT_DECODER.decode(existing.bytes);
    } else if (existing.kind === "directory") {
      throw new Error(`EISDIR: illegal operation on a directory, append '${normalized}'`);
    }

    const appended = current + TEXT_DECODER.decode(asBytes(content));
    await this.store.write(repoPath, appended, this.writeOptions(`gsv: append ${repoPath}`));
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    if (this.isSyntheticDirectory(normalized)) {
      return true;
    }

    const repoPath = this.toKnowledgePath(normalized);
    if (!repoPath) {
      return this.fallback.exists(normalized);
    }

    if (repoPath === "context.d") {
      return true;
    }

    const result = await this.store.read(repoPath);
    return result.kind !== "missing";
  }

  async stat(path: string): Promise<ExtendedMountStat> {
    const normalized = normalizePath(path);
    if (this.isSyntheticDirectory(normalized)) {
      return this.makeDirStat();
    }

    const repoPath = this.toKnowledgePath(normalized);
    if (!repoPath) {
      return this.fallback.stat(normalized);
    }

    if (repoPath === "context.d") {
      return this.makeDirStat();
    }

    const result = await this.store.read(repoPath);
    if (result.kind === "missing") {
      throw new Error(`ENOENT: no such file or directory, stat '${normalized}'`);
    }
    if (result.kind === "directory") {
      return this.makeDirStat();
    }

    return {
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      mode: 0o644,
      size: result.size,
      mtime: new Date(),
      uid: this.identity.uid,
      gid: this.identity.gid,
    };
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const normalized = normalizePath(path);
    if (this.isSyntheticDirectory(normalized)) {
      return;
    }

    if (!this.isContextTreePath(normalized)) {
      await this.fallback.mkdir(normalized, options);
      return;
    }

    if (normalized === this.contextRootPath) {
      return;
    }

    const exists = await this.exists(normalized);
    if (exists) {
      if (!options?.recursive) {
        throw new Error(`EEXIST: file already exists, mkdir '${normalized}'`);
      }
      return;
    }

    if (!options?.recursive) {
      const parent = dirname(normalized);
      if (!await this.exists(parent)) {
        throw new Error(`ENOENT: no such file or directory, mkdir '${normalized}'`);
      }
    }

    const repoPath = this.requireKnowledgePath(normalized);
    await this.store.write(
      joinRelative(repoPath, DIRECTORY_MARKER),
      new Uint8Array(),
      this.writeOptions(`gsv: mkdir ${repoPath}`),
    );
  }

  async readdir(path: string): Promise<string[]> {
    const normalized = normalizePath(path);

    if (this.homeAncestors.has(normalized)) {
      return this.readdirAncestor(normalized);
    }

    if (normalized === this.homePath) {
      return this.readdirHome();
    }

    const repoPath = this.toKnowledgePath(normalized);
    if (!repoPath) {
      return this.fallback.readdir(normalized);
    }

    const result = await this.store.read(repoPath);
    if (repoPath === "context.d" && result.kind === "missing") {
      return [];
    }
    if (result.kind === "missing") {
      throw new Error(`ENOENT: no such file or directory, scandir '${normalized}'`);
    }
    if (result.kind === "file") {
      throw new Error(`ENOTDIR: not a directory, scandir '${normalized}'`);
    }

    return result.entries
      .map((entry) => entry.name)
      .filter((name) => name !== DIRECTORY_MARKER)
      .sort();
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const normalized = normalizePath(path);
    if (this.isSyntheticDirectory(normalized)) {
      throw new Error(`EPERM: cannot remove mounted home path '${normalized}'`);
    }

    const repoPath = this.toKnowledgePath(normalized);
    if (!repoPath) {
      await this.fallback.rm(normalized, options);
      return;
    }

    if (repoPath === "context.d") {
      throw new Error(`EPERM: cannot remove mounted knowledge root '${normalized}'`);
    }

    const stat = await this.stat(normalized).catch(() => null);
    if (!stat) {
      if (options?.force) {
        return;
      }
      throw new Error(`ENOENT: no such file or directory, unlink '${normalized}'`);
    }

    if (stat.isDirectory) {
      const entries = await this.readdir(normalized);
      if (entries.length > 0 && !options?.recursive) {
        throw new Error(`ENOTEMPTY: directory not empty, rmdir '${normalized}'`);
      }

      await this.store.delete(repoPath, {
        ...this.writeOptions(`gsv: rm ${repoPath}`),
        recursive: true,
      });
      return;
    }

    await this.store.delete(repoPath, this.writeOptions(`gsv: rm ${repoPath}`));
  }

  async search(path: string, query: string, include?: string): Promise<FsSearchBackendResult> {
    const normalized = normalizePath(path);
    const fallbackResult = await this.searchFallback(normalized, query, include);
    const knowledgeResult = await this.searchKnowledge(normalized, query, include);
    const matches = [...fallbackResult.matches, ...knowledgeResult.matches];

    const truncated =
      fallbackResult.truncated ||
      knowledgeResult.truncated ||
      matches.length > MAX_SEARCH_MATCHES;

    return {
      matches: matches.slice(0, MAX_SEARCH_MATCHES),
      truncated,
    };
  }

  async chmod(path: string, mode: number): Promise<void> {
    const normalized = normalizePath(path);
    const repoPath = this.toKnowledgePath(normalized);
    if (!repoPath) {
      if (!this.fallback.chmod) {
        throw new Error(`ENOSYS: chmod not supported for '${normalized}'`);
      }
      await this.fallback.chmod(normalized, mode);
      return;
    }

    throw new Error(`ENOSYS: chmod not supported for knowledge path '${normalized}'`);
  }

  async chown(path: string, uid?: number, gid?: number): Promise<void> {
    const normalized = normalizePath(path);
    const repoPath = this.toKnowledgePath(normalized);
    if (!repoPath) {
      if (!this.fallback.chown) {
        throw new Error(`ENOSYS: chown not supported for '${normalized}'`);
      }
      await this.fallback.chown(normalized, uid, gid);
      return;
    }

    throw new Error(`ENOSYS: chown not supported for knowledge path '${normalized}'`);
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    const normalized = normalizePath(path);
    const repoPath = this.toKnowledgePath(normalized);
    if (!repoPath) {
      if (!this.fallback.utimes) {
        const exists = await this.fallback.exists(normalized);
        if (!exists) {
          throw new Error(`ENOENT: no such file or directory, utimes '${normalized}'`);
        }
        return;
      }
      await this.fallback.utimes(normalized, atime, mtime);
      return;
    }

    const exists = await this.exists(normalized);
    if (!exists) {
      throw new Error(`ENOENT: no such file or directory, utimes '${normalized}'`);
    }
  }

  private async readdirAncestor(path: string): Promise<string[]> {
    const entries = new Set<string>();
    for (const name of await this.fallback.readdir(path).catch(() => [] as string[])) {
      entries.add(name);
    }

    const next = childNameForAncestor(path, this.homePath);
    if (next) {
      entries.add(next);
    }

    return [...entries].sort();
  }

  private async readdirHome(): Promise<string[]> {
    const entries = new Set<string>();
    for (const name of await this.fallback.readdir(this.homePath).catch(() => [] as string[])) {
      if (name === "CONSTITUTION.md" || name === "context.d") {
        continue;
      }
      entries.add(name);
    }

    entries.add("context.d");
    if ((await this.store.read("CONSTITUTION.md")).kind === "file") {
      entries.add("CONSTITUTION.md");
    }

    return [...entries].sort();
  }

  private async searchFallback(path: string, query: string, include?: string): Promise<FsSearchBackendResult> {
    if (!this.fallback.search) {
      return { matches: [] };
    }

    const result: FsSearchBackendResult = await this.fallback.search(path, query, include).catch(
      () => ({ matches: [] }),
    );
    return {
      matches: result.matches.filter((match) => !this.isKnowledgePath(normalizePath(match.path))),
      truncated: result.truncated,
    };
  }

  private async searchKnowledge(path: string, query: string, include?: string): Promise<FsSearchBackendResult> {
    const target = await this.resolveKnowledgeSearch(path);
    if (!target) {
      return { matches: [] };
    }

    const result = await this.store.search(query, {
      prefix: target.prefix,
      include,
      limit: MAX_SEARCH_MATCHES,
    });

    const matches = result.matches
      .filter((match) => !target.exactPath || match.path === target.exactPath)
      .map((match) => ({
        path: `${this.homePath}/${match.path}`.replace(/\/+/g, "/"),
        line: match.line,
        content: match.content,
      }));

    return {
      matches,
      truncated: result.truncated,
    };
  }

  private async resolveKnowledgeSearch(path: string): Promise<{ prefix?: string; exactPath?: string } | null> {
    const normalized = normalizePath(path);

    if (this.homeAncestors.has(normalized) || normalized === this.homePath) {
      return {};
    }

    const repoPath = this.toKnowledgePath(normalized);
    if (!repoPath) {
      return null;
    }

    const stat = await this.stat(normalized).catch(() => null);
    if (stat?.isFile) {
      return { prefix: repoPath, exactPath: repoPath };
    }

    return { prefix: repoPath };
  }

  private isSyntheticDirectory(path: string): boolean {
    return path === this.homePath || this.homeAncestors.has(path);
  }

  private isContextTreePath(path: string): boolean {
    return path === this.contextRootPath || path.startsWith(`${this.contextRootPath}/`);
  }

  private isKnowledgePath(path: string): boolean {
    return path === this.constitutionPath || this.isContextTreePath(path);
  }

  private toKnowledgePath(path: string): string | null {
    if (path === this.constitutionPath) {
      return "CONSTITUTION.md";
    }
    if (path === this.contextRootPath) {
      return "context.d";
    }
    if (path.startsWith(`${this.contextRootPath}/`)) {
      return path.slice(this.homePath.length + 1);
    }
    return null;
  }

  private requireKnowledgePath(path: string): string {
    const repoPath = this.toKnowledgePath(path);
    if (!repoPath) {
      throw new Error(`ENOENT: knowledge path required '${path}'`);
    }
    return repoPath;
  }

  private makeDirStat(): ExtendedMountStat {
    return {
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
      mode: 0o755,
      size: 0,
      mtime: new Date(),
      uid: this.identity.uid,
      gid: this.identity.gid,
    };
  }

  private writeOptions(message: string) {
    return {
      authorName: this.identity.username,
      authorEmail: `${this.identity.username}@gsv.internal`,
      message,
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

function parentPaths(path: string): string[] {
  const normalized = normalizePath(path);
  const parts = normalized.split("/").filter(Boolean);
  const parents: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    parents.push("/" + parts.slice(0, i).join("/"));
  }
  return parents;
}

function childNameForAncestor(ancestor: string, target: string): string | null {
  const normalizedAncestor = normalizePath(ancestor);
  const normalizedTarget = normalizePath(target);
  if (!normalizedTarget.startsWith(`${normalizedAncestor}/`)) {
    return null;
  }

  const remainder = normalizedTarget.slice(normalizedAncestor.length + 1);
  const [child] = remainder.split("/");
  return child || null;
}
