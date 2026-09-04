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
  FileResourceReference,
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
import { bodyFromText, bodyToBytes, type JsonObject } from "@humansandmachines/gsv/protocol";
import { createNativeFileSystem } from "./filesystem";

export type FsDeviceTransport = {
  requestTarget(
    targetId: string,
    call: string,
    args: JsonObject,
    options?: { ttlMs?: number; body?: FrameBody; signal?: AbortSignal },
  ): Promise<ResponseOkFrame>;
  openContactSource?: (
    source: Required<FsCopyEndpoint>,
    signal?: AbortSignal,
  ) => Promise<FsOpenedSource>;
};

export type FsOpenedSource = {
  body: FrameBody;
  size: number;
  contentType?: string;
};
type FsReadResponse = { data: FsReadResult; body?: FrameBody };
type FsReadFileSuccess = Extract<
  FsReadResult,
  { ok: true; kind: "text" | "image" }
>;
type TextLineSelection = {
  content: string;
  lines: number;
  truncated: boolean;
  partial: boolean;
};

export async function openFsSource(
  source: Required<FsCopyEndpoint>,
  ctx: KernelContext,
  options?: {
    fs?: Pick<GsvFs, "openFile">;
    transport?: FsDeviceTransport;
  },
): Promise<FsOpenedSource> {
  ctx.requestSignal?.throwIfAborted();
  assertCanAccessCopyEndpoint(source, ctx, "source");

  if (source.target === "gsv") {
    const opened = await (options?.fs ?? createNativeFileSystem(ctx)).openFile(source.path);
    if (opened.status !== 200 || !opened.body) {
      throw new Error(`Unable to open source file: ${source.path}`);
    }
    try {
      ctx.requestSignal?.throwIfAborted();
    } catch (error) {
      await opened.body.cancel(error).catch(() => {});
      throw error;
    }
    return {
      body: { stream: opened.body, length: opened.size },
      size: opened.size,
      contentType: opened.contentType,
    };
  }

  if (isContactTarget(source.target)) {
    if (!options?.transport?.openContactSource) {
      throw new Error("Reading a Contact resource requires federation transfer support");
    }
    return await options.transport.openContactSource(source, ctx.requestSignal);
  }

  if (!options?.transport) {
    throw new Error("Reading a non-gsv source requires device transfer support");
  }
  assertCanUseDeviceCapabilities(source, ctx, [
    "fs.transfer.stat",
    "fs.transfer.send",
  ]);
  const { stat, body } = await openDeviceSource(
    options.transport,
    source,
    ctx.requestSignal,
  );
  return {
    body,
    size: stat.size,
    contentType: stat.contentType,
  };
}

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
    return await readOpenedFile(args, {
      target: "gsv",
      path: p,
      size: opened.size,
      contentType: opened.contentType ?? inferContentType(p),
      revision: opened.etag,
      body: { stream: opened.body, length: opened.size },
    }, ctx.requestSignal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { data: { ok: false, error: msg } };
  }
}

export async function handleFsReadTransfer(
  args: FsReadArgs,
  response: ResponseOkFrame<"fs.transfer.send">,
  ctx: KernelContext,
): Promise<FsReadResponse> {
  const result = response.data;
  if (!result) {
    await response.body?.stream.cancel("fs.transfer.send returned no response data").catch(() => {});
    return { data: { ok: false, error: "fs.transfer.send returned no response data" } };
  }
  if (!result.ok) {
    await response.body?.stream.cancel(result.error).catch(() => {});
    return { data: result };
  }
  if (!response.body) {
    return { data: { ok: false, error: "fs.transfer.send returned no response body" } };
  }
  if (response.body.length !== undefined && response.body.length !== result.size) {
    await response.body.stream.cancel("Remote resource size did not match its metadata").catch(() => {});
    return { data: { ok: false, error: "Remote resource size did not match its metadata" } };
  }
  try {
    return await readOpenedFile(args, {
      target: args.target?.trim() || "gsv",
      path: result.path,
      size: result.size,
      contentType: result.contentType ?? inferContentType(result.path),
      revision: result.revision,
      body: response.body,
    }, ctx.requestSignal);
  } catch (error) {
    return {
      data: { ok: false, error: error instanceof Error ? error.message : String(error) },
    };
  }
}

