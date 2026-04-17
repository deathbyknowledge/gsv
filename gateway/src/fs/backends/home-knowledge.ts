import type {
  FileContent,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import type { ExtendedMountStat, FsSearchBackendResult, MountBackend } from "../mount";
import { R2MountBackend } from "./r2";
import {
  RipgitClient,
  type RipgitPathResult,
} from "../ripgit/client";
import { homeKnowledgeRepoRef } from "../ripgit/repos";
import { normalizePath } from "../utils";

const DIRECTORY_MARKER = ".dir";
const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

type HomePathKind =
  | "home"
  | "constitution"
  | "context-root"
  | "context-path"
  | "knowledge-root"
  | "knowledge-path"
  | "other";

export function createHomeKnowledgeBackend(
  bucket: R2Bucket,
  ripgitBinding: Fetcher | undefined,
  identity: ProcessIdentity,
): MountBackend | null {
  if (!ripgitBinding) {
    return null;
  }

  return new HomeKnowledgeMountBackend(
    new RipgitClient(ripgitBinding),
    new R2MountBackend(bucket, identity),
    identity,
  );
}

class HomeKnowledgeMountBackend implements MountBackend {
  constructor(
    private readonly client: RipgitClient,
    private readonly fallback: R2MountBackend,
    private readonly identity: ProcessIdentity,
  ) {}

  private get repo() {
    return homeKnowledgeRepoRef(this.identity.uid);
  }

  private get home() {
    return normalizePath(this.identity.home);
  }

  private get constitutionPath() {
    return normalizePath(`${this.identity.home}/CONSTITUTION.md`);
  }

  private get contextRoot() {
    return normalizePath(`${this.identity.home}/context.d`);
  }

  private get knowledgeRoot() {
    return normalizePath(`${this.identity.home}/knowledge`);
  }

  handles(path: string): boolean {
    const normalized = normalizePath(path);
    return normalized === this.home || normalized.startsWith(`${this.home}/`);
  }

  async readFile(path: string): Promise<string> {
    const bytes = await this.readFileBuffer(path);
    return TEXT_DECODER.decode(bytes);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const normalized = normalizePath(path);
    const kind = this.classify(normalized);

    if (kind === "other" || kind === "home") {
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
      await this.fallback.writeFile(normalized, content);
      return;
    }

    if (kind === "context-root" || kind === "knowledge-root") {
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
      await this.fallback.appendFile(normalized, content);
      return;
    }

    if (kind === "context-root" || kind === "knowledge-root") {
      throw new Error(`EISDIR: illegal operation on a directory, append '${normalized}'`);
    }

    let current = "";
    if (await this.exists(normalized)) {
      current = await this.readFile(normalized);
    }
    const appended = TEXT_ENCODER.encode(current + TEXT_DECODER.decode(asBytes(content)));
    const relativePath = this.relativePathForOverlay(normalized);
    await this.applyPut(relativePath, appended, `gsv: append ${relativePath}`);
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    const kind = this.classify(normalized);

    if (kind === "home") {
      return true;
    }
    if (kind === "other") {
      return this.fallback.exists(normalized);
    }
    if (kind === "context-root" || kind === "knowledge-root") {
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
    const normalized = normalizePath(path);
    const kind = this.classify(normalized);

    if (kind === "home") {
      return this.makeDirectoryStat();
    }
    if (kind === "other") {
      return this.fallback.stat(normalized);
    }
    if (kind === "context-root" || kind === "knowledge-root") {
      return this.makeDirectoryStat();
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

    if (kind === "home" || kind === "context-root" || kind === "knowledge-root") {
      return;
    }
    if (kind === "other") {
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
      return this.fallback.readdir(normalized);
    }

    const entries = new Set<string>();

    if (kind === "home") {
      for (const name of await this.fallback.readdir(normalized).catch(() => [] as string[])) {
        entries.add(name);
      }
      entries.add("context.d");
      entries.add("knowledge");
      if (await this.pathExistsInRepo("CONSTITUTION.md") || await this.fallback.exists(this.constitutionPath).catch(() => false)) {
        entries.add("CONSTITUTION.md");
      }
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
      if (kind === "context-root" || kind === "knowledge-root") {
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
      await this.fallback.rm(normalized, options);
      return;
    }
    if (kind === "context-root" || kind === "knowledge-root") {
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

  async search(path: string, query: string, include?: string): Promise<FsSearchBackendResult> {
    const normalized = normalizePath(path);
    const kind = this.classify(normalized);

    if (kind === "other") {
      return this.fallback.search!(normalized, query, include);
    }

    const combined = new Map<string, FsSearchBackendResult["matches"][number]>();

    if (kind === "home") {
      const fallbackMatches = await this.fallback.search!(normalized, query, include).catch(() => ({ matches: [] as FsSearchBackendResult["matches"] }));
      for (const match of fallbackMatches.matches) {
        combined.set(`${match.path}:${match.line}:${match.content}`, match);
      }
      for (const match of await this.searchRepo(query)) {
        combined.set(`${match.path}:${match.line}:${match.content}`, match);
      }
      return { matches: [...combined.values()] };
    }

    const relativePrefix = this.relativePathForOverlay(normalized);
    const repoMatches = await this.searchRepo(query, relativePrefix);
    for (const match of repoMatches) {
      combined.set(`${match.path}:${match.line}:${match.content}`, match);
    }

    if (this.canFallbackToR2(normalized)) {
      const fallbackMatches = await this.fallback.search!(normalized, query, include).catch(() => ({ matches: [] as FsSearchBackendResult["matches"] }));
      for (const match of fallbackMatches.matches) {
        combined.set(`${match.path}:${match.line}:${match.content}`, match);
      }
    }

    return { matches: [...combined.values()] };
  }

  private classify(path: string): HomePathKind {
    if (path === this.home) {
      return "home";
    }
    if (path === this.constitutionPath) {
      return "constitution";
    }
    if (path === this.contextRoot) {
      return "context-root";
    }
    if (path.startsWith(`${this.contextRoot}/`)) {
      return "context-path";
    }
    if (path === this.knowledgeRoot) {
      return "knowledge-root";
    }
    if (path.startsWith(`${this.knowledgeRoot}/`)) {
      return "knowledge-path";
    }
    return "other";
  }

  private relativePathForOverlay(path: string): string {
    if (path === this.constitutionPath) {
      return "CONSTITUTION.md";
    }
    if (path.startsWith(`${this.home}/`)) {
      return path.slice(this.home.length + 1);
    }
    throw new Error(`Path is not part of the home knowledge overlay: ${path}`);
  }

  private canFallbackToR2(path: string): boolean {
    return path === this.constitutionPath || path === this.contextRoot || path.startsWith(`${this.contextRoot}/`);
  }

  private async readOverlay(path: string): Promise<RipgitPathResult> {
    return this.client.readPath(this.repo, this.relativePathForOverlay(path));
  }

  private async pathExistsInRepo(relativePath: string): Promise<boolean> {
    const result = await this.client.readPath(this.repo, relativePath);
    return result.kind !== "missing";
  }

  private async searchRepo(query: string, prefix?: string): Promise<FsSearchBackendResult["matches"]> {
    const result = await this.client.search(this.repo, query, prefix);
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

function asBytes(content: FileContent): Uint8Array {
  if (typeof content === "string") {
    return TEXT_ENCODER.encode(content);
  }
  return content;
}
