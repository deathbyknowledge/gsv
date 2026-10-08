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

  async read(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    await this.ensureLoaded();
    throwIfAborted(signal);
    const normalized = normalizePath(path);
    if (normalized === "/dev/null") return new Uint8Array();
    if (await this.runtime.exists(normalized, signal)) {
      throwIfAborted(signal);
      const bytes = await this.runtime.read(normalized, signal);
      throwIfAborted(signal);
      return bytes;
    }
    if (this.backend) {
      const entry = await this.backend.get(normalized);
      throwIfAborted(signal);
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

  async write(path: string, content: Uint8Array, contentType?: string, signal?: AbortSignal): Promise<void> {
    await this.ensureLoaded();
    throwIfAborted(signal);
    const normalized = normalizePath(path);
    if (normalized === "/dev/null") return;
    this.assertWritable(normalized);
    this.assertFileSize(content.byteLength);
    await this.assertNotDirectory(normalized, signal);
    throwIfAborted(signal);
    await this.ensureDirectory(dirname(normalized), signal);
    throwIfAborted(signal);
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

  async append(path: string, content: Uint8Array, signal?: AbortSignal): Promise<void> {
    await this.ensureLoaded();
    throwIfAborted(signal);
    const normalized = normalizePath(path);
    await this.assertNotDirectory(normalized, signal);
    throwIfAborted(signal);
    const current = await this.exists(normalized, signal) ? await this.read(normalized, signal) : new Uint8Array();
    throwIfAborted(signal);
    this.assertFileSize(current.byteLength + content.byteLength);
    const next = new Uint8Array(current.byteLength + content.byteLength);
    next.set(current, 0);
    next.set(content, current.byteLength);
    await this.write(normalized, next, undefined, signal);
  }

  async delete(path: string, signal?: AbortSignal): Promise<void> {
    await this.ensureLoaded();
    throwIfAborted(signal);
    const normalized = normalizePath(path);
    this.assertWritable(normalized);
    await this.refreshPersistedEntries();
    throwIfAborted(signal);
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

  async mkdir(path: string, signal?: AbortSignal): Promise<void> {
    await this.ensureLoaded();
    throwIfAborted(signal);
    const normalized = normalizePath(path);
    this.assertWritable(normalized);
    await this.ensureDirectory(normalized, signal);
  }

  async copy(source: string, destination: string, signal?: AbortSignal): Promise<string> {
    await this.ensureLoaded();
    throwIfAborted(signal);
    const sourcePath = normalizePath(source);
    const destinationPath = normalizePath(destination);
    const sourceStat = await this.stat(sourcePath, signal);
    throwIfAborted(signal);
    if (!sourceStat.isFile) {
      throw new Error(`Source is not a file: ${sourcePath}`);
    }
    let finalDestination = destinationPath;
    if (await this.exists(destinationPath, signal)) {
      throwIfAborted(signal);
      const destinationStat = await this.stat(destinationPath, signal);
      throwIfAborted(signal);
      if (destinationStat.isDirectory) {
        finalDestination = joinPath(destinationPath, basename(sourcePath));
      }
    }
    const bytes = await this.read(sourcePath, signal);
    throwIfAborted(signal);
    await this.write(finalDestination, bytes, sourceStat.contentType, signal);
    return finalDestination;
  }

  async move(source: string, destination: string, signal?: AbortSignal): Promise<void> {
    await this.copy(source, destination, signal);
    throwIfAborted(signal);
    await this.delete(source, signal);
  }

  async list(path: string, signal?: AbortSignal): Promise<{ files: string[]; directories: string[] }> {
    await this.ensureLoaded();
    throwIfAborted(signal);
    await this.refreshPersistedEntries();
    throwIfAborted(signal);
    const normalized = normalizePath(path);
    const mergedFiles = new Set<string>();
    const mergedDirectories = new Set<string>();
    if (normalized === "/dev") mergedFiles.add("null");

    if (await this.runtime.exists(normalized, signal)) {
      throwIfAborted(signal);
      const runtimeEntries = await this.runtime.list(normalized, signal);
      throwIfAborted(signal);
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

    if (mergedFiles.size === 0 && mergedDirectories.size === 0 && !(await this.exists(normalized, signal))) {
      throwIfAborted(signal);
      throw new Error(`No such directory: ${normalized}`);
    }

    return {
      files: Array.from(mergedFiles).sort(),
      directories: Array.from(mergedDirectories).sort(),
    };
  }

  async stat(path: string, signal?: AbortSignal): Promise<FileStat> {
    await this.ensureLoaded();
    throwIfAborted(signal);
    const normalized = normalizePath(path);
    if (normalized === "/dev/null") return { path: normalized, isFile: true, isDirectory: false, size: 0, contentType: "application/octet-stream" };
    if (await this.runtime.exists(normalized, signal)) {
      throwIfAborted(signal);
      const stat = await this.runtime.stat(normalized, signal);
      throwIfAborted(signal);
      return stat;
    }
    await this.refreshPersistedEntry(normalized);
    throwIfAborted(signal);
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

  async exists(path: string, signal?: AbortSignal): Promise<boolean> {
    await this.ensureLoaded();
    throwIfAborted(signal);
    const normalized = normalizePath(path);
    if (normalized === "/dev/null") return true;
    if (await this.runtime.exists(normalized, signal)) {
      throwIfAborted(signal);
      return true;
    }
    await this.refreshPersistedEntry(normalized);
    throwIfAborted(signal);
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
    const allPaths = await this.getAllPaths(signal);

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
        stat = await this.stat(candidate, signal);
      } catch {
        throwIfAborted(signal);
        continue;
      }
      if (!stat.isFile || !isTextContentType(stat.contentType ?? inferFsContentType(candidate))) {
        continue;
      }
      const text = textDecoder.decode(await this.read(candidate, signal));
      throwIfAborted(signal);
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

  async getAllPaths(signal?: AbortSignal): Promise<string[]> {
    await this.ensureLoaded();
    throwIfAborted(signal);
    await this.refreshPersistedEntries();
    throwIfAborted(signal);
    const runtimePaths = await this.runtime.getAllPaths(signal);
    throwIfAborted(signal);
    return Array.from(new Set([
      "/dev/null",
      ...this.directories,
      ...this.files.keys(),
      ...runtimePaths,
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

  private async ensureDirectory(path: string, signal?: AbortSignal): Promise<void> {
    let directory = "";
    for (const part of normalizePath(path).split("/")) {
      if (!part) continue;
      throwIfAborted(signal);
      directory += `/${part}`;
      if (this.directories.has(directory)) continue;
      await this.persistEntry({
        path: directory,
        kind: "directory",
        updatedAt: Date.now(),
      });
      throwIfAborted(signal);
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

  private async assertNotDirectory(path: string, signal?: AbortSignal): Promise<void> {
    let stat: FileStat;
    try {
      stat = await this.stat(path, signal);
    } catch {
      throwIfAborted(signal);
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
    if (call !== "fs.transfer.receive") throwIfAborted(signal);
    let response: GsvResponse;
    switch (call) {
      case "fs.read":
        response = await this.read(fsReadSchema.parse(args), signal); break;
      case "fs.write":
        response = { data: await this.write(fsWriteSchema.parse(args), signal) }; break;
      case "fs.edit":
        response = { data: await this.edit(fsEditSchema.parse(args), signal) }; break;
      case "fs.delete":
        response = { data: await this.delete(fsPathSchema.parse(args), signal) }; break;
      case "fs.search":
        response = { data: await this.search(fsSearchSchema.parse(args), signal) }; break;
      case "fs.copy":
        response = { data: await this.copy(fsCopySchema.parse(args), signal) }; break;
      case "fs.transfer.stat":
        response = { data: await this.transferStat(fsPathSchema.parse(args), signal) }; break;
      case "fs.transfer.send":
        response = await this.transferSend(fsTransferSendSchema.parse(args), signal); break;
      case "fs.transfer.receive":
        response = await this.transferReceive(fsTransferReceiveSchema.parse(args), body, signal); break;
      default:
        throw new Error(`Unsupported filesystem syscall: ${call}`);
    }
    if (call !== "fs.transfer.receive") throwIfAborted(signal);
    return response;
  }

  private async read(args: FsReadArgs, signal?: AbortSignal): Promise<GsvResponse> {
    const path = args.path;
    try {
      const stat = await this.fs.stat(path, signal);
      throwIfAborted(signal);
      if (stat.isDirectory) {
        return { data: { ok: true, path, ...await this.fs.list(path, signal) } };
      }

      const bytes = await this.fs.read(path, signal);
      throwIfAborted(signal);
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
      throwIfAborted(signal);
      return { data: { ok: false, error: error instanceof Error ? error.message : String(error) } };
    }
  }

  private async write(args: FsWriteArgs, signal?: AbortSignal): Promise<FsWriteResult> {
    const path = args.path;
    const bytes = textEncoder.encode(args.content);
    await this.fs.write(path, bytes, undefined, signal);
    return { ok: true, path, size: bytes.byteLength };
  }

  private async edit(args: FsEditArgs, signal?: AbortSignal): Promise<FsEditResult> {
    const path = args.path;
    const oldText = textDecoder.decode(await this.fs.read(path, signal));
    throwIfAborted(signal);
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
    await this.fs.write(path, textEncoder.encode(next), undefined, signal);
    return { ok: true, path, replacements: args.replaceAll === true ? count : 1 };
  }

  private async delete(args: FsDeleteArgs, signal?: AbortSignal): Promise<FsDeleteResult> {
    const path = args.path;
    await this.fs.delete(path, signal);
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

  private async copy(args: FsCopyArgs, signal?: AbortSignal): Promise<FsCopyResult> {
    const { source, destination } = args;
    const destinationPath = await this.fs.copy(source.path, destination.path, signal);
    throwIfAborted(signal);
    const stat = await this.fs.stat(destinationPath, signal);
    return {
      ok: true,
      source: { target: source.target ?? "local", path: source.path },
      destination: { target: destination.target ?? "local", path: destinationPath },
      size: stat.size,
      contentType: stat.contentType,
    };
  }

  private async transferStat(args: FsTransferStatArgs, signal?: AbortSignal): Promise<FsTransferStatResult> {
    const path = args.path;
    try {
      const stat = await this.fs.stat(path, signal);
      throwIfAborted(signal);
      const revision = stat.isFile ? await contentRevision(await this.fs.read(path, signal)) : undefined;
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
      throwIfAborted(signal);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async transferSend(args: FsTransferSendArgs, signal?: AbortSignal): Promise<GsvResponse> {
    const path = args.path;
    const bytes = await this.fs.read(path, signal);
    throwIfAborted(signal);
    const stat = await this.fs.stat(path, signal);
    throwIfAborted(signal);
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

  private async transferReceive(args: FsTransferReceiveArgs, body?: GsvBody, signal?: AbortSignal): Promise<GsvResponse> {
    const path = args.path;
    if (!body) {
      return { data: { ok: false, error: "fs.transfer.receive requires a request body" } };
    }
    try {
      if (body.length === undefined) throw new Error("fs.transfer.receive requires a request body length");
      if (!Number.isSafeInteger(body.length) || body.length < 0) throw new Error("Invalid transfer body length");
      const limit = this.fs.maxFileBytes ?? Number.POSITIVE_INFINITY;
      if (body.length > limit) throw new Error(`Browser file exceeds the ${limit} byte limit`);
      const bytes = await readStream(body.stream, body.length, signal);
      throwIfAborted(signal);
      const contentType = args.contentType ?? inferFsContentType(path);
      await this.fs.write(path, bytes, contentType, signal);
      return {
        data: {
          ok: true,
          path,
          bytesWritten: bytes.byteLength,
          contentType,
        },
      };
    } catch (error) {
      // Closing the stream is synchronous; a stalled source's cleanup must not hold the operation open.
      void body.stream.cancel(error instanceof Error ? error.message : "Binary transfer failed").catch(() => {});
      return { data: { ok: false, error: error instanceof Error ? error.message : String(error) } };
    }
  }
}

async function readStream(stream: ReadableStream<Uint8Array>, expectedSize: number, signal?: AbortSignal): Promise<Uint8Array> {
  throwIfAborted(signal);
  const output = new Uint8Array(expectedSize);
  const reader = stream.getReader();
  const onAbort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      if (!value) continue;
      if (value.byteLength > expectedSize - size) {
        throw new Error(`Transfer size mismatch: expected ${expectedSize}, got at least ${size + value.byteLength}`);
      }
      output.set(value, size);
      size += value.byteLength;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
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