async function readOpenedFile(
  args: FsReadArgs,
  opened: FsOpenedSource & {
    target: string;
    path: string;
    revision?: string;
  },
  signal?: AbortSignal,
): Promise<FsReadResponse> {
  const contentType = opened.contentType ?? inferContentType(opened.path);
  try {
    if (contentType.trim().toLowerCase().startsWith("image/") && !isTextContentType(contentType)) {
      if (args.representation === "resource") {
        await opened.body.stream.cancel().catch(() => {});
        if (!opened.revision) {
          throw new Error(`Unable to identify file revision: ${opened.path}`);
        }
        return readImageResource(opened.path, contentType, opened.size, {
          type: "file",
          target: opened.target,
          path: opened.path,
          revision: opened.revision,
          contentType,
          size: opened.size,
        });
      }
      return readImage(opened.path, contentType, opened.body.stream, opened.size);
    }

    if (!isTextContentType(contentType)) {
      await opened.body.stream.cancel().catch(() => {});
      return {
        data: {
          ok: false,
          error: `Binary file (${contentType}, ${formatSize(opened.size)}) — not readable as text`,
        },
      };
    }

    const bytes = await bodyToBytes(opened.body, Infinity, signal);
    return readText(
      bytes,
      opened.path,
      contentType,
      opened.size,
      args.offset,
      args.limit,
      args.maxBytes,
    );
  } catch (error) {
    await opened.body.stream.cancel(error).catch(() => {});
    throw error;
  }
}

function readText(
  bytes: Uint8Array,
  path: string,
  contentType: string,
  size: number,
  offset?: number,
  limit?: number,
  maxBytes?: number,
): FsReadResponse {
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
  const requested = allLines.slice(start, start + count);
  const selection = selectTextLines(requested, maxBytes);
  const truncated = selection.truncated || start + requested.length < allLines.length;
  const nextOffset = !selection.partial && truncated && selection.lines > 0
    ? start + selection.lines
    : undefined;
  const data: FsReadFileSuccess = {
    ok: true,
    path,
    kind: "text",
    contentType,
    lines: selection.lines,
    size,
  };
  if (truncated) {
    data.truncated = true;
  }
  if (nextOffset !== undefined) {
    data.nextOffset = nextOffset;
  }

  return {
    data,
    body: bodyFromText(selection.content),
  };
}

function selectTextLines(
  lines: string[],
  maxBytes?: number,
): TextLineSelection {
  if (maxBytes === undefined) {
    return {
      content: lines.join("\n"),
      lines: lines.length,
      truncated: false,
      partial: false,
    };
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("fs.read maxBytes must be a positive safe integer");
  }

  const encoder = new TextEncoder();
  const selected: string[] = [];
  let usedBytes = 0;
  let partial = false;
  for (const line of lines) {
    const lineBytes = encoder.encode(line);
    const separatorBytes = selected.length === 0 ? 0 : 1;
    if (usedBytes + separatorBytes + lineBytes.byteLength <= maxBytes) {
      selected.push(line);
      usedBytes += separatorBytes + lineBytes.byteLength;
      continue;
    }
    if (selected.length === 0) {
      selected.push(decodeUtf8Prefix(lineBytes, maxBytes));
      partial = true;
    }
    break;
  }

  return {
    content: selected.join("\n"),
    lines: selected.length,
    truncated: partial || selected.length < lines.length,
    partial,
  };
}

