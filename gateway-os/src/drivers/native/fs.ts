/**
 * Native FS driver — wraps R2FS as syscall handlers.
 *
 * Each handler instantiates R2FS with the caller's ProcessIdentity
 * from KernelContext and delegates to the corresponding R2FS method.
 */

import { R2FS } from "../../fs";
import type { KernelContext } from "../../kernel/context";
import type { FsReadArgs, FsReadResult } from "../../syscalls/read";
import type { FsWriteArgs, FsWriteResult } from "../../syscalls/write";
import type { FsEditArgs, FsEditResult } from "../../syscalls/edit";
import type { FsDeleteArgs, FsDeleteResult } from "../../syscalls/delete";
import type { FsSearchArgs, FsSearchResult, FsSearchMatch } from "../../syscalls/search";

const MAX_SEARCH_MATCHES = 500;

function makeFs(ctx: KernelContext): R2FS {
  const identity = ctx.identity!.process;
  return new R2FS(ctx.env.STORAGE, identity);
}

export async function handleFsRead(args: FsReadArgs, ctx: KernelContext): Promise<FsReadResult> {
  return makeFs(ctx).read(args);
}

export async function handleFsWrite(args: FsWriteArgs, ctx: KernelContext): Promise<FsWriteResult> {
  return makeFs(ctx).write(args);
}

export async function handleFsEdit(args: FsEditArgs, ctx: KernelContext): Promise<FsEditResult> {
  return makeFs(ctx).edit(args);
}

export async function handleFsDelete(args: FsDeleteArgs, ctx: KernelContext): Promise<FsDeleteResult> {
  return makeFs(ctx).delete(args);
}

export async function handleFsSearch(args: FsSearchArgs, ctx: KernelContext): Promise<FsSearchResult> {
  const fs = makeFs(ctx);
  const bucket = ctx.env.STORAGE;

  let regex: RegExp;
  try {
    regex = new RegExp(args.pattern, "g");
  } catch {
    return { ok: false, error: `Invalid regex: ${args.pattern}` };
  }

  const prefix = args.path ? fs.normalizePath(args.path) : "/";
  const searchPrefix = prefix.endsWith("/") ? prefix : prefix + "/";

  const matches: FsSearchMatch[] = [];
  let truncated = false;
  let cursor: string | undefined;

  outer:
  do {
    const listed = await bucket.list({
      prefix: searchPrefix === "/" ? undefined : searchPrefix,
      cursor,
      limit: 100,
    });

    for (const obj of listed.objects) {
      if (args.include && !matchGlob(args.include, obj.key)) continue;

      const contentType = obj.httpMetadata?.contentType || "text/plain";
      if (!contentType.startsWith("text/") &&
          contentType !== "application/json" &&
          contentType !== "application/yaml" &&
          contentType !== "application/javascript" &&
          contentType !== "application/typescript") {
        continue;
      }

      const full = await bucket.get(obj.key);
      if (!full) continue;

      const text = await full.text();
      const lines = text.split("\n");

      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          matches.push({
            path: "/" + obj.key,
            line: i + 1,
            content: lines[i],
          });
          if (matches.length >= MAX_SEARCH_MATCHES) {
            truncated = true;
            break outer;
          }
        }
      }
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return { ok: true, matches, count: matches.length, truncated };
}

function matchGlob(pattern: string, path: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`(^|/)${escaped}$`).test(path);
}
