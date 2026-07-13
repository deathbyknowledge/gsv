/**
 * Native FS driver — implements fs.* syscall handlers using GsvFs.
 *
 * Each handler constructs a GsvFs with the caller's identity and kernel
 * registries, then adds syscall-specific behavior on top of the raw
 * IFileSystem operations (image detection, directory listing, and
 * find-and-replace editing).
 */

import type { GsvFs } from "../../fs/gsv-fs";
import {
  resolveUserPath,
  formatSize,
  isTextContentType,
  inferContentType,
} from "../../fs";
import type { KernelContext } from "../../kernel/context";
import type { FrameBody, ResponseOkFrame } from "../../protocol/frames";
import type { FsReadArgs, FsReadResult } from "../../syscalls/read";
import type { FsWriteArgs, FsWriteResult } from "../../syscalls/write";
import type { FsEditArgs, FsEditResult } from "../../syscalls/edit";
import type { FsDeleteArgs, FsDeleteResult } from "../../syscalls/delete";
import type { FsSearchArgs, FsSearchResult } from "../../syscalls/search";
import type {
  FsCopyArgs,
  FsCopyEndpoint,
  FsCopyResult,
  FsTransferReceiveArgs,
  FsTransferReceiveResult,
  FsTransferSendArgs,
  FsTransferSendResult,
  FsTransferStatArgs,
  FsTransferStatResult,
} from "@humansandmachines/gsv/protocol";
import { bodyFromText, bodyToBytes } from "@humansandmachines/gsv/protocol";
import { createNativeFileSystem } from "./filesystem";

export type FsCopyDeviceTransport = {
  requestDevice(
    deviceId: string,
    call: string,
    args: unknown,
    options?: { ttlMs?: number; body?: FrameBody; signal?: AbortSignal },
  ): Promise<ResponseOkFrame>;
};

function resolve(path: string, ctx: KernelContext): string {
  const identity = ctx.identity!.process;
  return resolveUserPath(path, identity.home, identity.cwd);
}

export async function handleFsRead(
  args: FsReadArgs,
  ctx: KernelContext,
): Promise<{ data: FsReadResult; body?: FrameBody }> {
  const fs = createNativeFileSystem(ctx);
  const p = resolve(args.path, ctx);

  try {
    const st = await fs.stat(p);

    if (st.isDirectory) {
      return await readDirectory(fs, p);
    }

    const opened = await fs.openFile(p);
    if (opened.status !== 200 || !opened.body) {
      throw new Error(`Unable to open file: ${p}`);
    }
    const contentType = opened.contentType ?? inferContentType(p);

    if (contentType.trim().toLowerCase().startsWith("image/") && !isTextContentType(contentType)) {
      return readImage(p, contentType, opened.body, opened.size);
    }

    if (!isTextContentType(contentType)) {
      await opened.body.cancel().catch(() => {});
      return {
        data: {
          ok: false,
          error: `Binary file (${contentType}, ${formatSize(st.size)}) — not readable as text`,
        },
      };
    }

    const bytes = await bodyToBytes(
      { stream: opened.body, length: opened.size },
      Infinity,
      ctx.requestSignal,
    );
    return readText(bytes, p, contentType, st.size, args.offset, args.limit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { data: { ok: false, error: msg } };
  }
}

function readText(
  bytes: Uint8Array,
  path: string,
  contentType: string,
  size: number,
  offset?: number,
  limit?: number,
): { data: FsReadResult; body?: FrameBody } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return {
      data: {
        ok: false,
        error: `Binary file (${contentType}, ${formatSize(size)}) — not readable as text`,
      },
    };
  }
  const allLines = text.split("\n");
  const start = offset ?? 0;
  const count = limit ?? allLines.length;
  const selected = allLines.slice(start, start + count);

  return {
    data: {
      ok: true,
      path,
      kind: "text",
      contentType,
      lines: selected.length,
      size,
    },
    body: bodyFromText(selected.join("\n")),
  };
}

