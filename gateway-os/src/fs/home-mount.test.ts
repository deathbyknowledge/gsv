import { describe, expect, it } from "vitest";
import { GsvFs } from "./gsv-fs";
import { HomeKnowledgeMountBackend } from "./backends/home";
import type { KnowledgeStore, KnowledgeStoreEntry, KnowledgeStoreReadResult } from "./knowledge-store";
import type { ExtendedMountStat, FsSearchBackendResult, MountBackend } from "./mount";
import type { ProcessIdentity } from "../syscalls/system";
import { normalizePath } from "./utils";

const IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
  workspaceId: null,
};

describe("HomeKnowledgeMountBackend", () => {
  it("overlays the home knowledge tree into root and home directory listings", async () => {
    const fallback = new InMemoryMountBackend();
    const backend = new HomeKnowledgeMountBackend(new InMemoryKnowledgeStore(), fallback, IDENTITY);
    const fs = new GsvFs({} as R2Bucket, IDENTITY, undefined, undefined, null, backend);

    expect(await fs.readdir("/")).toContain("home");
    expect(await fs.readdir("/home")).toEqual(["sam"]);
    expect(await fs.readdir("/home/sam")).toEqual(["context.d"]);
    expect(await fs.exists("/home/sam/context.d")).toBe(true);
  });

  it("reads mounted knowledge from the store and leaves other home files on fallback", async () => {
    const store = new InMemoryKnowledgeStore({
      "CONSTITUTION.md": "knowledge constitution",
    });
    const fallback = new InMemoryMountBackend({
      "/home/sam/CONSTITUTION.md": "legacy constitution",
      "/home/sam/notes.txt": "notes",
    });
    const backend = new HomeKnowledgeMountBackend(store, fallback, IDENTITY);

    expect(await backend.readFile("/home/sam/CONSTITUTION.md")).toBe("knowledge constitution");
    expect(await backend.readFile("/home/sam/notes.txt")).toBe("notes");
    expect(await backend.readdir("/home/sam")).toEqual([
      "CONSTITUTION.md",
      "context.d",
      "notes.txt",
    ]);
  });

  it("writes and searches context.d through the knowledge store while filtering legacy fallback paths", async () => {
    const store = new InMemoryKnowledgeStore({
      "CONSTITUTION.md": "needle from knowledge",
    });
    const fallback = new InMemoryMountBackend({
      "/home/sam/CONSTITUTION.md": "needle from legacy r2",
      "/home/sam/notes.txt": "needle from notes",
    });
    const backend = new HomeKnowledgeMountBackend(store, fallback, IDENTITY);

    await backend.writeFile("/home/sam/context.d/alpha.md", "needle from context");

    expect(await backend.readFile("/home/sam/context.d/alpha.md")).toBe("needle from context");

    const result = await backend.search("/home/sam", "needle");
    expect(result.matches).toEqual([
      {
        path: "/home/sam/notes.txt",
        line: 1,
        content: "needle from notes",
      },
      {
        path: "/home/sam/CONSTITUTION.md",
        line: 1,
        content: "needle from knowledge",
      },
      {
        path: "/home/sam/context.d/alpha.md",
        line: 1,
        content: "needle from context",
      },
    ]);
  });
});

class InMemoryKnowledgeStore implements KnowledgeStore {
  private readonly files = new Map<string, string>();
  private readonly directories = new Set<string>();

  constructor(initialFiles: Record<string, string> = {}) {
    this.directories.add("context.d");
    for (const [path, content] of Object.entries(initialFiles)) {
      this.files.set(normalizeRepoPath(path), content);
      this.addParentDirectories(normalizeRepoPath(path));
    }
  }

  async read(path: string): Promise<KnowledgeStoreReadResult> {
    const normalized = normalizeRepoPath(path);
    const file = this.files.get(normalized);
    if (typeof file === "string") {
      return {
        kind: "file",
        bytes: new TextEncoder().encode(file),
        size: file.length,
      };
    }

    if (this.directories.has(normalized) || this.hasChildren(normalized)) {
      return {
        kind: "directory",
        entries: await this.list(normalized),
      };
    }

    return { kind: "missing" };
  }

  async list(prefix = ""): Promise<KnowledgeStoreEntry[]> {
    const normalized = normalizeRepoPath(prefix);
    const children = new Map<string, KnowledgeStoreEntry>();

    for (const path of this.allPaths()) {
      if (!isWithinRepoPrefix(path, normalized)) {
        continue;
      }
      const remainder = normalized ? path.slice(normalized.length + 1) : path;
      if (!remainder) {
        continue;
      }
      const [child, ...rest] = remainder.split("/");
      children.set(child, {
        name: child,
        path: normalized ? `${normalized}/${child}` : child,
        kind: rest.length > 0 || this.directories.has(normalized ? `${normalized}/${child}` : child)
          ? "directory"
          : "file",
      });
    }

    return [...children.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  async write(path: string, content: string | Uint8Array): Promise<void> {
    const normalized = normalizeRepoPath(path);
    const text = typeof content === "string" ? content : new TextDecoder().decode(content);
    this.files.set(normalized, text);
    this.addParentDirectories(normalized);
  }

  async delete(path: string, options?: { recursive?: boolean }): Promise<void> {
    const normalized = normalizeRepoPath(path);
    this.files.delete(normalized);
    if (options?.recursive) {
      for (const filePath of [...this.files.keys()]) {
        if (filePath.startsWith(`${normalized}/`)) {
          this.files.delete(filePath);
        }
      }
      for (const dirPath of [...this.directories]) {
        if (dirPath.startsWith(`${normalized}/`)) {
          this.directories.delete(dirPath);
        }
      }
    }
  }

  async search(query: string, options?: { prefix?: string; include?: string; limit?: number }) {
    const prefix = normalizeRepoPath(options?.prefix ?? "");
    const include = options?.include ? compileGlob(options.include) : null;
    const limit = options?.limit ?? Number.POSITIVE_INFINITY;

    const matches: { path: string; line: number; content: string }[] = [];
    for (const [path, text] of [...this.files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      if (prefix && !isWithinRepoPrefix(path, prefix) && path !== prefix) {
        continue;
      }
      if (include && !include.test(path.split("/").pop() ?? path)) {
        continue;
      }

      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index].includes(query)) {
          continue;
        }
        matches.push({ path, line: index + 1, content: lines[index] });
        if (matches.length >= limit) {
          return { matches, truncated: true };
        }
      }
    }

    return { matches };
  }

