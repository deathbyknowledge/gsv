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
  createWorkspaceBackend,
  resolveUserPath,
  formatSize,
  isTextContentType,
  inferContentType,
} from "../../fs";
import type { KernelContext } from "../../kernel/context";
import type { FsReadArgs, FsReadResult } from "../../syscalls/read";
import type { FsWriteArgs, FsWriteResult } from "../../syscalls/write";
import type { FsEditArgs, FsEditResult } from "../../syscalls/edit";
import type { FsDeleteArgs, FsDeleteResult } from "../../syscalls/delete";
import type { FsSearchArgs, FsSearchResult, FsSearchMatch } from "../../syscalls/search";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_SEARCH_MATCHES = 500;

function makeFs(ctx: KernelContext): GsvFs {
  const identity = ctx.identity!.process;
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
    createWorkspaceBackend(ctx.env, identity, ctx.workspaces),
  );
}

function resolve(path: string, ctx: KernelContext): string {
  const identity = ctx.identity!.process;
  return resolveUserPath(path, identity.home, identity.cwd);
}

export async function handleFsRead(args: FsReadArgs, ctx: KernelContext): Promise<FsReadResult> {
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
      { type: "text", text: `Read image ${path} [${mimeType}, ${formatSize(size)}]` },
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


export async function handleFsWrite(args: FsWriteArgs, ctx: KernelContext): Promise<FsWriteResult> {
  const fs = makeFs(ctx);
  const p = resolve(args.path, ctx);

  try {
    await fs.writeFile(p, args.content);
    return { ok: true, path: p, size: args.content.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleFsEdit(args: FsEditArgs, ctx: KernelContext): Promise<FsEditResult> {
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
    if (msg.includes("ENOENT")) return { ok: false, error: `File not found: ${p}` };
    return { ok: false, error: msg };
  }
}


export async function handleFsDelete(args: FsDeleteArgs, ctx: KernelContext): Promise<FsDeleteResult> {
  const fs = makeFs(ctx);
  const p = resolve(args.path, ctx);

  try {
    const exists = await fs.exists(p);
    if (!exists) return { ok: false, error: `File not found: ${p}` };

    await fs.rm(p, { force: true });
    return { ok: true, path: p };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleFsSearch(args: FsSearchArgs, ctx: KernelContext): Promise<FsSearchResult> {
  let regex: RegExp;
  try {
    regex = new RegExp(args.pattern, "g");
  } catch {
    return { ok: false, error: `Invalid regex: ${args.pattern}` };
  }

  const identity = ctx.identity!.process;
  const prefix = args.path
    ? resolveUserPath(args.path, identity.home, identity.cwd)
    : identity.cwd;

  const workspaceBackend = createWorkspaceBackend(ctx.env, identity, ctx.workspaces);
  if (prefix.startsWith("/workspaces/") && !workspaceBackend) {
    return { ok: false, error: `Workspace backend is unavailable for ${prefix}` };
  }
  if (workspaceBackend?.handles(prefix)) {
    try {
      const result = await workspaceBackend.search(prefix, regex, args.include);
      return {
        ok: true,
        matches: result.matches,
        count: result.matches.length,
        truncated: result.truncated,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const bucket = ctx.env.STORAGE;
  const searchPrefix = prefix.endsWith("/") ? prefix : prefix + "/";

  const matches: FsSearchMatch[] = [];
  let truncated = false;
  let cursor: string | undefined;

  outer:
  do {
    const listed = await bucket.list({
      prefix: searchPrefix === "/" ? undefined : searchPrefix.slice(1),
      cursor,
      limit: 100,
    });

    for (const obj of listed.objects) {
      if (args.include && !matchGlob(args.include, obj.key)) continue;

      const contentType = obj.httpMetadata?.contentType || "text/plain";
      if (!isTextContentType(contentType)) continue;

      const full = await bucket.get(obj.key);
      if (!full) continue;

      const text = await full.text();
      const lines = text.split("\n");

      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          matches.push({ path: "/" + obj.key, line: i + 1, content: lines[i] });
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
