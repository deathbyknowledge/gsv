import type {
  FileContent,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { AuthStore } from "../../kernel/auth-store";
import { accountIdentity } from "../../kernel/accounts";
import {
  canOwnerAccessAccountHome,
  homeUsernameFromPath,
} from "../../kernel/account-access";
import type { ExtendedMountStat, FsSearchBackendResult, MountBackend } from "../mount";
import { R2MountBackend } from "./r2";
import {
  RipgitClient,
  type RipgitPathResult,
} from "../ripgit/client";
import { accountHomeRepoRef } from "../ripgit/repos";
import { concatBytes, normalizePath } from "../utils";

const DIRECTORY_MARKER = ".dir";
const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

type HomePathKind =
  | "home"
  | "context-root"
  | "context-path"
  | "skills-root"
  | "skills-path"
  | "other";

export type AccountHomeBackendOptions = {
  auth?: AuthStore;
  /** Owning human uid for delegated agent-home routing. Defaults to viewer uid. */
  ownerUid?: number;
  isRoot?: boolean;
};

export function createAccountHomeBackend(
  bucket: R2Bucket,
  ripgitBinding: Fetcher | undefined,
  identity: ProcessIdentity,
  options?: AccountHomeBackendOptions,
): MountBackend | null {
  if (!ripgitBinding) {
    return null;
  }

  const client = new RipgitClient(ripgitBinding);
  const primary = new AccountHomeMountBackend(
    client,
    new R2MountBackend(bucket, identity),
    identity,
  );

  if (!options?.auth) {
    return primary;
  }

  return new DelegatingAccountHomeMountBackend(
    primary,
    client,
    bucket,
    identity,
    options.auth,
    options.ownerUid ?? identity.uid,
    options.isRoot ?? identity.uid === 0,
  );
}

export function isAccountHomeReservedPath(path: string): boolean {
  const normalized = normalizePath(path);
  return homeUsernameFromPath(normalized) !== null
    || normalized === "/root"
    || normalized.startsWith("/root/");
}

class AccountHomeMountBackend implements MountBackend {
  constructor(
    private readonly client: RipgitClient,
    private readonly fallback: R2MountBackend,
    private readonly identity: ProcessIdentity,
    private readonly allowHomeR2Fallback = true,
  ) {}

  private get repo() {
    return accountHomeRepoRef(this.identity.username);
  }

  private get home() {
    return normalizePath(this.identity.home);
  }

  private get contextRoot() {
    return normalizePath(`${this.identity.home}/context.d`);
  }

  private get skillsRoot() {
    return normalizePath(`${this.identity.home}/skills.d`);
  }

  handles(path: string): boolean {
    const normalized = normalizePath(path);
    return normalized === this.home || normalized.startsWith(`${this.home}/`);
  }

  handlesOverlayPath(path: string): boolean {
    const kind = this.classify(normalizePath(path));
    return kind !== "home" && kind !== "other";
  }

  async readFile(path: string): Promise<string> {
    const bytes = await this.readFileBuffer(path);
    return TEXT_DECODER.decode(bytes);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const normalized = normalizePath(path);
    const kind = this.classify(normalized);

    if (kind === "other" || kind === "home") {
      if (!this.allowHomeR2Fallback) {
        if (kind === "home") {
          throw new Error(`EISDIR: illegal operation on a directory, read '${normalized}'`);
        }
        throwPermissionDenied(normalized);
      }
      return this.fallback.readFileBuffer(normalized);
    }

    const result = await this.readOverlay(normalized);
    if (result.kind === "file") {
      return result.bytes;
    }
    if (result.kind === "tree") {
      throw new Error(`EISDIR: illegal operation on a directory, read '${normalized}'`);
    }

    if (this.canFallbackToR2(normalized)) {
      return this.fallback.readFileBuffer(normalized);
    }

    throw new Error(`ENOENT: no such file or directory, open '${normalized}'`);
  }

  async writeFile(path: string, content: FileContent): Promise<void> {
    const normalized = normalizePath(path);
    const kind = this.classify(normalized);

    if (kind === "other" || kind === "home") {
      if (!this.allowHomeR2Fallback) {
        throwPermissionDenied(normalized);
      }
      await this.fallback.writeFile(normalized, content);
      return;
    }

    if (kind === "context-root" || kind === "skills-root") {
      throw new Error(`EISDIR: illegal operation on a directory, write '${normalized}'`);
    }

    await this.applyPut(
      this.relativePathForOverlay(normalized),
      asBytes(content),
      `gsv: write ${this.relativePathForOverlay(normalized)}`,
    );
  }

  async appendFile(path: string, content: FileContent): Promise<void> {
    const normalized = normalizePath(path);
    const kind = this.classify(normalized);

    if (kind === "other" || kind === "home") {
      if (!this.allowHomeR2Fallback) {
        throwPermissionDenied(normalized);
      }
      await this.fallback.appendFile(normalized, content);
      return;
    }

    if (kind === "context-root" || kind === "skills-root") {
      throw new Error(`EISDIR: illegal operation on a directory, append '${normalized}'`);
    }

    let current: Uint8Array<ArrayBufferLike> = new Uint8Array();
    if (await this.exists(normalized)) {
      current = await this.readFileBuffer(normalized);
    }
    const relativePath = this.relativePathForOverlay(normalized);
    await this.applyPut(relativePath, concatBytes(current, asBytes(content)), `gsv: append ${relativePath}`);
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    const kind = this.classify(normalized);

    if (kind === "home") {
      return true;
    }
    if (kind === "other") {
      if (!this.allowHomeR2Fallback) {
        return false;
      }
      return this.fallback.exists(normalized);
    }
    if (kind === "context-root" || kind === "skills-root") {
      return true;
    }

    const result = await this.readOverlay(normalized);
    if (result.kind !== "missing") {
      return true;
    }

    if (this.canFallbackToR2(normalized)) {
      return this.fallback.exists(normalized);
    }

    return false;
  }

  async stat(path: string): Promise<ExtendedMountStat> {
    return this.lstat(path);
  }

  async lstat(path: string): Promise<ExtendedMountStat> {
    const normalized = normalizePath(path);
    const kind = this.classify(normalized);

    if (kind === "home") {
      return this.makeDirectoryStat();
    }
    if (kind === "other") {
      if (!this.allowHomeR2Fallback) {
        throwPermissionDenied(normalized);
      }
      return this.fallback.stat(normalized);
    }
    if (kind === "context-root" || kind === "skills-root") {
      return this.makeDirectoryStat();
    }

    const entry = await this.readOverlayEntry(normalized);
    if (entry?.type === "symlink") {
      return {
        isFile: false,
        isDirectory: false,
        isSymbolicLink: true,
        mode: 0o777,
        size: 0,
        mtime: new Date(),
        uid: this.identity.uid,
        gid: this.identity.gid,
      };
    }

    const result = await this.readOverlay(normalized);
    if (result.kind === "file") {
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
    if (result.kind === "tree") {
      return this.makeDirectoryStat();
    }

    if (this.canFallbackToR2(normalized)) {
      return this.fallback.stat(normalized);
    }

    throw new Error(`ENOENT: no such file or directory, stat '${normalized}'`);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const normalized = normalizePath(path);
    const kind = this.classify(normalized);

    if (kind === "home" || kind === "context-root" || kind === "skills-root") {
      return;
    }
    if (kind === "other") {
      if (!this.allowHomeR2Fallback) {
        throwPermissionDenied(normalized);
      }
      await this.fallback.mkdir(normalized, options);
      return;
    }

    const relativePath = this.relativePathForOverlay(normalized);
    const markerPath = `${relativePath}/${DIRECTORY_MARKER}`;
    await this.applyPut(markerPath, new Uint8Array(0), `gsv: mkdir ${relativePath}`);
  }

  async readdir(path: string): Promise<string[]> {
    const normalized = normalizePath(path);
    const kind = this.classify(normalized);

    if (kind === "other") {
      if (!this.allowHomeR2Fallback) {
        throwPermissionDenied(normalized);
      }
      return this.fallback.readdir(normalized);
    }

    const entries = new Set<string>();

    if (kind === "home") {
      if (this.allowHomeR2Fallback) {
        for (const name of await this.fallback.readdir(normalized).catch(() => [] as string[])) {
          entries.add(name);
        }
      }
      entries.add("context.d");
      entries.add("skills.d");
      return [...entries].sort();
    }

    const relativePath = this.relativePathForOverlay(normalized);
    const result = await this.client.readPath(this.repo, relativePath);
    if (result.kind === "tree") {
      for (const entry of result.entries) {
        if (entry.name !== DIRECTORY_MARKER) {
          entries.add(entry.name);
        }
      }
    } else if (result.kind === "file") {
      throw new Error(`ENOTDIR: not a directory, scandir '${normalized}'`);
    }

    if (this.canFallbackToR2(normalized)) {
      for (const name of await this.fallback.readdir(normalized).catch(() => [] as string[])) {
        entries.add(name);
      }
    }

    if (entries.size === 0) {
      if (kind === "context-root" || kind === "skills-root") {
        return [];
      }
      throw new Error(`ENOENT: no such file or directory, scandir '${normalized}'`);
    }

    return [...entries].sort();
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const normalized = normalizePath(path);
    const kind = this.classify(normalized);

    if (kind === "home") {
      throw new Error(`EPERM: cannot remove home mount '${normalized}'`);
    }
    if (kind === "other") {
      if (!this.allowHomeR2Fallback) {
        throwPermissionDenied(normalized);
      }
      await this.fallback.rm(normalized, options);
      return;
    }
    if (kind === "context-root" || kind === "skills-root") {
      const entries = await this.readdir(normalized);
      if (entries.length > 0 && !options?.recursive) {
        throw new Error(`ENOTEMPTY: directory not empty, rmdir '${normalized}'`);
      }

      const relativePath = this.relativePathForOverlay(normalized);
      const result = await this.readOverlay(normalized);
      if (result.kind !== "missing") {
        await this.applyDelete(relativePath, true, `gsv: rm ${relativePath}`);
        return;
      }
      if (this.canFallbackToR2(normalized)) {
        await this.fallback.rm(normalized, { ...options, recursive: true }).catch(() => undefined);
      }
      return;
    }

    const relativePath = this.relativePathForOverlay(normalized);
    const result = await this.readOverlay(normalized);
    if (result.kind === "missing") {
      if (this.canFallbackToR2(normalized)) {
        await this.fallback.rm(normalized, options);
        return;
      }
      if (options?.force) {
        return;
      }
      throw new Error(`ENOENT: no such file or directory, unlink '${normalized}'`);
    }

    if (result.kind === "tree") {
      if (!options?.recursive) {
        const entries = await this.readdir(normalized);
        if (entries.length > 0) {
          throw new Error(`ENOTEMPTY: directory not empty, rmdir '${normalized}'`);
        }
      }
      await this.applyDelete(relativePath, options?.recursive === true, `gsv: rm ${relativePath}`);
      return;
    }

    await this.applyDelete(relativePath, false, `gsv: rm ${relativePath}`);
  }

  async search(
    path: string,
    query: string,
    include?: string,
    signal?: AbortSignal,
  ): Promise<FsSearchBackendResult> {
    signal?.throwIfAborted();
    const normalized = normalizePath(path);
    const kind = this.classify(normalized);

    if (kind === "other") {
      if (!this.allowHomeR2Fallback) {
        throwPermissionDenied(normalized);
      }
      return this.fallback.search!(normalized, query, include, signal);
    }

    const combined = new Map<string, FsSearchBackendResult["matches"][number]>();

    if (kind === "home") {
      if (this.allowHomeR2Fallback) {
        const fallbackMatches = await this.fallback.search!(normalized, query, include, signal).catch(() => {
          signal?.throwIfAborted();
          return { matches: [] as FsSearchBackendResult["matches"] };
        });
        for (const match of fallbackMatches.matches) {
          combined.set(`${match.path}:${match.line}:${match.content}`, match);
        }
      }
      for (const match of await this.searchRepo(query, undefined, signal)) {
        combined.set(`${match.path}:${match.line}:${match.content}`, match);
      }
      return { matches: [...combined.values()] };
    }

    const relativePrefix = this.relativePathForOverlay(normalized);
    const repoMatches = await this.searchRepo(query, relativePrefix, signal);
    for (const match of repoMatches) {
      combined.set(`${match.path}:${match.line}:${match.content}`, match);
    }

    if (this.canFallbackToR2(normalized)) {
      const fallbackMatches = await this.fallback.search!(normalized, query, include, signal).catch(() => {
        signal?.throwIfAborted();
        return { matches: [] as FsSearchBackendResult["matches"] };
      });
      for (const match of fallbackMatches.matches) {
        combined.set(`${match.path}:${match.line}:${match.content}`, match);
      }
    }

    return { matches: [...combined.values()] };
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const normalized = normalizePath(linkPath);
    const kind = this.classify(normalized);

    if (kind === "other" || kind === "home") {
      if (!this.allowHomeR2Fallback) {
        throwPermissionDenied(normalized);
      }
      await this.fallback.symlink(target, normalized);
      return;
    }
    if (kind === "context-root" || kind === "skills-root") {
      throw new Error(`EISDIR: illegal operation on a directory, symlink '${normalized}'`);
    }

    const relativePath = this.relativePathForOverlay(normalized);
    await this.client.apply(
      this.repo,
      this.identity.username,
      `${this.identity.username}@gsv.local`,
      `gsv: symlink ${relativePath}`,
      [
        {
          type: "symlink",
          path: relativePath,
          target,
        },
      ],
    );
  }

  async readlink(path: string): Promise<string> {
    const normalized = normalizePath(path);
    const kind = this.classify(normalized);

    if (kind === "other" || kind === "home") {
      if (!this.allowHomeR2Fallback) {
        throwPermissionDenied(normalized);
      }
      return this.fallback.readlink(normalized);
    }

    const entry = await this.readOverlayEntry(normalized);
    if (entry?.type !== "symlink") {
      if (this.canFallbackToR2(normalized)) {
        return this.fallback.readlink(normalized);
      }
      throw new Error(`EINVAL: invalid argument, readlink '${normalized}'`);
    }

    const result = await this.readOverlay(normalized);
    if (result.kind !== "file") {
      throw new Error(`EINVAL: invalid argument, readlink '${normalized}'`);
    }
    return TEXT_DECODER.decode(result.bytes);
  }

  private classify(path: string): HomePathKind {
    if (path === this.home) {
      return "home";
    }
    if (path === this.contextRoot) {
      return "context-root";
    }
    if (path.startsWith(`${this.contextRoot}/`)) {
      return "context-path";
    }
    if (path === this.skillsRoot) {
      return "skills-root";
    }
    if (path.startsWith(`${this.skillsRoot}/`)) {
      return "skills-path";
    }
    return "other";
  }

  private relativePathForOverlay(path: string): string {
    if (path.startsWith(`${this.home}/`)) {
      return path.slice(this.home.length + 1);
    }
    throw new Error(`Path is not part of the home repo overlay: ${path}`);
  }

  private canFallbackToR2(path: string): boolean {
    return path === this.contextRoot
      || path.startsWith(`${this.contextRoot}/`)
      || path === this.skillsRoot
      || path.startsWith(`${this.skillsRoot}/`);
  }

  private async readOverlay(path: string): Promise<RipgitPathResult> {
    return this.client.readPath(this.repo, this.relativePathForOverlay(path));
  }

  private async readOverlayEntry(path: string): Promise<{ type: string } | null> {
    const relativePath = this.relativePathForOverlay(path);
    const parts = relativePath.split("/").filter(Boolean);
    if (parts.length === 0) {
      return null;
    }

    const name = parts[parts.length - 1];
    const parent = parts.slice(0, -1).join("/");
    const result = await this.client.readPath(this.repo, parent);
    if (result.kind !== "tree") {
      return null;
    }
    return result.entries.find((entry) => entry.name === name) ?? null;
  }

  private async searchRepo(
    query: string,
    prefix?: string,
    signal?: AbortSignal,
  ): Promise<FsSearchBackendResult["matches"]> {
    const result = await this.client.search(this.repo, query, prefix, signal);
    return result.matches.map((match) => ({
      path: `${this.home}/${match.path}`.replace(/\/+/g, "/"),
      line: match.line,
      content: match.content,
    }));
  }

  private async applyPut(path: string, bytes: Uint8Array, message: string): Promise<void> {
    await this.client.apply(
      this.repo,
      this.identity.username,
      `${this.identity.username}@gsv.local`,
      message,
      [
        {
          type: "put",
          path,
          contentBytes: Array.from(bytes),
        },
      ],
    );
  }

  private async applyDelete(path: string, recursive: boolean, message: string): Promise<void> {
    await this.client.apply(
      this.repo,
      this.identity.username,
      `${this.identity.username}@gsv.local`,
      message,
      [
        {
          type: "delete",
          path,
          recursive,
        },
      ],
    );
  }

  private makeDirectoryStat(): ExtendedMountStat {
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
}

/**
 * Routes another account's home root and home repo overlay dirs through a
 * ripgit-backed mount keyed on the target account when the viewer is authorized
 * to manage that agent. Non-overlay files in the target home stay on the
 * viewer's normal R2 permission path.
 */
class DelegatingAccountHomeMountBackend implements MountBackend {
  private readonly delegates = new Map<string, AccountHomeMountBackend>();

  constructor(
    private readonly primary: AccountHomeMountBackend,
    private readonly client: RipgitClient,
    private readonly bucket: R2Bucket,
    private readonly viewerIdentity: ProcessIdentity,
    private readonly auth: AuthStore,
    private readonly ownerUid: number,
    private readonly isRoot: boolean,
  ) {}

  handles(path: string): boolean {
    return this.resolve(path) != null;
  }

  readFile(path: string): Promise<string> {
    return this.require(path).readFile(path);
  }

  readFileBuffer(path: string): Promise<Uint8Array> {
    return this.require(path).readFileBuffer(path);
  }

  writeFile(path: string, content: FileContent): Promise<void> {
    return this.require(path).writeFile(path, content);
  }

  appendFile(path: string, content: FileContent): Promise<void> {
    return this.require(path).appendFile(path, content);
  }

  exists(path: string): Promise<boolean> {
    return this.require(path).exists(path);
  }

  stat(path: string): Promise<ExtendedMountStat> {
    return this.require(path).stat(path);
  }

  lstat(path: string): Promise<ExtendedMountStat> {
    const backend = this.require(path);
    return backend.lstat ? backend.lstat(path) : backend.stat(path);
  }

  mkdir(path: string, options?: MkdirOptions): Promise<void> {
    return this.require(path).mkdir(path, options);
  }

  readdir(path: string): Promise<string[]> {
    return this.require(path).readdir(path);
  }

  rm(path: string, options?: RmOptions): Promise<void> {
    return this.require(path).rm(path, options);
  }

  symlink(target: string, linkPath: string): Promise<void> {
    const backend = this.require(linkPath);
    if (!backend.symlink) {
      throw new Error(`ENOSYS: symlink is unavailable for '${linkPath}'`);
    }
    return backend.symlink(target, linkPath);
  }

  readlink(path: string): Promise<string> {
    const backend = this.require(path);
    if (!backend.readlink) {
      throw new Error(`ENOSYS: readlink is unavailable for '${path}'`);
    }
    return backend.readlink(path);
  }

  search(
    path: string,
    query: string,
    include?: string,
    signal?: AbortSignal,
  ): Promise<FsSearchBackendResult> {
    return this.require(path).search(path, query, include, signal);
  }

  private require(path: string): AccountHomeMountBackend {
    const backend = this.resolve(path);
    if (!backend) {
      throw new Error(`ENOENT: no such file or directory, open '${normalizePath(path)}'`);
    }
    return backend;
  }

  private resolve(path: string): AccountHomeMountBackend | null {
    const normalized = normalizePath(path);
    if (this.primary.handles(normalized)) {
      return this.primary;
    }

    const username = homeUsernameFromPath(normalized);
    if (!username || username === this.viewerIdentity.username) {
      return null;
    }

    if (!canOwnerAccessAccountHome(
      this.auth,
      this.ownerUid,
      this.viewerIdentity.username,
      username,
      this.isRoot,
    )) {
      return null;
    }

    const entry = this.auth.getPasswdByUsername(username);
    if (!entry) return null;

    let delegate = this.delegates.get(username);
    if (!delegate) {
      const targetIdentity = accountIdentity(this.auth, entry);
      delegate = new AccountHomeMountBackend(
        this.client,
        new R2MountBackend(this.bucket, this.viewerIdentity),
        targetIdentity,
        this.isRoot,
      );
      this.delegates.set(username, delegate);
    }

    return delegate.handles(normalized) ? delegate : null;
  }
}

function throwPermissionDenied(path: string): never {
  throw new Error(`EACCES: permission denied, '${path}'`);
}

function asBytes(content: FileContent): Uint8Array {
  if (typeof content === "string") {
    return TEXT_ENCODER.encode(content);
  }
  return content;
}
