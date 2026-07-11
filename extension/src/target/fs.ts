import type { GsvBody, GsvResponse } from "@humansandmachines/gsv/client";
import { basename, dirname, joinPath, normalizePath } from "../shared/paths";
import {
  bytesFromStoredContent,
  bytesToArrayBuffer,
  deletePersistedEntries,
  getPersistedEntries,
  getPersistedEntry,
  openPersistenceBackend,
  putPersistedEntry,
  type FsPersistenceBackend,
  type StoredFsEntry,
} from "./fs-persistence";
import type { FileStat, TargetFileSystem } from "./types";

type FsReadArgs = {
  path?: unknown;
  offset?: unknown;
  limit?: unknown;
};

type FsWriteArgs = {
  path?: unknown;
  content?: unknown;
};

type FsEditArgs = {
  path?: unknown;
  oldString?: unknown;
  newString?: unknown;
  replaceAll?: unknown;
};

type FsDeleteArgs = {
  path?: unknown;
};

type FsSearchArgs = {
  path?: unknown;
  query?: unknown;
  include?: unknown;
};

type FsCopyEndpoint = {
  target?: string;
  path?: string;
};

type FsCopyArgs = {
  source?: FsCopyEndpoint;
  destination?: FsCopyEndpoint;
};

type TransferArgs = {
  path?: unknown;
  contentType?: unknown;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const MAX_TEXT_READ_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_MATCHES = 200;
const DEFAULT_DIRECTORIES = [
  "/",
  "/home",
  "/home/browser",
  "/home/browser/recordings",
  "/home/browser/screenshots",
  "/tmp",
];

export class BrowserTargetFileSystem implements TargetFileSystem {
  private files = new Map<string, Uint8Array>();
  private contentTypes = new Map<string, string>();
  private directories = new Set<string>(DEFAULT_DIRECTORIES);
  private loadPromise: Promise<void> | null = null;
  private backend: FsPersistenceBackend = { kind: "memory" };

  constructor(private readonly runtime: TargetFileSystem) {}

  async read(path: string): Promise<Uint8Array> {
    await this.ensureLoaded();
    const normalized = normalizePath(path);
    if (await this.runtime.exists(normalized)) {
      return await this.runtime.read(normalized);
    }
    await this.refreshPersistedEntry(normalized);
    const value = this.files.get(normalized);
    if (!value) {
      throw new Error(`No such file: ${normalized}`);
    }
    return value;
  }

  async write(path: string, content: Uint8Array, contentType?: string): Promise<void> {
    await this.ensureLoaded();
    const normalized = normalizePath(path);
    this.assertWritable(normalized);
    await this.assertNotDirectory(normalized);
    await this.ensureDirectory(dirname(normalized));
    this.files.set(normalized, copyBytes(content));
    const resolvedContentType = contentType ?? inferContentType(normalized);
    this.contentTypes.set(normalized, resolvedContentType);
    await this.persistEntry({
      path: normalized,
      kind: "file",
      content: bytesToArrayBuffer(content),
      contentType: resolvedContentType,
      updatedAt: Date.now(),
    });
  }

  async append(path: string, content: Uint8Array): Promise<void> {
    await this.ensureLoaded();
    const normalized = normalizePath(path);
    await this.assertNotDirectory(normalized);
    const current = await this.exists(normalized) ? await this.read(normalized) : new Uint8Array();
    const next = new Uint8Array(current.byteLength + content.byteLength);
    next.set(current, 0);
    next.set(content, current.byteLength);
    await this.write(normalized, next);
  }

  async delete(path: string): Promise<void> {
    await this.ensureLoaded();
    const normalized = normalizePath(path);
    this.assertWritable(normalized);
    await this.refreshPersistedEntries();
    if (normalized === "/") {
      throw new Error("Refusing to delete /");
    }
    if (this.files.delete(normalized)) {
      this.contentTypes.delete(normalized);
      await this.deletePersistedEntries([normalized]);
      return;
    }
    if (this.directories.has(normalized)) {
      const deletedPaths = [normalized];
      for (const file of Array.from(this.files.keys())) {
        if (file.startsWith(`${normalized}/`)) {
          this.files.delete(file);
          this.contentTypes.delete(file);
          deletedPaths.push(file);
        }
      }
      for (const dir of Array.from(this.directories.values())) {
        if (dir !== normalized && dir.startsWith(`${normalized}/`)) {
          this.directories.delete(dir);
          deletedPaths.push(dir);
        }
      }
      this.directories.delete(normalized);
      await this.deletePersistedEntries(deletedPaths);
      return;
    }
    throw new Error(`No such file or directory: ${normalized}`);
  }

  async mkdir(path: string): Promise<void> {
    await this.ensureLoaded();
    const normalized = normalizePath(path);
    this.assertWritable(normalized);
    await this.ensureDirectory(normalized);
  }

  async copy(source: string, destination: string): Promise<string> {
    await this.ensureLoaded();
    const sourcePath = normalizePath(source);
    const destinationPath = normalizePath(destination);
    const sourceStat = await this.stat(sourcePath);
    if (!sourceStat.isFile) {
      throw new Error(`Source is not a file: ${sourcePath}`);
    }
    let finalDestination = destinationPath;
    if (await this.exists(destinationPath)) {
      const destinationStat = await this.stat(destinationPath);
      if (destinationStat.isDirectory) {
        finalDestination = joinPath(destinationPath, basename(sourcePath));
      }
    }
    await this.write(finalDestination, await this.read(sourcePath), sourceStat.contentType);
    return finalDestination;
  }

  async move(source: string, destination: string): Promise<void> {
    await this.copy(source, destination);
    await this.delete(source);
  }

  async list(path: string): Promise<{ files: string[]; directories: string[] }> {
    await this.ensureLoaded();
    await this.refreshPersistedEntries();
    const normalized = normalizePath(path);
    const mergedFiles = new Set<string>();
    const mergedDirectories = new Set<string>();

    if (await this.runtime.exists(normalized)) {
      const runtimeEntries = await this.runtime.list(normalized);
      for (const file of runtimeEntries.files) mergedFiles.add(file);
      for (const dir of runtimeEntries.directories) mergedDirectories.add(dir);
    }

    if (this.directories.has(normalized)) {
      for (const dir of this.directories) {
        if (dir === normalized) continue;
        if (dirname(dir) === normalized) {
          mergedDirectories.add(basename(dir));
        }
      }
      for (const file of this.files.keys()) {
        if (dirname(file) === normalized) {
          mergedFiles.add(basename(file));
        }
      }
    }

    if (mergedFiles.size === 0 && mergedDirectories.size === 0 && !(await this.exists(normalized))) {
      throw new Error(`No such directory: ${normalized}`);
    }

    return {
      files: Array.from(mergedFiles).sort(),
      directories: Array.from(mergedDirectories).sort(),
    };
  }

  async stat(path: string): Promise<FileStat> {
    await this.ensureLoaded();
    const normalized = normalizePath(path);
    if (await this.runtime.exists(normalized)) {
      return await this.runtime.stat(normalized);
    }
    if (this.directories.has(normalized)) {
      return { path: normalized, isFile: false, isDirectory: true, size: 0 };
    }
    await this.refreshPersistedEntry(normalized);
    const value = this.files.get(normalized);
    if (value !== undefined) {
      return {
        path: normalized,
        isFile: true,
        isDirectory: false,
        size: value.byteLength,
        contentType: this.contentTypes.get(normalized) ?? inferContentType(normalized),
      };
    }
    throw new Error(`No such file or directory: ${normalized}`);
  }

  async exists(path: string): Promise<boolean> {
    await this.ensureLoaded();
    const normalized = normalizePath(path);
    if (this.files.has(normalized) || this.directories.has(normalized) || await this.runtime.exists(normalized)) {
      return true;
    }
    await this.refreshPersistedEntry(normalized);
    return this.files.has(normalized) || this.directories.has(normalized);
  }

  async search(path: string, query: string, include?: string): Promise<Array<{ path: string; line: number; content: string }>> {
    await this.ensureLoaded();
    const normalized = normalizePath(path);
    const matches: Array<{ path: string; line: number; content: string }> = [];
    const allPaths = await this.getAllPaths();

    for (const candidate of allPaths) {
      if (!candidate.startsWith(normalized === "/" ? "/" : `${normalized}/`) && candidate !== normalized) {
        continue;
      }
      if (include && !candidate.includes(include)) {
        continue;
      }
      let stat: FileStat;
      try {
        stat = await this.stat(candidate);
      } catch {
        continue;
      }
      if (!stat.isFile || !isTextContentType(stat.contentType ?? inferContentType(candidate))) {
        continue;
      }
      const text = textDecoder.decode(await this.read(candidate));
      const lines = text.split("\n");
      for (const [index, line] of lines.entries()) {
        if (line.includes(query)) {
          matches.push({ path: candidate, line: index + 1, content: line });
          if (matches.length >= MAX_SEARCH_MATCHES) {
            return matches;
          }
        }
      }
    }

    return matches;
  }

  resolvePath(cwd: string, path: string): string {
    return normalizePath(path, normalizePath(cwd));
  }

  async getAllPaths(): Promise<string[]> {
    await this.ensureLoaded();
    await this.refreshPersistedEntries();
    return Array.from(new Set([
      ...this.directories,
      ...this.files.keys(),
      ...await this.runtime.getAllPaths(),
    ])).sort();
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.loadPersistedEntries();
    }
    await this.loadPromise;
  }

  private async loadPersistedEntries(): Promise<void> {
    this.backend = await openPersistenceBackend();
    if (this.backend.kind !== "indexeddb") {
      return;
    }

    await this.refreshPersistedEntries();
  }

  private async refreshPersistedEntries(): Promise<void> {
    if (this.backend.kind !== "indexeddb") {
      return;
    }
    const entries = await getPersistedEntries(this.backend.db);
    for (const entry of entries) {
      this.applyPersistedEntry(entry);
    }
    for (const directory of DEFAULT_DIRECTORIES) {
      this.directories.add(directory);
    }
  }

  private async refreshPersistedEntry(path: string): Promise<void> {
    if (this.backend.kind !== "indexeddb") {
      return;
    }
    const entry = await getPersistedEntry(this.backend.db, normalizePath(path));
    if (entry) {
      this.applyPersistedEntry(entry);
    }
  }

  private applyPersistedEntry(entry: StoredFsEntry): void {
    const path = normalizePath(entry.path);
    if (entry.kind === "directory") {
      this.directories.add(path);
      this.files.delete(path);
      this.contentTypes.delete(path);
      return;
    }
    this.ensureDirectorySync(dirname(path));
    this.files.set(path, bytesFromStoredContent(entry.content));
    if (entry.contentType) {
      this.contentTypes.set(path, entry.contentType);
    } else {
      this.contentTypes.delete(path);
    }
  }

  private async ensureDirectory(path: string): Promise<void> {
    const added = this.ensureDirectorySync(path);
    for (const directory of added) {
      await this.persistEntry({
        path: directory,
        kind: "directory",
        updatedAt: Date.now(),
      });
    }
  }

  private ensureDirectorySync(path: string): string[] {
    const normalized = normalizePath(path);
    const parts = normalized.split("/");
    let current = "";
    const added: string[] = [];
    for (const part of parts) {
      if (!part) continue;
      current = `${current}/${part}`;
      if (!this.directories.has(current)) {
        this.directories.add(current);
        added.push(current);
      }
    }
    if (!this.directories.has("/")) {
      this.directories.add("/");
      added.unshift("/");
    }
    return added;
  }

  private async persistEntry(entry: StoredFsEntry): Promise<void> {
    if (this.backend.kind !== "indexeddb") {
      return;
    }
    await putPersistedEntry(this.backend.db, entry);
  }

  private async deletePersistedEntries(paths: string[]): Promise<void> {
    if (this.backend.kind !== "indexeddb") {
      return;
    }
    await deletePersistedEntries(this.backend.db, paths);
  }

  private assertWritable(path: string): void {
    const normalized = normalizePath(path);
    if (!isWritablePath(normalized)) {
      throw new Error(`Read-only path: ${normalized}`);
    }
  }

  private async assertNotDirectory(path: string): Promise<void> {
    let stat: FileStat;
    try {
      stat = await this.stat(path);
    } catch {
      return;
    }
    if (stat.isDirectory) {
      throw new Error(`Is a directory: ${path}`);
    }
  }
}

