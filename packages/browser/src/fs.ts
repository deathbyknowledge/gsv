import { z } from "zod";
import type { GsvBody, GsvResponse } from "@humansandmachines/gsv/client";
import {
  bodyFromBytes,
  bodyFromText,
  inferFsContentType,
  isTextContentType,
} from "@humansandmachines/gsv/protocol";
import type {
  FsCopyArgs,
  FsReadArgs,
  FsWriteArgs,
  FsEditArgs,
  FsDeleteArgs,
  FsSearchArgs,
  FsTransferStatArgs,
  FsTransferSendArgs,
  FsTransferReceiveArgs,
  FsCopyResult,
  FsDeleteResult,
  FsEditResult,
  FsSearchResult,
  FsTransferStatResult,
  FsWriteResult,
} from "@humansandmachines/gsv/protocol";
import { basename, dirname, joinPath, normalizePath } from "./paths";
import {
  bytesFromStoredContent,
  bytesToArrayBuffer,
  storedFsMetadata,
  type FilePersistence,
  type StoredFsEntry,
  type StoredFsMetadata,
} from "./fs-persistence";
import { throwIfAborted } from "./abort";
import type { BrowserValue } from "./backend";
import type { FileStat, TargetFileSystem } from "./types";

const pathSchema = z.string().refine(path => path.trim().length > 0, "path is required").transform(path => normalizePath(path));
const copyEndpointSchema = z.object({ path: pathSchema, target: z.string().trim().optional() });
const fsReadSchema = z.object({
  path: pathSchema,
  representation: z.enum(["content", "resource", "reference"]).optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().nonnegative().optional(),
});
const fsWriteSchema = z.object({ path: pathSchema, content: z.string() });
const fsEditSchema = z.object({ path: pathSchema, oldString: z.string(), newString: z.string(), replaceAll: z.boolean().optional() });
const fsPathSchema = z.object({ path: pathSchema });
const fsSearchSchema = z.object({ query: z.string().trim().min(1), path: pathSchema.optional(), include: z.string().trim().optional() });
const fsCopySchema = z.object({ source: copyEndpointSchema, destination: copyEndpointSchema });
const fsTransferSendSchema = z.object({ path: pathSchema, revision: z.string().optional() });
const fsTransferReceiveSchema = z.object({ path: pathSchema, contentType: z.string().optional() });

