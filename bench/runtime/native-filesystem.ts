import { posix } from "node:path";
import {
  InMemoryFs,
  type IFileSystem,
} from "just-bash";
import type {
  JsonObject,
  JsonValue,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { formatAgentToolResponse } from "../../workers/gateway/src/process/tool-response";
import type { SyntheticInvocationResult } from "./environment";

export type SyntheticFilesystemCall =
  | "fs.read"
  | "fs.write"
  | "fs.edit"
  | "fs.delete"
  | "fs.search";

const readArgsSchema = z.object({
  path: z.string(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
}).passthrough();
const writeArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
}).passthrough();
const editArgsSchema = z.object({
  path: z.string(),
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
}).passthrough();
const deleteArgsSchema = z.object({
  path: z.string(),
}).passthrough();
const searchArgsSchema = z.object({
  query: z.string(),
  path: z.string().optional(),
  include: z.string().optional(),
}).passthrough();

/** Persistent filesystem backing both native GSV tools and native shell calls. */
export class SyntheticNativeFilesystem {
  readonly fs: IFileSystem;

  constructor(fs: IFileSystem = new InMemoryFs()) {
    this.fs = fs;
  }

  async invoke(
    call: SyntheticFilesystemCall,
    args: JsonObject,
  ): Promise<SyntheticInvocationResult> {
    switch (call) {
      case "fs.read":
        return this.read(args);
      case "fs.write":
        return this.write(args);
      case "fs.edit":
        return this.edit(args);
      case "fs.delete":
        return this.delete(args);
      case "fs.search":
        return this.search(args);
    }
  }

  private async read(args: JsonObject): Promise<SyntheticInvocationResult> {
    const parsed = readArgsSchema.safeParse(args);
    if (!parsed.success) return failure("Invalid fs.read arguments");
    const path = normalizePath(parsed.data.path);
    try {
      const stat = await this.fs.stat(path);
      if (stat.isDirectory) {
        const entries = this.fs.readdirWithFileTypes
          ? await this.fs.readdirWithFileTypes(path)
          : await Promise.all(
            (await this.fs.readdir(path)).map(async (name) => {
              const child = await this.fs.stat(posix.join(path, name));
              return {
                name,
                isFile: child.isFile,
                isDirectory: child.isDirectory,
                isSymbolicLink: child.isSymbolicLink,
              };
            }),
          );
        return {
          value: {
            ok: true,
            path,
            files: entries
              .filter((entry) => !entry.isDirectory)
              .map((entry) => entry.name)
              .sort(),
            directories: entries
              .filter((entry) => entry.isDirectory)
              .map((entry) => entry.name)
              .sort(),
          },
          isError: false,
        };
      }
      if (!stat.isFile) return failure("Not a regular file: " + path);
      const content = await this.fs.readFile(path, "utf8");
      const offset = parsed.data.offset ?? 0;
      const limit = parsed.data.limit ?? 2_000;
      const lines = splitLines(content);
      const selected = lines.slice(offset, offset + limit);
      const nextOffset = offset + selected.length < lines.length
        ? offset + selected.length
        : undefined;
      const result: JsonObject = {
        ok: true,
        path,
        kind: "text",
        contentType: "text/plain; charset=utf-8",
        content: selected.join("\n"),
        lines: selected.length,
        size: Buffer.byteLength(content),
      };
      if (nextOffset !== undefined) {
        result.truncated = true;
        result.nextOffset = nextOffset;
      }
      return {
        value: formatAgentToolResponse("fs.read", args, result),
        isError: false,
      };
    } catch (error) {
      return failure(
        error instanceof Error && error.message
          ? error.message
          : "No such file or directory: " + path,
      );
    }
  }

  private async write(args: JsonObject): Promise<SyntheticInvocationResult> {
    const parsed = writeArgsSchema.safeParse(args);
    if (!parsed.success) return failure("Invalid fs.write arguments");
    const path = normalizePath(parsed.data.path);
    try {
      await this.fs.writeFile(path, parsed.data.content, "utf8");
      return {
        value: {
          ok: true,
          path,
          size: Buffer.byteLength(parsed.data.content),
        },
        isError: false,
      };
    } catch (error) {
      return failure(
        error instanceof Error && error.message
          ? error.message
          : "Could not write file: " + path,
      );
    }
  }

  private async edit(args: JsonObject): Promise<SyntheticInvocationResult> {
    const parsed = editArgsSchema.safeParse(args);
    if (!parsed.success) return failure("Invalid fs.edit arguments");
    const path = normalizePath(parsed.data.path);
    try {
      const content = await this.fs.readFile(path, "utf8");
      const occurrences = countOccurrences(content, parsed.data.oldString);
      if (occurrences === 0) return failure("Text not found in " + path);
      const replaceAll = parsed.data.replaceAll === true;
      const updated = replaceAll
        ? content.replaceAll(parsed.data.oldString, parsed.data.newString)
        : content.replace(parsed.data.oldString, parsed.data.newString);
      await this.fs.writeFile(path, updated, "utf8");
      return {
        value: {
          ok: true,
          path,
          replacements: replaceAll ? occurrences : 1,
        },
        isError: false,
      };
    } catch (error) {
      return failure(
        error instanceof Error && error.message
          ? error.message
          : "No such file: " + path,
      );
    }
  }

  private async delete(args: JsonObject): Promise<SyntheticInvocationResult> {
    const parsed = deleteArgsSchema.safeParse(args);
    if (!parsed.success) return failure("Invalid fs.delete arguments");
    const path = normalizePath(parsed.data.path);
    try {
      const stat = await this.fs.stat(path);
      if (!stat.isFile) return failure("Not a regular file: " + path);
      await this.fs.rm(path);
      return { value: { ok: true, path }, isError: false };
    } catch (error) {
      return failure(
        error instanceof Error && error.message
          ? error.message
          : "No such file: " + path,
      );
    }
  }

  private async search(args: JsonObject): Promise<SyntheticInvocationResult> {
    const parsed = searchArgsSchema.safeParse(args);
    if (!parsed.success) return failure("Invalid fs.search arguments");
    const root = parsed.data.path ? normalizePath(parsed.data.path) : "/";
    const matches: JsonValue[] = [];
    for (const path of this.fs.getAllPaths().sort()) {
      if (!isWithin(path, root)) continue;
      if (
        parsed.data.include
        && !matchesGlob(posix.basename(path), parsed.data.include)
      ) {
        continue;
      }
      const stat = await this.fs.stat(path);
      if (!stat.isFile) continue;
      const content = await this.fs.readFile(path, "utf8");
      splitLines(content).forEach((line, index) => {
        if (line.includes(parsed.data.query)) {
          matches.push({ path, line: index + 1, content: line });
        }
      });
    }
    return {
      value: { ok: true, matches, count: matches.length },
      isError: false,
    };
  }
}

export function isSyntheticFilesystemCall(
  call: string,
): call is SyntheticFilesystemCall {
  return call === "fs.read"
    || call === "fs.write"
    || call === "fs.edit"
    || call === "fs.delete"
    || call === "fs.search";
}

function normalizePath(path: string): string {
  return posix.resolve("/", path);
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function countOccurrences(content: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function isWithin(path: string, root: string): boolean {
  return root === "/" || path === root || path.startsWith(root + "/");
}

function matchesGlob(value: string, glob: string): boolean {
  const escaped = glob.replace(/[.+^$()|[\]{}\\]/gu, "\\$&");
  const pattern = escaped.replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp("^" + pattern + "$", "u").test(value);
}

function failure(error: string): SyntheticInvocationResult {
  return { value: { ok: false, error }, isError: true };
}