function isWritablePath(path: string): boolean {
  return path === "/tmp"
    || path.startsWith("/tmp/")
    || path === "/home/browser"
    || path.startsWith("/home/browser/");
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

export class BrowserFsDriver {
  constructor(private readonly fs: TargetFileSystem) {}

  async handle(call: string, args: unknown, body?: GsvBody): Promise<GsvResponse> {
    switch (call) {
      case "fs.read":
        return { data: await this.read(args) };
      case "fs.write":
        return { data: await this.write(args) };
      case "fs.edit":
        return { data: await this.edit(args) };
      case "fs.delete":
        return { data: await this.delete(args) };
      case "fs.search":
        return { data: await this.search(args) };
      case "fs.copy":
        return { data: await this.copy(args) };
      case "fs.transfer.stat":
        return { data: await this.transferStat(args) };
      case "fs.transfer.send":
        return await this.transferSend(args);
      case "fs.transfer.receive":
        return await this.transferReceive(args, body);
      default:
        throw new Error(`Unsupported filesystem syscall: ${call}`);
    }
  }

  private async read(raw: unknown): Promise<unknown> {
    const args = asRecord(raw) as FsReadArgs;
    const path = parsePath(args.path, "fs.read");
    const stat = await this.fs.stat(path);
    if (stat.isDirectory) {
      return { ok: true, path, ...await this.fs.list(path) };
    }

    const bytes = await this.fs.read(path);
    const contentType = stat.contentType ?? inferContentType(path);
    if (contentType.startsWith("image/")) {
      return {
        ok: true,
        path,
        size: bytes.byteLength,
        content: [{ type: "image", data: bytesToBase64(bytes), mimeType: contentType }],
      };
    }
    if (!isTextContentType(contentType)) {
      return { ok: false, error: `Binary file (${contentType}, ${formatSize(bytes.byteLength)})` };
    }
    if (bytes.byteLength > MAX_TEXT_READ_BYTES) {
      return { ok: false, error: `Text file too large (${formatSize(bytes.byteLength)})` };
    }

    const offset = parseNonNegativeInteger(args.offset) ?? 0;
    const limit = parseNonNegativeInteger(args.limit);
    const lines = textDecoder.decode(bytes).split("\n");
    const selected = limit === null ? lines.slice(offset) : lines.slice(offset, offset + limit);
    return {
      ok: true,
      path,
      size: bytes.byteLength,
      lines: lines.length,
      content: selected.join("\n"),
    };
  }

  private async write(raw: unknown): Promise<unknown> {
    const args = asRecord(raw) as FsWriteArgs;
    const path = parsePath(args.path, "fs.write");
    if (typeof args.content !== "string") {
      return { ok: false, error: "fs.write requires string content" };
    }
    const bytes = textEncoder.encode(args.content);
    await this.fs.write(path, bytes);
    return { ok: true, path, size: bytes.byteLength };
  }

  private async edit(raw: unknown): Promise<unknown> {
    const args = asRecord(raw) as FsEditArgs;
    const path = parsePath(args.path, "fs.edit");
    if (typeof args.oldString !== "string" || typeof args.newString !== "string") {
      return { ok: false, error: "fs.edit requires oldString and newString" };
    }
    const oldText = textDecoder.decode(await this.fs.read(path));
    const count = oldText.split(args.oldString).length - 1;
    if (count === 0) {
      return { ok: false, error: `oldString not found in ${path}` };
    }
    if (count > 1 && args.replaceAll !== true) {
      return { ok: false, error: `oldString found ${count} times. Use replaceAll or provide more context.` };
    }
    const next = args.replaceAll === true
      ? oldText.replaceAll(args.oldString, args.newString)
      : oldText.replace(args.oldString, args.newString);
    await this.fs.write(path, textEncoder.encode(next));
    return { ok: true, path, replacements: args.replaceAll === true ? count : 1 };
  }

  private async delete(raw: unknown): Promise<unknown> {
    const args = asRecord(raw) as FsDeleteArgs;
    const path = parsePath(args.path, "fs.delete");
    await this.fs.delete(path);
    return { ok: true, path };
  }

  private async search(raw: unknown): Promise<unknown> {
    const args = asRecord(raw) as FsSearchArgs;
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return { ok: false, error: "fs.search requires query" };
    }
    const path = typeof args.path === "string" && args.path.trim() ? normalizePath(args.path) : "/";
    const include = typeof args.include === "string" && args.include.trim() ? args.include.trim() : undefined;
    const matches = await this.fs.search(path, query, include);
    return { ok: true, matches, count: matches.length, truncated: matches.length >= MAX_SEARCH_MATCHES };
  }

  private async copy(raw: unknown): Promise<unknown> {
    const args = asRecord(raw) as FsCopyArgs;
    const source = parseCopyEndpoint(args.source, "source");
    const destination = parseCopyEndpoint(args.destination, "destination");
    const destinationPath = await this.fs.copy(source.path, destination.path);
    const stat = await this.fs.stat(destinationPath);
    return {
      ok: true,
      source: { target: source.target ?? "local", path: source.path },
      destination: { target: destination.target ?? "local", path: destinationPath },
      size: stat.size,
      contentType: stat.contentType,
    };
  }

  private async transferStat(raw: unknown): Promise<unknown> {
    const args = asRecord(raw) as TransferArgs;
    const path = parsePath(args.path, "fs.transfer.stat");
    try {
      const stat = await this.fs.stat(path);
      return {
        ok: true,
        path,
        size: stat.size,
        isFile: stat.isFile,
        isDirectory: stat.isDirectory,
        contentType: stat.contentType ?? inferContentType(path),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async transferSend(raw: unknown): Promise<GsvResponse> {
    const args = asRecord(raw) as TransferArgs;
    const path = parsePath(args.path, "fs.transfer.send");
    const bytes = await this.fs.read(path);
    const stat = await this.fs.stat(path);
    return {
      data: {
        ok: true,
        path,
        size: bytes.byteLength,
        contentType: stat.contentType ?? inferContentType(path),
      },
      body: {
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        length: bytes.byteLength,
      },
    };
  }

  private async transferReceive(raw: unknown, body?: GsvBody): Promise<GsvResponse> {
    const args = asRecord(raw) as TransferArgs;
    const path = parsePath(args.path, "fs.transfer.receive");
    if (!body) {
      return { data: { ok: false, error: "fs.transfer.receive requires a request body" } };
    }
    if (body.length === undefined) {
      void body.stream.cancel();
      return { data: { ok: false, error: "fs.transfer.receive requires a request body length" } };
    }

    try {
      const bytes = await readStream(body.stream, body.length);
      const contentType = typeof args.contentType === "string" ? args.contentType : inferContentType(path);
      await this.fs.write(path, bytes, contentType);
      return {
        data: {
          ok: true,
          path,
          bytesWritten: bytes.byteLength,
          contentType,
        },
      };
    } catch (error) {
      void body.stream.cancel(error instanceof Error ? error.message : "Binary transfer failed");
      return { data: { ok: false, error: error instanceof Error ? error.message : String(error) } };
    }
  }
}

function parsePath(value: unknown, call: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${call} requires path`);
  }
  return normalizePath(value);
}

function parseCopyEndpoint(value: unknown, label: string): { target?: string; path: string } {
  const record = asRecord(value) as FsCopyEndpoint;
  if (!record || typeof record.path !== "string" || !record.path.trim()) {
    throw new Error(`fs.copy requires ${label}.path`);
  }
  return {
    ...(typeof record.target === "string" && record.target.trim() ? { target: record.target.trim() } : {}),
    path: normalizePath(record.path),
  };
}

function parseNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
}

async function readStream(stream: ReadableStream<Uint8Array>, expectedSize: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > expectedSize) {
        throw new Error(`Transfer size mismatch: expected ${expectedSize}, got more than ${size}`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size !== expectedSize) {
    throw new Error(`Transfer size mismatch: expected ${expectedSize}, got ${size}`);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function inferContentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".webm")) return "audio/webm";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".ts")) return "text/javascript";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain";
  return "application/octet-stream";
}

function isTextContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  return normalized.startsWith("text/")
    || normalized === "application/json"
    || normalized.endsWith("+json")
    || normalized === "application/javascript"
    || normalized === "application/x-javascript"
    || normalized === "image/svg+xml";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