function readImage(
  path: string,
  mimeType: string,
  stream: ReadableStream<Uint8Array>,
  size: number,
): { data: FsReadResult; body?: FrameBody } {
  return {
    data: {
      ok: true,
      path,
      kind: "image",
      contentType: mimeType,
      size,
    },
    body: {
      stream,
      length: size,
    },
  };
}

async function readDirectory(
  fs: GsvFs,
  path: string,
): Promise<{ data: FsReadResult }> {
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

  return { data: { ok: true, path, files, directories } };
}

export async function handleFsTransferStat(
  args: FsTransferStatArgs,
  ctx: KernelContext,
): Promise<FsTransferStatResult> {
  const fs = createNativeFileSystem(ctx);
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!rawPath) {
    return { ok: false, error: "fs.transfer.stat requires path" };
  }

  const path = resolve(rawPath, ctx);
  try {
    const stat = await fs.stat(path);
    let contentType: string | undefined;
    if (stat.isFile) {
      const opened = await fs.openFile(path);
      contentType = opened.contentType ?? inferContentType(path);
      await opened.body?.cancel().catch(() => {});
    }
    return {
      ok: true,
      path,
      size: stat.size,
      isFile: stat.isFile,
      isDirectory: stat.isDirectory,
      contentType,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function handleFsTransferSend(
  args: FsTransferSendArgs,
  ctx: KernelContext,
  frameId: string,
): Promise<ResponseOkFrame<"fs.transfer.send">> {
  const fs = createNativeFileSystem(ctx);
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!rawPath) {
    return {
      type: "res",
      id: frameId,
      ok: true,
      data: { ok: false, error: "fs.transfer.send requires path" },
    };
  }
  const path = resolve(rawPath, ctx);

  try {
    const opened = await fs.openFile(path);
    if (opened.status !== 200 || !opened.body) {
      throw new Error(`Unable to open source for transfer: ${path}`);
    }
    return {
      type: "res",
      id: frameId,
      ok: true,
      data: {
        ok: true,
        path,
        size: opened.size,
        contentType: opened.contentType ?? inferContentType(path),
      },
      body: { stream: opened.body, length: opened.size },
    };
  } catch (error) {
    return {
      type: "res",
      id: frameId,
      ok: true,
      data: {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function handleFsTransferReceive(
  args: FsTransferReceiveArgs,
  ctx: KernelContext,
  body?: FrameBody,
): Promise<FsTransferReceiveResult> {
  const fs = createNativeFileSystem(ctx);
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!rawPath) {
    await body?.stream.cancel().catch(() => {});
    return { ok: false, error: "fs.transfer.receive requires path" };
  }
  if (!body) {
    return { ok: false, error: "fs.transfer.receive requires a request body" };
  }
  if (body.length === undefined) {
    await body.stream.cancel().catch(() => {});
    return { ok: false, error: "fs.transfer.receive requires a request body length" };
  }

  try {
    const path = resolve(rawPath, ctx);
    const result = await fs.writeFileStream(path, body.stream, {
      expectedSize: body.length,
      contentType: args.contentType,
      signal: ctx.requestSignal,
    });
    return {
      ok: true,
      path,
      bytesWritten: result.size,
      contentType: args.contentType,
    };
  } catch (error) {
    await body.stream.cancel(error).catch(() => {});
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
  const fs = createNativeFileSystem(ctx);
  const p = resolve(args.path, ctx);

  try {
    await fs.writeFile(p, args.content);
    return { ok: true, path: p, size: new TextEncoder().encode(args.content).byteLength };
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
    ctx.requestSignal?.throwIfAborted();
    const source = normalizeCopyEndpoint(args.source, ctx);
    let destination = normalizeCopyEndpoint(args.destination, ctx);
    assertCanAccessCopyEndpoint(source, ctx);
    assertCanAccessCopyEndpoint(destination, ctx);

    if (source.target === "gsv" && destination.target === "gsv") {
      destination = await resolveGsvDestinationDirectory(
        source,
        destination,
        ctx,
      );
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
      if (ctx.devices.canHandle(source.target, "fs.copy")) {
        assertCanUseDeviceCapabilities(source, ctx, ["fs.copy"]);
        return await copyOnDevice(
          source,
          destination,
          transport,
          ctx.requestSignal,
        );
      }
    }

    if (destination.target === "gsv") {
      destination = await resolveGsvDestinationDirectory(
        source,
        destination,
        ctx,
      );
    } else {
      assertCanUseDeviceCapabilities(destination, ctx, ["fs.transfer.stat"]);
      destination = await resolveDeviceDestinationDirectory(
        source,
        destination,
        transport,
        ctx.requestSignal,
      );
    }

    if (source.target === "gsv") {
      assertCanUseDeviceCapabilities(destination, ctx, ["fs.transfer.receive"]);
      return await copyGsvToDevice(source, destination, ctx, transport);
    }

    if (destination.target === "gsv") {
      assertCanUseDeviceCapabilities(source, ctx, [
        "fs.transfer.stat",
        "fs.transfer.send",
      ]);
      return await copyDeviceToGsv(source, destination, ctx, transport);
    }

    assertCanUseDeviceCapabilities(source, ctx, [
      "fs.transfer.stat",
      "fs.transfer.send",
    ]);
    assertCanUseDeviceCapabilities(destination, ctx, [
      "fs.transfer.stat",
      "fs.transfer.receive",
    ]);
    return await copyDeviceToDevice(
      source,
      destination,
      transport,
      ctx.requestSignal,
    );
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
  const fs = createNativeFileSystem(ctx);
  const opened = await fs.openFile(source.path);
  ctx.requestSignal?.throwIfAborted();
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
    signal: ctx.requestSignal,
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
  signal?: AbortSignal,
): Promise<FsCopyResult> {
  const result = await requestDeviceResult<FsCopyResult>(
    transport,
    source.target,
    "fs.copy",
    {
      source,
      destination,
    },
    { signal },
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
  const fs = createNativeFileSystem(ctx);
  const opened = await fs.openFile(source.path);
  ctx.requestSignal?.throwIfAborted();
  if (opened.status !== 200 || !opened.body) {
    return {
      ok: false,
      error: `Unable to open source for copy: ${source.path}`,
    };
  }

  const contentType = opened.contentType ?? inferContentType(source.path);
  const result = await requestDeviceResult<FsTransferReceiveResult>(
    transport,
    destination.target,
    "fs.transfer.receive",
    {
      path: destination.path,
      contentType,
    },
    {
      ttlMs: 120_000,
      body: { stream: opened.body, length: opened.size },
      signal: ctx.requestSignal,
    },
  );
  if (!result.ok) {
    throw new Error(result.error);
  }
  if (result.bytesWritten !== opened.size) {
    throw new Error(
      `Transfer size mismatch for ${destination.path}: expected ${opened.size}, got ${result.bytesWritten}`,
    );
  }

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
  const { stat: sourceStat, body } = await openDeviceSource(
    transport,
    source,
    ctx.requestSignal,
  );
  const contentType = sourceStat.contentType ?? inferContentType(source.path);

  const fs = createNativeFileSystem(ctx);
  const writeResult = await fs.writeFileStream(destination.path, body.stream, {
    expectedSize: sourceStat.size,
    contentType,
    signal: ctx.requestSignal,
  });
  if (writeResult.size !== sourceStat.size) {
    throw new Error(
      `Transfer size mismatch for ${destination.path}: expected ${sourceStat.size}, got ${writeResult.size}`,
    );
  }

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
  signal?: AbortSignal,
): Promise<FsCopyResult> {
  const { stat: sourceStat, body } = await openDeviceSource(transport, source, signal);
  const contentType = sourceStat.contentType ?? inferContentType(source.path);

  const received = await requestDeviceResult<FsTransferReceiveResult>(
    transport,
    destination.target,
    "fs.transfer.receive",
    { path: destination.path, contentType },
    { ttlMs: 120_000, body, signal },
  );
  if (!received.ok) {
    throw new Error(received.error);
  }
  if (received.bytesWritten !== sourceStat.size) {
    throw new Error(
      `Transfer size mismatch for ${destination.path}: expected ${sourceStat.size}, got ${received.bytesWritten}`,
    );
  }

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
  const fs = createNativeFileSystem(ctx);
  ctx.requestSignal?.throwIfAborted();
  try {
    const destinationStat = await fs.statExtended(destination.path);
    ctx.requestSignal?.throwIfAborted();
    if (destinationStat.isDirectory) {
      return {
        ...destination,
        path: joinPath(destination.path, basename(source.path)),
      };
    }
  } catch {
    ctx.requestSignal?.throwIfAborted();
    // Destination does not exist; copy to the requested path.
  }
  return destination;
}

async function resolveDeviceDestinationDirectory(
  source: Required<FsCopyEndpoint>,
  destination: Required<FsCopyEndpoint>,
  transport: FsCopyDeviceTransport,
  signal?: AbortSignal,
): Promise<Required<FsCopyEndpoint>> {
  let stat: FsTransferStatResult;
  try {
    stat = await requestDeviceResult<FsTransferStatResult>(
      transport,
      destination.target,
      "fs.transfer.stat",
      {
        path: destination.path,
      },
      { signal },
    );
  } catch {
    signal?.throwIfAborted();
    return destination;
  }
  if (stat.ok && stat.isDirectory) {
    return {
      ...destination,
      path: joinPath(destination.path, basename(source.path)),
    };
  }
  return destination;
}

async function openDeviceSource(
  transport: FsCopyDeviceTransport,
  source: Required<FsCopyEndpoint>,
  signal?: AbortSignal,
): Promise<{
  stat: Extract<FsTransferStatResult, { ok: true }>;
  body: FrameBody;
}> {
  const stat = await requestDeviceResult<FsTransferStatResult>(
    transport,
    source.target,
    "fs.transfer.stat",
    {
      path: source.path,
    },
    { signal },
  );
  if (!stat.ok) {
    throw new Error(stat.error);
  }
  if (!stat.isFile) {
    throw new Error(
      `fs.copy source is not a file: ${source.target}:${source.path}`,
    );
  }
  const response = await transport.requestDevice(
    source.target,
    "fs.transfer.send",
    { path: source.path },
    { ttlMs: 120_000, signal },
  );
  const result = response.data as FsTransferSendResult;
  if (!result.ok) {
    throw new Error(result.error);
  }
  if (!response.body) {
    throw new Error("fs.transfer.send returned no response body");
  }
  if (response.body.length !== stat.size) {
    void response.body.stream.cancel();
    throw new Error(
      `Transfer size mismatch for ${source.path}: expected ${stat.size}, got ${response.body.length ?? "unknown"}`,
    );
  }
  return { stat, body: response.body };
}

async function requestDeviceResult<T>(
  transport: FsCopyDeviceTransport,
  deviceId: string,
  call: string,
  args: unknown,
  options?: { ttlMs?: number; body?: FrameBody; signal?: AbortSignal },
): Promise<T> {
  return (await transport.requestDevice(deviceId, call, args, options)).data as T;
}

export async function handleFsEdit(
  args: FsEditArgs,
  ctx: KernelContext,
): Promise<FsEditResult> {
  const fs = createNativeFileSystem(ctx);
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

function assertCanAccessCopyEndpoint(
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
}

function assertCanUseDeviceCapabilities(
  endpoint: Required<FsCopyEndpoint>,
  ctx: KernelContext,
  syscalls: string[],
): void {
  if (endpoint.target === "gsv") {
    return;
  }
  for (const syscall of syscalls) {
    if (!ctx.devices.canHandle(endpoint.target, syscall)) {
      throw new Error(`Device ${endpoint.target} does not implement ${syscall}`);
    }
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
  const fs = createNativeFileSystem(ctx);
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
  const fs = createNativeFileSystem(ctx);

  try {
    const result = await fs.search(prefix, query, args.include, ctx.requestSignal);
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
