/**
 * Native FS driver — implements fs.* syscall handlers using GsvFs.
 *
 * Each handler constructs a GsvFs with the caller's identity and kernel
 * registries, then adds syscall-specific formatting on top of the raw
 * IFileSystem operations (line numbering, image detection, directory listing,
 * find-and-replace editing).
 */

import { GsvFs } from "../../fs/gsv-fs";
import {
  createHomeKnowledgeBackend,
  createPackageBackend,
  createProcessSourceBackend,
  createWorkspaceBackend,
  RipgitClient,
  resolveUserPath,
  formatSize,
  isTextContentType,
  inferContentType,
} from "../../fs";
import type { KernelContext } from "../../kernel/context";
import { visiblePackageScopesForActor } from "../../kernel/packages";
import type { FsReadArgs, FsReadResult } from "../../syscalls/read";
import type { FsWriteArgs, FsWriteResult } from "../../syscalls/write";
import type { FsEditArgs, FsEditResult } from "../../syscalls/edit";
import type { FsDeleteArgs, FsDeleteResult } from "../../syscalls/delete";
import type { FsSearchArgs, FsSearchResult } from "../../syscalls/search";
import type {
  FsCopyArgs,
  FsCopyEndpoint,
  FsCopyResult,
} from "../../syscalls/copy";
import type {
  FsTransferReadArgs,
  FsTransferReadResult,
  FsTransferStatArgs,
  FsTransferStatResult,
} from "../../syscalls/transfer";
import { decodeBase64Bytes, encodeBase64Bytes } from "../../shared/base64";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const COPY_CHUNK_SIZE = 512 * 1024;
const TRANSFER_READ_CHUNK_SIZE = 1024 * 1024;

export type FsCopyDeviceTransport = {
  requestDevice(
    deviceId: string,
    call: string,
    args: unknown,
    ttlMs?: number,
  ): Promise<unknown>;
};

type TransferStatResult =
  | {
      ok: true;
      path: string;
      size: number;
      isFile: boolean;
      isDirectory: boolean;
      contentType?: string;
    }
  | { ok: false; error: string };

type TransferReadResult =
  | {
      ok: true;
      path: string;
      offset: number;
      bytesRead: number;
      data: string;
      eof: boolean;
    }
  | { ok: false; error: string };

type TransferWriteResult =
  | {
      ok: true;
      path: string;
      offset: number;
      bytesWritten: number;
      done: boolean;
    }
  | { ok: false; error: string };

function makeFs(ctx: KernelContext): GsvFs {
  const identity = ctx.identity!.process;
  const sourceBackend = createProcessSourceBackend({
    identity,
    storage: ctx.env.STORAGE,
    ripgit: ctx.env.RIPGIT ? new RipgitClient(ctx.env.RIPGIT) : null,
    packages: ctx.packages.list({
      scopes: visiblePackageScopesForActor(identity),
    }),
    mounts: ctx.processId ? ctx.procs.getMounts(ctx.processId) : null,
    processId: ctx.processId ?? null,
    config: ctx.config,
  });
  return new GsvFs(
    ctx.env.STORAGE,
    identity,
    {
      auth: ctx.auth,
      procs: ctx.procs,
      devices: ctx.devices,
      caps: ctx.caps,
      config: ctx.config,
      workspaces: ctx.workspaces,
    },
    undefined,
    sourceBackend,
    createHomeKnowledgeBackend(ctx.env.STORAGE, ctx.env.RIPGIT, identity),
    createWorkspaceBackend(ctx.env, identity, ctx.workspaces),
    createPackageBackend(identity, ctx.packages),
  );
}

function resolve(path: string, ctx: KernelContext): string {
  const identity = ctx.identity!.process;
  return resolveUserPath(path, identity.home, identity.cwd);
}

export async function handleFsRead(
  args: FsReadArgs,
  ctx: KernelContext,
): Promise<FsReadResult> {
  const fs = makeFs(ctx);
  const p = resolve(args.path, ctx);

  try {
    const st = await fs.stat(p);

    if (st.isDirectory) {
      return readDirectory(fs, p);
    }

    const contentType = inferContentType(p);

    if (contentType.startsWith("image/")) {
      return readImage(fs, p, contentType, st.size);
    }

    if (!isTextContentType(contentType)) {
      return {
        ok: false,
        error: `Binary file (${contentType}, ${formatSize(st.size)}) — not readable as text`,
      };
    }

    return readText(fs, p, st.size, args.offset, args.limit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.includes("ENOENT")) {
      return readDirectory(fs, p);
    }

    return { ok: false, error: msg };
  }
}

