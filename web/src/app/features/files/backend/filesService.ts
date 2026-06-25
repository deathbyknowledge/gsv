import type { GSVClient } from "@humansandmachines/gsv/client";
import type {
  FilesDeletePayload,
  FilesErrorPayload,
  FilesReadPayload,
  FilesSearchPayload,
  FilesTarget,
  FilesWritePayload,
} from "../domain/models";
import {
  normalizeFilesDelete,
  normalizeFilesRead,
  normalizeFilesSearch,
  normalizeFilesTargets,
  normalizeFilesWrite,
} from "../domain/normalization";
import { detectPathStyle, normalizePath, normalizeTarget, targetArgs } from "../domain/paths";

export type FilesClient = Pick<GSVClient, "call">;

export type FilesReadArgs = {
  target?: string | null;
  path: string;
  offset?: number;
  limit?: number;
};

export type FilesSearchArgs = {
  target?: string | null;
  path?: string | null;
  query: string;
  include?: string;
};

export type FilesWriteArgs = {
  target?: string | null;
  path: string;
  content: string;
};

export type FilesDeleteArgs = {
  target?: string | null;
  path: string;
};

export async function listFilesTargets(client: FilesClient): Promise<FilesTarget[]> {
  const payload = await client.call<unknown>("sys.device.list", { includeOffline: true });
  return normalizeFilesTargets(payload);
}

function isOkPayload(payload: unknown): boolean {
  return Boolean(payload && typeof payload === "object" && (payload as { ok?: unknown }).ok === true);
}

async function readRawPathWithFallback(client: FilesClient, target: string, path: string): Promise<{ path: string; payload: unknown }> {
  const payload = await client.call<unknown>("fs.read", targetArgs(target, { path }));
  if (isOkPayload(payload) || target === "gsv") {
    return { path, payload };
  }

  const fallbackPath = path.startsWith("/") ? path.replace(/^\/+/, "") || "." : `/${path}`;
  if (fallbackPath === path) {
    return { path, payload };
  }

  const fallbackPayload = await client.call<unknown>("fs.read", targetArgs(target, { path: fallbackPath }));
  if (isOkPayload(fallbackPayload)) {
    return { path: fallbackPath, payload: fallbackPayload };
  }

  return { path, payload };
}

export async function readFilesPath(client: FilesClient, args: FilesReadArgs): Promise<FilesReadPayload | FilesErrorPayload> {
  const target = normalizeTarget(args.target);
  const path = normalizePath(args.path, detectPathStyle(args.path));
  if (args.offset !== undefined || args.limit !== undefined) {
    const payload = await client.call<unknown>("fs.read", targetArgs(target, {
      path,
      offset: args.offset,
      limit: args.limit,
    }));
    return normalizeFilesRead(payload, target, path);
  }

  const result = await readRawPathWithFallback(client, target, path);
  return normalizeFilesRead(result.payload, target, result.path);
}

export async function searchFiles(client: FilesClient, args: FilesSearchArgs): Promise<FilesSearchPayload | FilesErrorPayload> {
  const target = normalizeTarget(args.target);
  const path = normalizePath(args.path ?? ".", detectPathStyle(args.path ?? "."));
  const query = args.query.trim();
  if (!query) {
    return {
      ok: true,
      target,
      path,
      query,
      matches: [],
      count: 0,
      truncated: false,
    };
  }

  const payload = await client.call<unknown>("fs.search", targetArgs(target, {
    path,
    query,
    include: args.include,
  }));

  return normalizeFilesSearch(payload, target, path, query);
}

export async function writeFilesPath(client: FilesClient, args: FilesWriteArgs): Promise<FilesWritePayload | FilesErrorPayload> {
  const target = normalizeTarget(args.target);
  const path = normalizePath(args.path, detectPathStyle(args.path));
  const payload = await client.call<unknown>("fs.write", targetArgs(target, {
    path,
    content: args.content,
  }));

  return normalizeFilesWrite(payload, target, path);
}

export async function createFilesPath(client: FilesClient, args: FilesWriteArgs): Promise<FilesWritePayload | FilesErrorPayload> {
  return writeFilesPath(client, args);
}

export async function deleteFilesPath(client: FilesClient, args: FilesDeleteArgs): Promise<FilesDeletePayload | FilesErrorPayload> {
  const target = normalizeTarget(args.target);
  const path = normalizePath(args.path, detectPathStyle(args.path));
  const payload = await client.call<unknown>("fs.delete", targetArgs(target, { path }));

  return normalizeFilesDelete(payload, target, path);
}