  private allPaths(): string[] {
    return [...new Set([...this.files.keys(), ...this.directories])];
  }

  private hasChildren(prefix: string): boolean {
    return this.allPaths().some((path) => isWithinRepoPrefix(path, prefix));
  }

  private addParentDirectories(path: string): void {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      this.directories.add(parts.slice(0, index).join("/"));
    }
  }
}

class InMemoryMountBackend implements MountBackend {
  private readonly files = new Map<string, string>();
  private readonly directories = new Set<string>(["/", "/home", "/home/sam"]);

  constructor(initialFiles: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initialFiles)) {
      const normalized = normalizePath(path);
      this.files.set(normalized, content);
      this.addParentDirectories(normalized);
    }
  }

  handles(): boolean {
    return true;
  }

  async readFile(path: string): Promise<string> {
    const normalized = normalizePath(path);
    const text = this.files.get(normalized);
    if (typeof text !== "string") {
      if (await this.exists(normalized)) {
        throw new Error(`EISDIR: illegal operation on a directory, read '${normalized}'`);
      }
      throw new Error(`ENOENT: no such file or directory, open '${normalized}'`);
    }
    return text;
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readFile(path));
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const normalized = normalizePath(path);
    const text = typeof content === "string" ? content : new TextDecoder().decode(content);
    this.files.set(normalized, text);
    this.addParentDirectories(normalized);
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    const current = await this.exists(path) ? await this.readFile(path) : "";
    const next = current + (typeof content === "string" ? content : new TextDecoder().decode(content));
    await this.writeFile(path, next);
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    return this.files.has(normalized) || this.directories.has(normalized);
  }

  async stat(path: string): Promise<ExtendedMountStat> {
    const normalized = normalizePath(path);
    if (this.files.has(normalized)) {
      const text = this.files.get(normalized) ?? "";
      return makeStat(true, text.length);
    }
    if (this.directories.has(normalized)) {
      return makeStat(false, 0);
    }
    throw new Error(`ENOENT: no such file or directory, stat '${normalized}'`);
  }

  async mkdir(path: string): Promise<void> {
    const normalized = normalizePath(path);
    this.directories.add(normalized);
    this.addParentDirectories(normalized);
  }

  async readdir(path: string): Promise<string[]> {
    const normalized = normalizePath(path);
    if (!this.directories.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, scandir '${normalized}'`);
    }

    const entries = new Set<string>();
    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(`${normalized}/`)) {
        continue;
      }
      const remainder = filePath.slice(normalized.length + 1);
      if (remainder.length > 0) {
        entries.add(remainder.split("/")[0]);
      }
    }
    for (const dirPath of this.directories) {
      if (dirPath === normalized || !dirPath.startsWith(`${normalized}/`)) {
        continue;
      }
      const remainder = dirPath.slice(normalized.length + 1);
      if (remainder.length > 0) {
        entries.add(remainder.split("/")[0]);
      }
    }

    return [...entries].sort();
  }

  async rm(path: string): Promise<void> {
    const normalized = normalizePath(path);
    this.files.delete(normalized);
  }

  async search(path: string, query: string): Promise<FsSearchBackendResult> {
    const normalized = normalizePath(path);
    const matches: FsSearchBackendResult["matches"] = [];

    for (const [filePath, text] of [...this.files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      if (!filePath.startsWith(`${normalized}/`) && filePath !== normalized) {
        continue;
      }
      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index++) {
        if (lines[index].includes(query)) {
          matches.push({
            path: filePath,
            line: index + 1,
            content: lines[index],
          });
        }
      }
    }

    return { matches };
  }

  private addParentDirectories(path: string): void {
    const normalized = normalizePath(path);
    const parts = normalized.split("/").filter(Boolean);
    let current = "";
    for (const part of parts.slice(0, -1)) {
      current = `${current}/${part}`;
      this.directories.add(current);
    }
  }
}

function normalizeRepoPath(path: string): string {
  const normalized = normalizePath(path.startsWith("/") ? path : `/${path}`);
  return normalized === "/" ? "" : normalized.slice(1);
}

function isWithinRepoPrefix(path: string, prefix: string): boolean {
  if (!prefix) {
    return true;
  }
  return path.startsWith(`${prefix}/`);
}

function makeStat(isFile: boolean, size: number): ExtendedMountStat {
  return {
    isFile,
    isDirectory: !isFile,
    isSymbolicLink: false,
    mode: isFile ? 0o644 : 0o755,
    size,
    mtime: new Date(),
    uid: IDENTITY.uid,
    gid: IDENTITY.gid,
  };
}

function compileGlob(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
}