async function readText(
  fs: GsvFs,
  path: string,
  size: number,
  offset?: number,
  limit?: number,
): Promise<FsReadResult> {
  const text = await fs.readFile(path);
  const allLines = text.split("\n");
  const start = offset ?? 0;
  const count = limit ?? allLines.length;
  const selected = allLines.slice(start, start + count);
  const numbered = selected
    .map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`)
    .join("\n");

  return { ok: true, content: numbered, path, lines: selected.length, size };
}

async function readImage(
  fs: GsvFs,
  path: string,
  mimeType: string,
  size: number,
): Promise<FsReadResult> {
  if (size > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `Image too large (${formatSize(size)}, max ${formatSize(MAX_IMAGE_BYTES)})`,
    };
  }

  const buf = await fs.readFileBuffer(path);
  let binary = "";
  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]);
  }
  const base64 = btoa(binary);

  return {
    ok: true,
    content: [
      {
        type: "text",
        text: `Read image ${path} [${mimeType}, ${formatSize(size)}]`,
      },
      { type: "image", data: base64, mimeType },
    ],
    path,
    size,
  };
}

async function readDirectory(fs: GsvFs, path: string): Promise<FsReadResult> {
  try {
    const names = await fs.readdir(path);
    const files: string[] = [];
    const directories: string[] = [];

    for (const name of names) {
      const childPath = path.endsWith("/") ? path + name : path + "/" + name;
      try {
        const s = await fs.stat(childPath);
        if (s.isDirectory) directories.push(name);
        else files.push(name);
      } catch {
        files.push(name);
      }
    }

    return { ok: true, path, files, directories };
  } catch {
    return { ok: false, error: `Not found: ${path}` };
  }
}

export async function handleFsTransferStat(
  args: FsTransferStatArgs,
  ctx: KernelContext,
): Promise<FsTransferStatResult> {
  const fs = makeFs(ctx);
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!rawPath) {
    return { ok: false, error: "fs.transfer.stat requires path" };
  }

  const path = resolve(rawPath, ctx);
  try {
    const stat = await fs.stat(path);
    return {
      ok: true,
      path,
      size: stat.size,
      isFile: stat.isFile,
      isDirectory: stat.isDirectory,
      contentType: stat.isFile ? inferContentType(path) : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function handleFsTransferRead(
  args: FsTransferReadArgs,
  ctx: KernelContext,
): Promise<FsTransferReadResult> {
  const fs = makeFs(ctx);
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!rawPath) {
    return { ok: false, error: "fs.transfer.read requires path" };
  }

  const offset = normalizeTransferNumber(args.offset, 0);
  const length = Math.min(
    normalizeTransferNumber(args.length, TRANSFER_READ_CHUNK_SIZE),
    TRANSFER_READ_CHUNK_SIZE,
  );
  const path = resolve(rawPath, ctx);

  try {
    const stat = await fs.stat(path);
    if (!stat.isFile) {
      throw new Error(`fs.transfer.read path is not a file: ${path}`);
    }

    if (length === 0 || offset >= stat.size) {
      return {
        ok: true,
        path,
        offset,
        bytesRead: 0,
        data: "",
        eof: true,
      };
    }

    const readLength = Math.min(length, stat.size - offset);
    const opened = await fs.openFile(path, {
      range: { offset, length: readLength },
    });
    const chunk = opened.body
      ? await streamToBytes(opened.body, opened.size)
      : new Uint8Array();
    return {
      ok: true,
      path,
      offset,
      bytesRead: chunk.byteLength,
      data: encodeBase64Bytes(chunk),
      eof: offset + chunk.byteLength >= stat.size,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function handleFsWrite(
  args: FsWriteArgs,
  ctx: KernelContext,
): Promise<FsWriteResult> {
  const fs = makeFs(ctx);
  const p = resolve(args.path, ctx);

  try {
    await fs.writeFile(p, args.content);
    return { ok: true, path: p, size: args.content.length };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function handleFsCopy(
  args: FsCopyArgs,
  ctx: KernelContext,
  transport?: FsCopyDeviceTransport,
): Promise<FsCopyResult> {
  try {
    const source = normalizeCopyEndpoint(args.source, ctx);
    let destination = normalizeCopyEndpoint(args.destination, ctx);
    assertCanUseCopyEndpoint(source, ctx);
    assertCanUseCopyEndpoint(destination, ctx);

    if (destination.target === "gsv") {
      destination = await resolveGsvDestinationDirectory(
        source,
        destination,
        ctx,
      );
    } else if (transport) {
      destination = await resolveDeviceDestinationDirectory(
        source,
        destination,
        transport,
      );
    }

    if (source.target === "gsv" && destination.target === "gsv") {
      return await copyGsvToGsv(source, destination, ctx);
    }

    if (!transport) {
      return {
        ok: false,
        error: "fs.copy requires device transfer support for non-gsv endpoints",
      };
    }

    if (
      source.target !== "gsv" &&
      destination.target !== "gsv" &&
      source.target === destination.target
    ) {
      return await copyOnDevice(source, destination, transport);
    }

    if (source.target === "gsv") {
      return await copyGsvToDevice(source, destination, ctx, transport);
    }

    if (destination.target === "gsv") {
      return await copyDeviceToGsv(source, destination, ctx, transport);
    }

    return await copyDeviceToDevice(source, destination, transport);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function copyGsvToGsv(
  source: Required<FsCopyEndpoint>,
  destination: Required<FsCopyEndpoint>,
  ctx: KernelContext,
): Promise<FsCopyResult> {
  const fs = makeFs(ctx);
  const opened = await fs.openFile(source.path);
  if (opened.status !== 200 || !opened.body) {
    return {
      ok: false,
      error: `Unable to open source for copy: ${source.path}`,
    };
  }

  const contentType = opened.contentType ?? inferContentType(source.path);
  await fs.writeFileStream(destination.path, opened.body, {
    expectedSize: opened.size,
    contentType,
  });

  return {
    ok: true,
    source,
    destination,
    size: opened.size,
    contentType,
  };
}

async function copyOnDevice(
  source: Required<FsCopyEndpoint>,
  destination: Required<FsCopyEndpoint>,
  transport: FsCopyDeviceTransport,
): Promise<FsCopyResult> {
  const result = await requestDeviceResult<FsCopyResult>(
    transport,
    source.target,
    "fs.copy",
    {
      source,
      destination,
    },
  );
  if (!result.ok) {
    return result;
  }
  return {
    ...result,
    source: { target: source.target, path: result.source.path },
    destination: { target: destination.target, path: result.destination.path },
  };
}

async function copyGsvToDevice(
  source: Required<FsCopyEndpoint>,
  destination: Required<FsCopyEndpoint>,
  ctx: KernelContext,
  transport: FsCopyDeviceTransport,
): Promise<FsCopyResult> {
  const fs = makeFs(ctx);
  const opened = await fs.openFile(source.path);
  if (opened.status !== 200 || !opened.body) {
    return {
      ok: false,
      error: `Unable to open source for copy: ${source.path}`,
    };
  }

  const contentType = opened.contentType ?? inferContentType(source.path);
  const reader = opened.body.getReader();
  let offset = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const chunks = splitCopyChunk(value);
      for (const chunk of chunks) {
        await writeDeviceChunk(
          transport,
          destination,
          offset,
          chunk,
          opened.size,
          contentType,
          false,
        );
        offset += chunk.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }

  await writeDeviceChunk(
    transport,
    destination,
    offset,
    new Uint8Array(),
    opened.size,
    contentType,
    true,
  );

  return {
    ok: true,
    source,
    destination,
    size: opened.size,
    contentType,
  };
}

async function copyDeviceToGsv(
  source: Required<FsCopyEndpoint>,
  destination: Required<FsCopyEndpoint>,
  ctx: KernelContext,
  transport: FsCopyDeviceTransport,
): Promise<FsCopyResult> {
  const sourceStat = await statDeviceSource(transport, source);
  const contentType = sourceStat.contentType ?? inferContentType(source.path);
  const stream = deviceReadStream(transport, source, sourceStat.size);
  const fs = makeFs(ctx);
  await fs.writeFileStream(destination.path, stream, {
    expectedSize: sourceStat.size,
    contentType,
  });

  return {
    ok: true,
    source,
    destination,
    size: sourceStat.size,
    contentType,
  };
}

async function copyDeviceToDevice(
  source: Required<FsCopyEndpoint>,
  destination: Required<FsCopyEndpoint>,
  transport: FsCopyDeviceTransport,
): Promise<FsCopyResult> {
  const sourceStat = await statDeviceSource(transport, source);
  const contentType = sourceStat.contentType ?? inferContentType(source.path);
  let offset = 0;

  while (offset < sourceStat.size) {
    const readLength = Math.min(COPY_CHUNK_SIZE, sourceStat.size - offset);
    const chunk = await readDeviceChunk(transport, source, offset, readLength);
    if (chunk.byteLength === 0) {
      throw new Error(
        `fs.copy read zero bytes before EOF from ${source.target}:${source.path}`,
      );
    }
    await writeDeviceChunk(
      transport,
      destination,
      offset,
      chunk,
      sourceStat.size,
      contentType,
      false,
    );
    offset += chunk.byteLength;
  }

  await writeDeviceChunk(
    transport,
    destination,
    offset,
    new Uint8Array(),
    sourceStat.size,
    contentType,
    true,
  );

  return {
    ok: true,
    source,
    destination,
    size: sourceStat.size,
    contentType,
  };
}

async function resolveGsvDestinationDirectory(
  source: Required<FsCopyEndpoint>,
  destination: Required<FsCopyEndpoint>,
  ctx: KernelContext,
): Promise<Required<FsCopyEndpoint>> {
  const fs = makeFs(ctx);
  try {
    const destinationStat = await fs.statExtended(destination.path);
    if (destinationStat.isDirectory) {
      return {
        ...destination,
        path: joinPath(destination.path, basename(source.path)),
      };
    }
  } catch {
    // Destination does not exist; copy to the requested path.
  }
  return destination;
}

async function resolveDeviceDestinationDirectory(
  source: Required<FsCopyEndpoint>,
  destination: Required<FsCopyEndpoint>,
  transport: FsCopyDeviceTransport,
): Promise<Required<FsCopyEndpoint>> {
  const stat = await requestDeviceResult<TransferStatResult>(
    transport,
    destination.target,
    "fs.transfer.stat",
    {
      path: destination.path,
    },
  );
  if (stat.ok && stat.isDirectory) {
    return {
      ...destination,
      path: joinPath(destination.path, basename(source.path)),
    };
  }
  return destination;
}

async function statDeviceSource(
  transport: FsCopyDeviceTransport,
  source: Required<FsCopyEndpoint>,
): Promise<Extract<TransferStatResult, { ok: true }>> {
  const stat = await requestDeviceResult<TransferStatResult>(
    transport,
    source.target,
    "fs.transfer.stat",
    {
      path: source.path,
    },
  );
  if (!stat.ok) {
    throw new Error(stat.error);
  }
  if (!stat.isFile) {
    throw new Error(
      `fs.copy source is not a file: ${source.target}:${source.path}`,
    );
  }
  return stat;
}

function deviceReadStream(
  transport: FsCopyDeviceTransport,
  source: Required<FsCopyEndpoint>,
  size: number,
): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= size) {
        controller.close();
        return;
      }
      try {
        const readLength = Math.min(COPY_CHUNK_SIZE, size - offset);
        const chunk = await readDeviceChunk(
          transport,
          source,
          offset,
          readLength,
        );
        if (chunk.byteLength === 0) {
          throw new Error(
            `fs.copy read zero bytes before EOF from ${source.target}:${source.path}`,
          );
        }
        offset += chunk.byteLength;
        controller.enqueue(chunk);
        if (offset >= size) {
          controller.close();
        }
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

async function readDeviceChunk(
  transport: FsCopyDeviceTransport,
  source: Required<FsCopyEndpoint>,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const result = await requestDeviceResult<TransferReadResult>(
    transport,
    source.target,
    "fs.transfer.read",
    {
      path: source.path,
      offset,
      length,
    },
  );
  if (!result.ok) {
    throw new Error(result.error);
  }
  return decodeBase64Bytes(result.data);
}

async function writeDeviceChunk(
  transport: FsCopyDeviceTransport,
  destination: Required<FsCopyEndpoint>,
  offset: number,
  bytes: Uint8Array,
  expectedSize: number,
  contentType: string | undefined,
  done: boolean,
): Promise<void> {
  const result = await requestDeviceResult<TransferWriteResult>(
    transport,
    destination.target,
    "fs.transfer.write",
    {
      path: destination.path,
      offset,
      data: encodeBase64Bytes(bytes),
      expectedSize,
      contentType,
      done,
    },
  );
  if (!result.ok) {
    throw new Error(result.error);
  }
}

async function requestDeviceResult<T>(
  transport: FsCopyDeviceTransport,
  deviceId: string,
  call: string,
  args: unknown,
): Promise<T> {
  return (await transport.requestDevice(deviceId, call, args, 60_000)) as T;
}

function splitCopyChunk(chunk: Uint8Array): Uint8Array[] {
  if (chunk.byteLength <= COPY_CHUNK_SIZE) {
    return [chunk];
  }
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < chunk.byteLength; offset += COPY_CHUNK_SIZE) {
    chunks.push(chunk.subarray(offset, offset + COPY_CHUNK_SIZE));
  }
  return chunks;
}

async function streamToBytes(stream: ReadableStream<Uint8Array>, expectedSize: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > expectedSize) {
        throw new Error(`EFBIG: stream exceeds expectedSize ${expectedSize}`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function handleFsEdit(
  args: FsEditArgs,
  ctx: KernelContext,
): Promise<FsEditResult> {
  const fs = makeFs(ctx);
  const p = resolve(args.path, ctx);

  try {
    const content = await fs.readFile(p);

    const count = content.split(args.oldString).length - 1;
    if (count === 0) {
      return { ok: false, error: `oldString not found in ${p}` };
    }
    if (!args.replaceAll && count > 1) {
      return {
        ok: false,
        error: `oldString found ${count} times in ${p}. Use replaceAll or provide more context.`,
      };
    }

    const updated = args.replaceAll
      ? content.replaceAll(args.oldString, args.newString)
      : content.replace(args.oldString, args.newString);

    await fs.writeFile(p, updated);

    return { ok: true, path: p, replacements: args.replaceAll ? count : 1 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT"))
      return { ok: false, error: `File not found: ${p}` };
    return { ok: false, error: msg };
  }
}

function normalizeTransferNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeCopyEndpoint(
  endpoint: FsCopyEndpoint,
  ctx: KernelContext,
): Required<FsCopyEndpoint> {
  const target =
    typeof endpoint?.target === "string" && endpoint.target.trim()
      ? endpoint.target.trim()
      : "gsv";
  const rawPath =
    typeof endpoint?.path === "string" ? endpoint.path.trim() : "";
  if (!rawPath) {
    throw new Error("fs.copy endpoint path is required");
  }
  return {
    target,
    path: target === "gsv" ? resolve(rawPath, ctx) : rawPath,
  };
}

function assertCanUseCopyEndpoint(
  endpoint: Required<FsCopyEndpoint>,
  ctx: KernelContext,
): void {
  if (endpoint.target === "gsv") {
    return;
  }
  const identity = ctx.identity!.process;
  if (!ctx.devices.canAccess(endpoint.target, identity.uid, identity.gids)) {
    throw new Error(`Access denied to device: ${endpoint.target}`);
  }
  if (!ctx.devices.canHandle(endpoint.target, "fs.copy")) {
    throw new Error(`Device ${endpoint.target} does not implement fs.copy`);
  }
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function joinPath(parent: string, child: string): string {
  return parent.endsWith("/") ? `${parent}${child}` : `${parent}/${child}`;
}

export async function handleFsDelete(
  args: FsDeleteArgs,
  ctx: KernelContext,
): Promise<FsDeleteResult> {
  const fs = makeFs(ctx);
  const p = resolve(args.path, ctx);

  try {
    const exists = await fs.exists(p);
    if (!exists) return { ok: false, error: `File not found: ${p}` };

    await fs.rm(p, { force: true });
    return { ok: true, path: p };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function handleFsSearch(
  args: FsSearchArgs,
  ctx: KernelContext,
): Promise<FsSearchResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return { ok: false, error: "Search query is required." };
  }

  const identity = ctx.identity!.process;
  const prefix = args.path
    ? resolveUserPath(args.path, identity.home, identity.cwd)
    : identity.cwd;
  const fs = makeFs(ctx);

  try {
    const result = await fs.search(prefix, query, args.include);
    return {
      ok: true,
      matches: result.matches,
      count: result.matches.length,
      truncated: result.truncated,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