/** A browser file has no inode; its revision is its content. */
async function contentRevision(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const MAX_SEARCH_MATCHES = 200;
const DEFAULT_DIRECTORIES = [
  "/",
  "/dev",
  "/home",
  "/home/browser",
  "/home/browser/recordings",
  "/home/browser/screenshots",
  "/tmp",
];

export class BrowserTargetFileSystem implements TargetFileSystem {
  private files = new Map<string, { size: number; contentType?: string; content?: Uint8Array }>();
  private directories = new Set<string>(DEFAULT_DIRECTORIES);
  private loadPromise: Promise<void> | null = null;
  private backend: FilePersistence | null = null;

  constructor(
    private readonly runtime: TargetFileSystem,
    private readonly openPersistence: () => Promise<FilePersistence | null> = async () => null,
    readonly maxFileBytes = Number.POSITIVE_INFINITY,
  ) {}

  async read(path: string): Promise<Uint8Array> {
    await this.ensureLoaded();
    const normalized = normalizePath(path);
    if (normalized === "/dev/null") return new Uint8Array();
    if (await this.runtime.exists(normalized)) {
      return await this.runtime.read(normalized);
    }
    if (this.backend) {
      const entry = await this.backend.get(normalized);
      if (entry) this.applyPersistedEntry(storedFsMetadata(entry));
      else this.files.delete(normalized);
      if (entry?.kind === "file") return bytesFromStoredContent(entry.content);
      throw new Error(`No such file: ${normalized}`);
    }
    const value = this.files.get(normalized)?.content;
    if (!value) {
      throw new Error(`No such file: ${normalized}`);
    }
    return value;
  }

  async write(path: string, content: Uint8Array, contentType?: string): Promise<void> {
    await this.ensureLoaded();
    const normalized = normalizePath(path);
    if (normalized === "/dev/null") return;
    this.assertWritable(normalized);
    this.assertFileSize(content.byteLength);
    await this.assertNotDirectory(normalized);
    await this.ensureDirectory(dirname(normalized));
    const resolvedContentType = contentType ?? inferFsContentType(normalized);
    const entry: StoredFsEntry = {
      path: normalized,
      kind: "file",
      content: bytesToArrayBuffer(content),
      contentType: resolvedContentType,
      updatedAt: Date.now(),
    };
    await this.persistEntry(entry);
    this.files.set(normalized, {
      size: content.byteLength, contentType: resolvedContentType,
      // Persistent backends own bytes; only the memory fallback retains them here.
      content: this.backend ? undefined : new Uint8Array(entry.content),
    });
  }

  async append(path: string, content: Uint8Array): Promise<void> {
    await this.ensureLoaded();
    const normalized = normalizePath(path);
    await this.assertNotDirectory(normalized);
    const current = await this.exists(normalized) ? await this.read(normalized) : new Uint8Array();
    this.assertFileSize(current.byteLength + content.byteLength);
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
    if (this.files.has(normalized)) {
      await this.deletePersistedEntries([normalized]);
      this.files.delete(normalized);
      return;
    }
    if (this.directories.has(normalized)) {
      const deletedPaths = [normalized];
      for (const file of Array.from(this.files.keys())) {
        if (file.startsWith(`${normalized}/`)) {
          deletedPaths.push(file);
        }
      }
      for (const dir of Array.from(this.directories.values())) {
        if (dir !== normalized && dir.startsWith(`${normalized}/`)) {
          deletedPaths.push(dir);
        }
      }
      await this.deletePersistedEntries(deletedPaths);
      for (const path of deletedPaths) {
        this.files.delete(path);
        this.directories.delete(path);
      }
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
    if (normalized === "/dev") mergedFiles.add("null");

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
    if (normalized === "/dev/null") return { path: normalized, isFile: true, isDirectory: false, size: 0, contentType: "application/octet-stream" };
    if (await this.runtime.exists(normalized)) {
      return await this.runtime.stat(normalized);
    }
    await this.refreshPersistedEntry(normalized);
    if (this.directories.has(normalized)) {
      return { path: normalized, isFile: false, isDirectory: true, size: 0 };
    }
    const value = this.files.get(normalized);
    if (value !== undefined) {
      return {
        path: normalized,
        isFile: true,
        isDirectory: false,
        size: value.size,
        contentType: value.contentType ?? inferFsContentType(normalized),
      };
    }
    throw new Error(`No such file or directory: ${normalized}`);
  }

  async exists(path: string): Promise<boolean> {
    await this.ensureLoaded();
    const normalized = normalizePath(path);
    if (normalized === "/dev/null") return true;
    if (await this.runtime.exists(normalized)) {
      return true;
    }
    await this.refreshPersistedEntry(normalized);
    return this.files.has(normalized) || this.directories.has(normalized);
  }

  async search(path: string, query: string, include?: string, signal?: AbortSignal): Promise<Array<{ path: string; line: number; content: string }>> {
    await this.ensureLoaded();
    throwIfAborted(signal);
    const normalized = normalizePath(path);
    if (isRuntimeSearchPath(normalized)) {
      return await this.runtime.search(normalized, query, include, signal);
    }
    const matches: Array<{ path: string; line: number; content: string }> = [];
    const allPaths = await this.getAllPaths();

    for (const candidate of allPaths) {
      throwIfAborted(signal);
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
      if (!stat.isFile || !isTextContentType(stat.contentType ?? inferFsContentType(candidate))) {
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
      "/dev/null",
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
    this.backend = await this.openPersistence();
    if (!this.backend) {
      return;
    }

    await this.refreshPersistedEntries();
  }

  private async refreshPersistedEntries(): Promise<void> {
    if (!this.backend) {
      return;
    }
    const entries = await this.backend.list();
    this.files.clear();
    this.directories = new Set(DEFAULT_DIRECTORIES);
    for (const entry of entries) {
      this.applyPersistedEntry(entry);
    }
  }

  private async refreshPersistedEntry(path: string): Promise<void> {
    if (!this.backend) {
      return;
    }
    const entry = await this.backend.stat(normalizePath(path));
    if (entry) {
      this.applyPersistedEntry(entry);
    } else this.files.delete(path);
  }

  private applyPersistedEntry(entry: StoredFsMetadata): void {
    const path = normalizePath(entry.path);
    if (entry.kind === "directory") {
      this.directories.add(path);
      this.files.delete(path);
      return;
    }
    this.ensureDirectorySync(dirname(path));
    this.directories.delete(path);
    this.files.set(path, { size: entry.size, contentType: entry.contentType });
  }

  private async ensureDirectory(path: string): Promise<void> {
    let directory = "";
    for (const part of normalizePath(path).split("/")) {
      if (!part) continue;
      directory += `/${part}`;
      if (this.directories.has(directory)) continue;
      await this.persistEntry({
        path: directory,
        kind: "directory",
        updatedAt: Date.now(),
      });
      this.directories.add(directory);
    }
  }

  private assertFileSize(size: number): void {
    if (size > this.maxFileBytes) throw new Error(`Browser file exceeds the ${this.maxFileBytes} byte limit`);
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
    if (!this.backend) {
      return;
    }
    await this.backend.put(entry);
  }

  private async deletePersistedEntries(paths: string[]): Promise<void> {
    if (!this.backend) {
      return;
    }
    await this.backend.delete(paths);
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

function isRuntimeSearchPath(path: string): boolean {
  return path === "/README.txt"
    || path === "/dev"
    || path.startsWith("/dev/")
    || path === "/proc"
    || path.startsWith("/proc/");
}

export class BrowserFsDriver {
  constructor(
    private readonly fs: TargetFileSystem,
    /** This target's own id, named in the references it hands out. */
    private readonly targetId: () => Promise<string> = async () => "browser",
  ) {}

  async handle(call: string, args: BrowserValue, body?: GsvBody, signal?: AbortSignal): Promise<GsvResponse> {
    switch (call) {
      case "fs.read":
        return await this.read(fsReadSchema.parse(args));
      case "fs.write":
        return { data: await this.write(fsWriteSchema.parse(args)) };
      case "fs.edit":
        return { data: await this.edit(fsEditSchema.parse(args)) };
      case "fs.delete":
        return { data: await this.delete(fsPathSchema.parse(args)) };
      case "fs.search":
        return { data: await this.search(fsSearchSchema.parse(args), signal) };
      case "fs.copy":
        return { data: await this.copy(fsCopySchema.parse(args)) };
      case "fs.transfer.stat":
        return { data: await this.transferStat(fsPathSchema.parse(args)) };
      case "fs.transfer.send":
        return await this.transferSend(fsTransferSendSchema.parse(args));
      case "fs.transfer.receive":
        return await this.transferReceive(fsTransferReceiveSchema.parse(args), body);
      default:
        throw new Error(`Unsupported filesystem syscall: ${call}`);
    }
  }

  private async read(args: FsReadArgs): Promise<GsvResponse> {
    const path = args.path;
    try {
      const stat = await this.fs.stat(path);
      if (stat.isDirectory) {
        return { data: { ok: true, path, ...await this.fs.list(path) } };
      }

      const bytes = await this.fs.read(path);
      const contentType = stat.contentType ?? inferFsContentType(path);
      const isImage = contentType.trim().toLowerCase().startsWith("image/") && !isTextContentType(contentType);
      // `reference` answers any file with its immutable reference alone, the thing a message or a transfer works from
      const resource = args.representation === "reference"
        ? {
          type: "file" as const,
          target: await this.targetId(),
          path,
          revision: await contentRevision(bytes),
          contentType,
          size: bytes.byteLength,
        }
        : null;
      if (resource) {
        return {
          data: {
            ok: true,
            path,
            size: bytes.byteLength,
            kind: isImage ? "image" : isTextContentType(contentType) ? "text" : "file",
            contentType,
            resource,
          },
        };
      }
      if (isImage) {
        return {
          data: {
            ok: true,
            path,
            size: bytes.byteLength,
            kind: "image",
            contentType,
          },
          body: bodyFromBytes(bytes),
        };
      }
      if (!isTextContentType(contentType)) {
        return { data: { ok: false, error: `Binary file (${contentType}, ${formatSize(bytes.byteLength)})` } };
      }

      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return { data: { ok: false, error: `Binary file (${contentType}, ${formatSize(bytes.byteLength)})` } };
      }
      const offset = args.offset ?? 0;
      const limit = args.limit ?? null;
      const lines = text.split("\n");
      const selected = limit === null ? lines.slice(offset) : lines.slice(offset, offset + limit);
      return {
        data: {
          ok: true,
          path,
          size: bytes.byteLength,
          kind: "text",
          contentType,
          lines: selected.length,
        },
        body: bodyFromText(selected.join("\n")),
      };
    } catch (error) {
      return { data: { ok: false, error: error instanceof Error ? error.message : String(error) } };
    }
  }

  private async write(args: FsWriteArgs): Promise<FsWriteResult> {
    const path = args.path;
    const bytes = textEncoder.encode(args.content);
    await this.fs.write(path, bytes);
    return { ok: true, path, size: bytes.byteLength };
  }

  private async edit(args: FsEditArgs): Promise<FsEditResult> {
    const path = args.path;
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

  private async delete(args: FsDeleteArgs): Promise<FsDeleteResult> {
    const path = args.path;
    await this.fs.delete(path);
    return { ok: true, path };
  }

  private async search(args: FsSearchArgs, signal?: AbortSignal): Promise<FsSearchResult> {
    const query = args.query;
    if (!query) {
      return { ok: false, error: "fs.search requires query" };
    }
    const path = args.path ?? "/";
    const include = args.include || undefined;
    const matches = await this.fs.search(path, query, include, signal);
    return { ok: true, matches, count: matches.length, truncated: matches.length >= MAX_SEARCH_MATCHES };
  }

  private async copy(args: FsCopyArgs): Promise<FsCopyResult> {
    const { source, destination } = args;
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

  private async transferStat(args: FsTransferStatArgs): Promise<FsTransferStatResult> {
    const path = args.path;
    try {
      const stat = await this.fs.stat(path);
      const revision = stat.isFile ? await contentRevision(await this.fs.read(path)) : undefined;
      return {
        ok: true,
        path,
        size: stat.size,
        isFile: stat.isFile,
        isDirectory: stat.isDirectory,
        contentType: stat.contentType ?? inferFsContentType(path),
        revision,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async transferSend(args: FsTransferSendArgs): Promise<GsvResponse> {
    const path = args.path;
    const bytes = await this.fs.read(path);
    const stat = await this.fs.stat(path);
    const revision = await contentRevision(bytes);
    if (args.revision !== undefined && args.revision !== revision) {
      return { data: { ok: false, error: `Source revision is no longer available: ${path}` } };
    }
    return {
      data: {
        ok: true,
        path,
        size: bytes.byteLength,
        contentType: stat.contentType ?? inferFsContentType(path),
        revision,
      },
      body: bodyFromBytes(bytes),
    };
  }

  private async transferReceive(args: FsTransferReceiveArgs, body?: GsvBody): Promise<GsvResponse> {
    const path = args.path;
    if (!body) {
      return { data: { ok: false, error: "fs.transfer.receive requires a request body" } };
    }
    try {
      if (body.length === undefined) throw new Error("fs.transfer.receive requires a request body length");
      if (!Number.isSafeInteger(body.length) || body.length < 0) throw new Error("Invalid transfer body length");
      const limit = this.fs.maxFileBytes ?? Number.POSITIVE_INFINITY;
      if (body.length > limit) throw new Error(`Browser file exceeds the ${limit} byte limit`);
      const bytes = await readStream(body.stream, body.length);
      const contentType = args.contentType ?? inferFsContentType(path);
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
      await body.stream.cancel(error instanceof Error ? error.message : "Binary transfer failed").catch(() => {});
      return { data: { ok: false, error: error instanceof Error ? error.message : String(error) } };
    }
  }
}

async function readStream(stream: ReadableStream<Uint8Array>, expectedSize: number): Promise<Uint8Array> {
  const output = new Uint8Array(expectedSize);
  const reader = stream.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (value.byteLength > expectedSize - size) {
        throw new Error(`Transfer size mismatch: expected ${expectedSize}, got at least ${size + value.byteLength}`);
      }
      output.set(value, size);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (size !== expectedSize) {
    throw new Error(`Transfer size mismatch: expected ${expectedSize}, got ${size}`);
  }
  return output;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}
