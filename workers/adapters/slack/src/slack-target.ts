import { z } from "zod";
import type { AdapterTargetRequestFrame, AdapterTargetResponseFrame } from "../../../../packages/gsv/src/services/adapters.js";
import type { FsReadArgs, FsReadResult, FsSearchArgs, FsSearchResult } from "../../../../packages/gsv/src/protocol/syscalls/fs.js";
import { bodyFromText } from "../../../../packages/gsv/src/protocol/body.js";
import { executeSlackTargetShell, type SlackTargetShellInput } from "./slack-target-shell";
import { normalizeSlackPath, SlackTargetFileSystem } from "./slack-target-fs";

export type SlackTargetCall = "shell.exec" | "fs.read" | "fs.search";
export type SlackTargetRequest = AdapterTargetRequestFrame<SlackTargetCall>;
export type SlackTargetResponse = AdapterTargetResponseFrame<SlackTargetCall>;
export const SLACK_TARGET_SYSCALLS: SlackTargetCall[] = ["shell.exec", "fs.read", "fs.search"];

const pathSchema = z.string().min(1).max(4_096).refine((value) => !value.includes("\0"));
const envelope = {
  type: z.literal("req"),
  id: z.string().min(1).max(512).refine((value) => value.trim().length > 0),
  runId: z.string().min(1).max(512).optional(),
  deadlineAt: z.number().finite(),
};
export const managedSlackTargetRequestSchema = z.discriminatedUnion("call", [
  z.object({
    ...envelope,
    call: z.literal("shell.exec"),
    args: z.object({
      input: z.string().min(1).max(1024 * 1024),
      cwd: pathSchema.or(z.literal("")).optional(),
      sessionId: z.string().min(1).max(512).optional(),
      timeout: z.number().finite().int().positive().max(120_000).optional(),
      background: z.boolean().optional(),
      yieldMs: z.number().finite().int().nonnegative().max(120_000).optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...envelope,
    call: z.literal("fs.read"),
    args: z.object({
      path: pathSchema,
      offset: z.number().int().nonnegative().safe().optional(),
      limit: z.number().int().nonnegative().safe().optional(),
      maxBytes: z.number().int().positive().safe().optional(),
      representation: z.enum(["content", "resource", "reference"]).optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...envelope,
    call: z.literal("fs.search"),
    args: z.object({
      path: pathSchema.optional(),
      query: z.string().min(1).max(4_096),
      include: z.string().min(1).max(512).optional(),
    }).strict(),
  }).strict(),
]);

export async function executeSlackTarget(
  frame: SlackTargetRequest,
  input: Omit<SlackTargetShellInput, "args" | "fs">,
): Promise<SlackTargetResponse> {
  const fs = new SlackTargetFileSystem(input);
  if (frame.call === "shell.exec") {
    return { type: "res", id: frame.id, ok: true, data: await executeSlackTargetShell({ ...input, args: frame.args, fs }) };
  }
  try {
    if (frame.call === "fs.read") return { type: "res", id: frame.id, ok: true, ...await read(fs, frame.args) };
    return { type: "res", id: frame.id, ok: true, data: await search(fs, frame.args) };
  } catch (error) {
    input.signal.throwIfAborted();
    return { type: "res", id: frame.id, ok: true, data: { ok: false, error: error instanceof Error ? error.message : "Slack filesystem operation failed" } };
  }
}

async function read(fs: SlackTargetFileSystem, args: FsReadArgs): Promise<{
  data: FsReadResult;
  body?: ReturnType<typeof bodyFromText>;
}> {
  const path = normalizeSlackPath(args.path);
  const resource = await fs.get(path);
  if (resource.kind === "directory") return { data: { ok: true, path, ...await resource.list() } };
  if (args.representation === "reference") throw new Error("Slack live resources do not support immutable file references");
  const allLines = resource.text.split("\n");
  const start = args.offset ?? 0;
  const requested = allLines.slice(start, args.limit === undefined ? undefined : start + args.limit);
  const selected: string[] = [];
  const encoder = new TextEncoder();
  let bytes = 0;
  let partial = false;
  for (const line of requested) {
    const encoded = encoder.encode(line);
    const length = encoded.byteLength + (selected.length ? 1 : 0);
    if (args.maxBytes !== undefined && bytes + length > args.maxBytes) {
      if (selected.length === 0) {
        selected.push(new TextDecoder().decode(encoded.subarray(0, args.maxBytes), { stream: true }));
        partial = true;
      }
      break;
    }
    selected.push(line);
    bytes += length;
  }
  const truncated = partial || start + selected.length < allLines.length;
  const data: FsReadResult = {
    ok: true, path, kind: "text", contentType: resource.contentType,
    size: encoder.encode(resource.text).byteLength,
    lines: selected.length,
  };
  if (truncated) data.truncated = true;
  if (!partial && truncated && selected.length) data.nextOffset = start + selected.length;
  return {
    data,
    body: bodyFromText(selected.join("\n")),
  };
}

async function search(fs: SlackTargetFileSystem, args: FsSearchArgs): Promise<FsSearchResult> {
  if (!args.query.trim()) throw new Error("fs.search requires a non-empty query");
  const root = normalizeSlackPath(args.path ?? "/");
  const paths = await fs.searchFiles(root);
  const include = args.include ? globPattern(args.include) : undefined;
  const matches: Array<{ path: string; line: number; content: string }> = [];
  for (const path of paths) {
    const relative = path === root ? path.split("/").at(-1)! : path.slice(root.length + 1);
    if (include && !include.test(args.include!.includes("/") ? relative : path.split("/").at(-1)!)) continue;
    const file = await fs.get(path);
    if (file.kind !== "file") continue;
    for (const [line, content] of file.text.split("\n").entries()) {
      if (!content.includes(args.query)) continue;
      if (matches.length === 200) return { ok: true, matches, count: matches.length, truncated: true };
      matches.push({ path, line: line + 1, content });
    }
  }
  return { ok: true, matches, count: matches.length };
}

function globPattern(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const character = pattern[i];
    if (character === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") { source += "(?:.*/)?"; i += 2; }
      else { source += ".*"; i += 1; }
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}