function decodeUtf8Prefix(bytes: Uint8Array, maxBytes: number): string {
  let end = Math.min(bytes.byteLength, maxBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  while (end > 0) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

function readImage(
  path: string,
  mimeType: string,
  stream: ReadableStream<Uint8Array>,
  size: number,
): FsReadResponse {
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

function readImageResource(
  path: string,
  contentType: string,
  size: number,
  resource: FileResourceReference,
): FsReadResponse {
  return {
    data: {
      ok: true,
      path,
      kind: "image",
      contentType,
      size,
      resource,
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
  const rawPath = args.path.trim();
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
      return {
        ok: true,
        path,
        size: stat.size,
        isFile: true,
        isDirectory: false,
        contentType,
        revision: opened.etag,
      };
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
  const rawPath = args.path.trim();
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
    if (args.revision && opened.etag !== args.revision) {
      await opened.body?.cancel("Source revision is no longer available").catch(() => {});
      return {
        type: "res",
        id: frameId,
        ok: true,
        data: { ok: false, error: `Source revision is no longer available: ${path}` },
      };
    }
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
        revision: opened.etag,
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
  const rawPath = args.path.trim();
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
  transport?: FsDeviceTransport,
): Promise<FsCopyResult> {
  try {
    ctx.requestSignal?.throwIfAborted();
    const source = normalizeCopyEndpoint(args.source, ctx);
    let destination = normalizeCopyEndpoint(args.destination, ctx);
    assertCanAccessCopyEndpoint(source, ctx, "source");
    assertCanAccessCopyEndpoint(destination, ctx, "destination");

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
      if (ctx.targets.canHandle(source.target, "fs.copy")) {
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
      return await copyDeviceToGsv(source, destination, ctx, transport);
    }

    assertCanUseDeviceCapabilities(destination, ctx, [
      "fs.transfer.stat",
      "fs.transfer.receive",
    ]);
    return await copyDeviceToDevice(
      source,
      destination,
      transport,
      ctx,
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
  const opened = await openFsSource(source, ctx, { fs });
  const contentType = opened.contentType ?? inferContentType(source.path);
  await fs.writeFileStream(destination.path, opened.body.stream, {
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
  transport: FsDeviceTransport,
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
  transport: FsDeviceTransport,
): Promise<FsCopyResult> {
  const fs = createNativeFileSystem(ctx);
  const opened = await openFsSource(source, ctx, { fs });
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
      body: opened.body,
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
  transport: FsDeviceTransport,
): Promise<FsCopyResult> {
  const opened = await openFsSource(source, ctx, { transport });
  const contentType = opened.contentType ?? inferContentType(source.path);

  const fs = createNativeFileSystem(ctx);
  const writeResult = await fs.writeFileStream(destination.path, opened.body.stream, {
    expectedSize: opened.size,
    contentType,
    signal: ctx.requestSignal,
  });
  if (writeResult.size !== opened.size) {
    throw new Error(
      `Transfer size mismatch for ${destination.path}: expected ${opened.size}, got ${writeResult.size}`,
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

async function copyDeviceToDevice(
  source: Required<FsCopyEndpoint>,
  destination: Required<FsCopyEndpoint>,
  transport: FsDeviceTransport,
  ctx: KernelContext,
): Promise<FsCopyResult> {
  const opened = await openFsSource(source, ctx, { transport });
  const contentType = opened.contentType ?? inferContentType(source.path);

  const received = await requestDeviceResult<FsTransferReceiveResult>(
    transport,
    destination.target,
    "fs.transfer.receive",
    { path: destination.path, contentType },
    { ttlMs: 120_000, body: opened.body, signal: ctx.requestSignal },
  );
  if (!received.ok) {
    throw new Error(received.error);
  }
  if (received.bytesWritten !== opened.size) {
    throw new Error(
      `Transfer size mismatch for ${destination.path}: expected ${opened.size}, got ${received.bytesWritten}`,
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
  transport: FsDeviceTransport,
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
  transport: FsDeviceTransport,
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
      `Source is not a file: ${source.target}:${source.path}`,
    );
  }
  const sendArgs: JsonObject = { path: source.path };
  if (stat.revision) sendArgs.revision = stat.revision;
  const response = await transport.requestTarget(
    source.target,
    "fs.transfer.send",
    sendArgs,
    { ttlMs: 120_000, signal },
  );
  // SAFETY: The fs.transfer.send response is decoded by the transport contract.
  const result = response.data as FsTransferSendResult;
  if (!result.ok) {
    throw new Error(result.error);
  }
  if (!response.body) {
    throw new Error("fs.transfer.send returned no response body");
  }
  if (stat.revision && result.revision !== stat.revision) {
    void response.body.stream.cancel("Source revision changed during transfer");
    throw new Error(`Source revision changed during transfer: ${source.path}`);
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
  transport: FsDeviceTransport,
  targetId: string,
  call: string,
  args: JsonObject,
  options?: { ttlMs?: number; body?: FrameBody; signal?: AbortSignal },
): Promise<T> {
  // SAFETY: The caller selects T from the syscall response contract for this request.
  return (await transport.requestTarget(targetId, call, args, options)).data as T;
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
  const target = endpoint.target?.trim() || "gsv";
  const rawPath = endpoint.path?.trim() ?? "";
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
  access: "source" | "destination",
): void {
  if (endpoint.target === "gsv") {
    return;
  }
  if (isContactTarget(endpoint.target)) {
    if (access === "destination") throw new Error("Contact resources are read-only");
    return;
  }
  const identity = ctx.identity!.process;
  if (!ctx.targets.canAccess(endpoint.target, identity.uid, identity.gids)) {
    throw new Error(`Access denied to device: ${endpoint.target}`);
  }
}

function isContactTarget(target: string): boolean {
  return target.startsWith("contact:") && target.length > "contact:".length;
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
    if (!ctx.targets.canHandle(endpoint.target, syscall)) {
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
  const query = args.query.trim();
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
