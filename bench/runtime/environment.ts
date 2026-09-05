import { posix } from "node:path";
import type {
  JsonObject,
  JsonValue,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { hasCapability } from "../../workers/gateway/src/kernel/capabilities";
import { formatAgentToolResponse } from "../../workers/gateway/src/process/tool-response";
import type {
  SyntheticCommandSpec,
  SyntheticTargetEffect,
  SyntheticTargetKind,
  SyntheticTargetSnapshot,
  SyntheticTargetSpec,
} from "./schema";

export type SyntheticInvocationResult = {
  value: JsonValue;
  isError: boolean;
};

export type SyntheticCapabilityCall =
  | "fs.read"
  | "fs.write"
  | "fs.edit"
  | "fs.delete"
  | "fs.search"
  | "shell.exec";

export interface SyntheticTargetEnvironment {
  readonly id: string;
  readonly kind: SyntheticTargetKind;
  readonly driver: string;
  readonly ownerUid: number;
  readonly label: string;
  readonly description: string;
  readonly platform: string;
  readonly version: string;
  readonly implements: string[];
  isOnline(): boolean;
  setOnline(online: boolean): void;
  canAccess(uid: number, gids: readonly number[]): boolean;
  canHandle(call: string): call is SyntheticCapabilityCall;
  grantAccess(gid: number): void;
  revokeAccess(gid: number): void;
  setState(key: string, value: JsonValue): void;
  writeFile(path: string, content: string): void;
  invoke(
    call: SyntheticCapabilityCall,
    args: JsonObject,
  ): Promise<SyntheticInvocationResult>;
  snapshot(): SyntheticTargetSnapshot;
}

type EnvironmentDefaults = {
  label: string;
  description: string;
  platform: string;
  implements: string[];
};

const TARGET_DEFAULTS = {
  laptop: {
    label: "Laptop",
    description: "A synthetic personal computer target.",
    platform: "linux",
    implements: ["fs.*", "shell.exec"],
  },
  server: {
    label: "Server",
    description: "A synthetic remote server target.",
    platform: "linux",
    implements: ["fs.*", "shell.exec"],
  },
  browser: {
    label: "Browser",
    description: "A synthetic browser-profile capability environment.",
    platform: "browser",
    implements: ["fs.*", "shell.exec"],
  },
  slack: {
    label: "Slack",
    description: "A synthetic Slack account target with a composable command environment.",
    platform: "slack",
    implements: ["shell.exec"],
  },
} satisfies Record<SyntheticTargetKind, EnvironmentDefaults>;

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
const shellArgsSchema = z.object({
  input: z.string(),
}).passthrough();

export class SyntheticCapabilityEnvironment implements SyntheticTargetEnvironment {
  readonly id: string;
  readonly kind: SyntheticTargetKind;
  readonly driver: string;
  readonly ownerUid: number;
  readonly label: string;
  readonly description: string;
  readonly platform: string;
  readonly version: string;
  readonly implements: string[];

  private readonly accessGids = new Set<number>();
  private readonly commands = new Map<string, SyntheticCommandSpec>();
  private readonly files = new Map<string, string>();
  private state: JsonObject;
  private online: boolean;

  constructor(spec: SyntheticTargetSpec) {
    const defaults = TARGET_DEFAULTS[spec.kind];
    this.id = spec.id;
    this.kind = spec.kind;
    this.driver = spec.driver ?? "memory";
    this.ownerUid = spec.ownerUid;
    this.label = spec.label ?? defaults.label;
    this.description = spec.description ?? defaults.description;
    this.platform = spec.platform ?? defaults.platform;
    this.version = spec.version ?? "synthetic-v1";
    this.implements = normalizeStringSet(spec.implements ?? defaults.implements);
    this.online = spec.online;
    this.state = structuredClone(spec.state ?? {});

    for (const gid of spec.accessGids) this.accessGids.add(gid);
    for (const [path, content] of Object.entries(spec.files ?? {})) {
      this.files.set(normalizePath(path), content);
    }
    for (const [command, result] of Object.entries(spec.commands ?? {})) {
      this.commands.set(command, structuredClone(result));
    }
  }

  isOnline(): boolean {
    return this.online;
  }

  setOnline(online: boolean): void {
    this.online = online;
  }

  canAccess(uid: number, gids: readonly number[]): boolean {
    return uid === 0
      || uid === this.ownerUid
      || gids.some((gid) => this.accessGids.has(gid));
  }

  canHandle(call: string): call is SyntheticCapabilityCall {
    return isSyntheticCapabilityCall(call)
      && hasCapability(this.implements, call);
  }

  grantAccess(gid: number): void {
    this.accessGids.add(gid);
  }

  revokeAccess(gid: number): void {
    this.accessGids.delete(gid);
  }

  setState(key: string, value: JsonValue): void {
    this.state = {
      ...this.state,
      [key]: structuredClone(value),
    };
  }

  writeFile(path: string, content: string): void {
    this.files.set(normalizePath(path), content);
  }

  async invoke(
    call: SyntheticCapabilityCall,
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
      case "shell.exec":
        return this.shell(args);
    }
  }

  snapshot(): SyntheticTargetSnapshot {
    return {
      id: this.id,
      kind: this.kind,
      driver: this.driver,
      ownerUid: this.ownerUid,
      accessGids: [...this.accessGids].sort((left, right) => left - right),
      label: this.label,
      description: this.description,
      platform: this.platform,
      version: this.version,
      online: this.online,
      implements: [...this.implements],
      files: Object.fromEntries(
        [...this.files.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
      state: structuredClone(this.state),
    };
  }

  private read(args: JsonObject): SyntheticInvocationResult {
    const parsed = readArgsSchema.safeParse(args);
    if (!parsed.success) return failure("Invalid fs.read arguments");
    const path = normalizePath(parsed.data.path);
    const content = this.files.get(path);
    if (content !== undefined) {
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
    }

    const directory = listDirectory(this.files, path);
    if (directory) {
      return {
        value: {
          ok: true,
          path,
          files: directory.files,
          directories: directory.directories,
        },
        isError: false,
      };
    }
    return failure("No such file or directory: " + path);
  }

  private write(args: JsonObject): SyntheticInvocationResult {
    const parsed = writeArgsSchema.safeParse(args);
    if (!parsed.success) return failure("Invalid fs.write arguments");
    const path = normalizePath(parsed.data.path);
    this.files.set(path, parsed.data.content);
    return {
      value: {
        ok: true,
        path,
        size: Buffer.byteLength(parsed.data.content),
      },
      isError: false,
    };
  }

  private edit(args: JsonObject): SyntheticInvocationResult {
    const parsed = editArgsSchema.safeParse(args);
    if (!parsed.success) return failure("Invalid fs.edit arguments");
    const path = normalizePath(parsed.data.path);
    const content = this.files.get(path);
    if (content === undefined) return failure("No such file: " + path);
    const occurrences = countOccurrences(content, parsed.data.oldString);
    if (occurrences === 0) {
      return failure("Text not found in " + path);
    }
    const replaceAll = parsed.data.replaceAll === true;
    const replacements = replaceAll ? occurrences : 1;
    const updated = replaceAll
      ? content.replaceAll(parsed.data.oldString, parsed.data.newString)
      : content.replace(parsed.data.oldString, parsed.data.newString);
    this.files.set(path, updated);
    return {
      value: { ok: true, path, replacements },
      isError: false,
    };
  }

  private delete(args: JsonObject): SyntheticInvocationResult {
    const parsed = deleteArgsSchema.safeParse(args);
    if (!parsed.success) return failure("Invalid fs.delete arguments");
    const path = normalizePath(parsed.data.path);
    if (!this.files.delete(path)) return failure("No such file: " + path);
    return { value: { ok: true, path }, isError: false };
  }

  private search(args: JsonObject): SyntheticInvocationResult {
    const parsed = searchArgsSchema.safeParse(args);
    if (!parsed.success) return failure("Invalid fs.search arguments");
    const root = parsed.data.path ? normalizePath(parsed.data.path) : "/";
    const include = parsed.data.include ?? null;
    const matches: JsonValue[] = [];
    for (const [path, content] of [...this.files.entries()].sort()) {
      if (!isWithin(path, root) || (include && !matchesGlob(posix.basename(path), include))) {
        continue;
      }
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

  private shell(args: JsonObject): SyntheticInvocationResult {
    const parsed = shellArgsSchema.safeParse(args);
    if (!parsed.success) return failure("Invalid shell.exec arguments", "shell");
    const command = this.commands.get(parsed.data.input);
    if (!command) {
      return failure(
        "Synthetic " + this.id + " shell has no command configured for: " + parsed.data.input,
        "shell",
      );
    }
    const exitCode = command.exitCode ?? 0;
    if (exitCode === 0) {
      for (const effect of command.effects ?? []) this.applyEffect(effect);
      return {
        value: {
          status: "completed",
          output: command.output,
          exitCode,
          ok: true,
        },
        isError: false,
      };
    }
    return {
      value: {
        status: "failed",
        output: command.output,
        error: command.output.trim() || "Command exited with code " + exitCode,
        exitCode,
        ok: true,
      },
      isError: true,
    };
  }

  private applyEffect(effect: SyntheticTargetEffect): void {
    switch (effect.type) {
      case "state.set":
        this.setState(effect.key, effect.value);
        break;
      case "file.write":
        this.writeFile(effect.path, effect.content);
        break;
      case "file.delete":
        this.files.delete(normalizePath(effect.path));
        break;
    }
  }
}

export function laptopEnvironment(
  spec: Omit<SyntheticTargetSpec, "kind">,
): SyntheticCapabilityEnvironment {
  return new SyntheticCapabilityEnvironment({ ...spec, kind: "laptop" });
}

export function serverEnvironment(
  spec: Omit<SyntheticTargetSpec, "kind">,
): SyntheticCapabilityEnvironment {
  return new SyntheticCapabilityEnvironment({ ...spec, kind: "server" });
}

export function browserEnvironment(
  spec: Omit<SyntheticTargetSpec, "kind">,
): SyntheticCapabilityEnvironment {
  return new SyntheticCapabilityEnvironment({ ...spec, kind: "browser" });
}

export function slackEnvironment(
  spec: Omit<SyntheticTargetSpec, "kind">,
): SyntheticCapabilityEnvironment {
  return new SyntheticCapabilityEnvironment({ ...spec, kind: "slack" });
}

export function environmentFromSpec(
  spec: SyntheticTargetSpec,
): SyntheticCapabilityEnvironment {
  return new SyntheticCapabilityEnvironment(spec);
}

function isSyntheticCapabilityCall(call: string): call is SyntheticCapabilityCall {
  return call === "fs.read"
    || call === "fs.write"
    || call === "fs.edit"
    || call === "fs.delete"
    || call === "fs.search"
    || call === "shell.exec";
}

function failure(
  error: string,
  kind: "fs" | "shell" = "fs",
): SyntheticInvocationResult {
  return kind === "shell"
    ? {
      value: { status: "failed", output: "", error },
      isError: true,
    }
    : { value: { ok: false, error }, isError: true };
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

function listDirectory(
  files: ReadonlyMap<string, string>,
  directory: string,
): { files: string[]; directories: string[] } | null {
  const prefix = directory === "/" ? "/" : directory + "/";
  const childFiles = new Set<string>();
  const childDirectories = new Set<string>();
  let found = directory === "/";
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) continue;
    found = true;
    const relative = path.slice(prefix.length);
    const [first, ...rest] = relative.split("/");
    if (!first) continue;
    if (rest.length === 0) childFiles.add(first);
    else childDirectories.add(first);
  }
  return found
    ? {
      files: [...childFiles].sort(),
      directories: [...childDirectories].sort(),
    }
    : null;
}

function matchesGlob(value: string, glob: string): boolean {
  const escaped = glob.replace(/[.+^$()|[\]{}\\]/gu, "\\$&");
  const pattern = escaped.replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp("^" + pattern + "$", "u").test(value);
}

function normalizeStringSet(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}
