import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import { hasCapability } from "../../kernel/capabilities";
import {
  handleKnowledgeCompile,
  handleKnowledgeDbInit,
  handleKnowledgeDbList,
  handleKnowledgeIngest,
  handleKnowledgeList,
  handleKnowledgeMerge,
  handleKnowledgePromote,
  handleKnowledgeQuery,
  handleKnowledgeRead,
  handleKnowledgeSearch,
  handleKnowledgeWrite,
} from "../../kernel/knowledge";
import type { KernelContext } from "../../kernel/context";
import type {
  KnowledgeCompileArgs,
  KnowledgeDbInitArgs,
  KnowledgeIngestArgs,
  KnowledgeListArgs,
  KnowledgeMergeArgs,
  KnowledgePromoteArgs,
  KnowledgeQueryArgs,
  KnowledgeReadArgs,
  KnowledgeSearchArgs,
  KnowledgeSourceRef,
  KnowledgeWriteArgs,
} from "../../syscalls/knowledge";

type KnowledgeShellOps = {
  dbList: (ctx: KernelContext, args: { limit?: number }) => Promise<{ dbs: Array<{ id: string; title?: string }> }>;
  dbInit: (ctx: KernelContext, args: KnowledgeDbInitArgs) => Promise<{ ok: boolean; id?: string; created?: boolean; error?: string }>;
  list: (ctx: KernelContext, args: KnowledgeListArgs) => Promise<{ entries: Array<{ path: string; kind: "file" | "dir"; title?: string }> }>;
  read: (ctx: KernelContext, args: KnowledgeReadArgs) => Promise<{ exists: boolean; path: string; markdown?: string }>;
  write: (ctx: KernelContext, args: KnowledgeWriteArgs) => Promise<{ ok: boolean; path?: string; created?: boolean; updated?: boolean; error?: string }>;
  search: (ctx: KernelContext, args: KnowledgeSearchArgs) => Promise<{ matches: Array<{ path: string; title?: string; snippet: string }> }>;
  query: (ctx: KernelContext, args: KnowledgeQueryArgs) => Promise<{ brief: string; refs: Array<{ path: string; title?: string }> }>;
  ingest: (ctx: KernelContext, args: KnowledgeIngestArgs) => Promise<{ ok: boolean; db?: string; path?: string; created?: boolean; requiresReview?: boolean; error?: string }>;
  compile: (ctx: KernelContext, args: KnowledgeCompileArgs) => Promise<{ ok: boolean; db?: string; path?: string; sourcePath?: string; removedSource?: boolean; error?: string }>;
  merge: (ctx: KernelContext, args: KnowledgeMergeArgs) => Promise<{ ok: boolean; sourcePath?: string; targetPath?: string; removedSource?: boolean; error?: string }>;
  promote: (ctx: KernelContext, args: KnowledgePromoteArgs) => Promise<{ ok: boolean; path?: string; created?: boolean; requiresReview?: boolean; error?: string }>;
};

const DEFAULT_OPS: KnowledgeShellOps = {
  dbList: handleKnowledgeDbList,
  dbInit: handleKnowledgeDbInit,
  list: handleKnowledgeList,
  read: handleKnowledgeRead,
  write: handleKnowledgeWrite,
  search: handleKnowledgeSearch,
  query: handleKnowledgeQuery,
  ingest: handleKnowledgeIngest,
  compile: handleKnowledgeCompile,
  merge: handleKnowledgeMerge,
  promote: handleKnowledgePromote,
};

export function buildKnowledgeCommands(ctx: KernelContext) {
  const wiki = defineCommand("wiki", async (args): Promise<ExecResult> => {
    try {
      return await runWikiCommand(args, ctx);
    } catch (err) {
      return commandError("wiki", err);
    }
  });

  const mem = defineCommand("mem", async (args): Promise<ExecResult> => {
    try {
      return await runMemCommand(args, ctx);
    } catch (err) {
      return commandError("mem", err);
    }
  });

  return [wiki, mem];
}

export async function runWikiCommand(
  args: string[],
  ctx: KernelContext,
  ops: KnowledgeShellOps = DEFAULT_OPS,
): Promise<ExecResult> {
  const [subcommand = "help", ...rest] = args;

  switch (subcommand) {
    case "help":
    case "--help":
    case "-h":
      return ok(wikiHelp(rest[0]));

    case "db": {
      const [dbCommand = "list", ...dbArgs] = rest;
      if (dbCommand === "list") {
        requireCapability(ctx, "knowledge.db.list");
        const limit = parseOptionalInteger(findFlagValue(dbArgs, "--limit"));
        const result = await ops.dbList(ctx, { limit });
        return ok(formatDbList(result.dbs));
      }
      if (dbCommand === "init") {
        requireCapability(ctx, "knowledge.db.init");
        const db = String(dbArgs[0] ?? "").trim();
        if (!db) {
          throw new Error("Usage: wiki db init <db> [--title TITLE] [--description TEXT]");
        }
        const title = findFlagValue(dbArgs.slice(1), "--title");
        const description = findFlagValue(dbArgs.slice(1), "--description");
        const result = await ops.dbInit(ctx, { id: db, title, description });
        if (!result.ok) {
          throw new Error(result.error ?? "db init failed");
        }
        return ok(`${result.created ? "initialized" : "already exists"} ${result.id}\n`);
      }
      throw new Error(`Unknown wiki db subcommand: ${dbCommand}`);
    }

    case "list": {
      requireCapability(ctx, "knowledge.list");
      const prefix = firstPositional(rest);
      const recursive = hasFlag(rest, "--recursive");
      const limit = parseOptionalInteger(findFlagValue(rest, "--limit"));
      const result = await ops.list(ctx, { prefix, recursive, limit });
      return ok(formatKnowledgeList(result.entries));
    }

    case "read": {
      requireCapability(ctx, "knowledge.read");
      const path = String(rest[0] ?? "").trim();
      if (!path) {
        throw new Error("Usage: wiki read <path>");
      }
      const result = await ops.read(ctx, { path });
      if (!result.exists) {
        throw new Error(`Knowledge note '${path}' does not exist`);
      }
      return ok(`${result.markdown ?? ""}${result.markdown?.endsWith("\n") ? "" : "\n"}`);
    }

    case "write": {
      requireCapability(ctx, "knowledge.write");
      const path = String(rest[0] ?? "").trim();
      if (!path) {
        throw new Error("Usage: wiki write <path> --text TEXT");
      }
      const text = requireFlagValue(rest.slice(1), "--text", "wiki write requires --text");
      const result = await ops.write(ctx, {
        path,
        markdown: text,
        create: true,
      });
      if (!result.ok) {
        throw new Error(result.error ?? "write failed");
      }
      return ok(`${result.created ? "created" : "updated"} ${result.path}\n`);
    }

    case "section":
      return runWikiSectionCommand(rest, ctx, ops);

    case "source":
      return runWikiSourceCommand(rest, ctx, ops);

    case "search": {
      requireCapability(ctx, "knowledge.search");
      const query = String(rest[0] ?? "").trim();
      if (!query) {
        throw new Error("Usage: wiki search <query> [--prefix PREFIX] [--limit N]");
      }
      const prefix = findFlagValue(rest.slice(1), "--prefix");
      const limit = parseOptionalInteger(findFlagValue(rest.slice(1), "--limit"));
      const result = await ops.search(ctx, { query, prefix, limit });
      return ok(formatKnowledgeSearch(result.matches));
    }

    case "query": {
      requireCapability(ctx, "knowledge.query");
      const query = String(rest[0] ?? "").trim();
      if (!query) {
        throw new Error("Usage: wiki query <query> [--prefix PREFIX ...] [--limit N] [--max-bytes N]");
      }
      const prefixes = findFlagValues(rest.slice(1), "--prefix");
      const limit = parseOptionalInteger(findFlagValue(rest.slice(1), "--limit"));
      const maxBytes = parseOptionalInteger(findFlagValue(rest.slice(1), "--max-bytes"));
      const result = await ops.query(ctx, { query, prefixes, limit, maxBytes });
      return ok(formatKnowledgeQuery(result.brief, result.refs));
    }

    case "ingest": {
      requireCapability(ctx, "knowledge.ingest");
      const db = String(rest[0] ?? "").trim();
      if (!db) {
        throw new Error("Usage: wiki ingest <db> --source target:/absolute/path[|Title] [--source ...]");
      }
      const result = await ops.ingest(ctx, {
        db,
        sources: parseRequiredSources(rest.slice(1)),
        title: findFlagValue(rest.slice(1), "--title"),
        summary: findFlagValue(rest.slice(1), "--summary"),
        path: findFlagValue(rest.slice(1), "--path"),
        mode: parseMode(findFlagValue(rest.slice(1), "--mode"), ["inbox", "page"]) as "inbox" | "page" | undefined,
      });
      if (!result.ok) {
        throw new Error(result.error ?? "ingest failed");
      }
      return ok(`${result.requiresReview ? "staged" : "created"} ${result.path}\n`);
    }

    case "compile": {
      requireCapability(ctx, "knowledge.compile");
      const db = String(rest[0] ?? "").trim();
      const sourcePath = String(rest[1] ?? "").trim();
      if (!db || !sourcePath) {
        throw new Error("Usage: wiki compile <db> <source-path> [target-path] [--title TITLE] [--keep-source]");
      }
      const targetPath = positionalAfterFlags(rest.slice(2))[0];
      const result = await ops.compile(ctx, {
        db,
        sourcePath,
        targetPath,
        title: findFlagValue(rest.slice(2), "--title"),
        keepSource: hasFlag(rest.slice(2), "--keep-source"),
      });
      if (!result.ok) {
        throw new Error(result.error ?? "compile failed");
      }
      return ok(`compiled ${result.sourcePath} -> ${result.path}\n`);
    }

    case "merge": {
      requireCapability(ctx, "knowledge.merge");
      const sourcePath = String(rest[0] ?? "").trim();
      const targetPath = String(rest[1] ?? "").trim();
      if (!sourcePath || !targetPath) {
        throw new Error("Usage: wiki merge <source> <target> [--mode union|prefer-target|prefer-source] [--keep-source]");
      }
      const result = await ops.merge(ctx, {
        sourcePath,
        targetPath,
        mode: parseMode(findFlagValue(rest.slice(2), "--mode"), ["union", "prefer-target", "prefer-source"]) as
          | "union"
          | "prefer-target"
          | "prefer-source"
          | undefined,
        keepSource: hasFlag(rest.slice(2), "--keep-source"),
      });
      if (!result.ok) {
        throw new Error(result.error ?? "merge failed");
      }
      return ok(`merged ${result.sourcePath} -> ${result.targetPath}\n`);
    }

    case "promote": {
      requireCapability(ctx, "knowledge.promote");
      const text = requireFlagValue(rest, "--text", "wiki promote requires --text");
      const targetPath = findFlagValue(rest, "--to");
      const mode = parseMode(findFlagValue(rest, "--mode"), ["inbox", "direct"]) as "inbox" | "direct" | undefined;
      const result = await ops.promote(ctx, {
        source: { kind: "text", text },
        targetPath,
        mode,
      });
      if (!result.ok) {
        throw new Error(result.error ?? "promote failed");
      }
      return ok(`${result.requiresReview ? "staged" : "promoted"} ${result.path}\n`);
    }

    default:
      throw new Error(`Unknown wiki subcommand: ${subcommand}`);
  }
}

export async function runMemCommand(
  args: string[],
  ctx: KernelContext,
  ops: KnowledgeShellOps = DEFAULT_OPS,
): Promise<ExecResult> {
  const [subcommand = "help", ...rest] = args;

  switch (subcommand) {
    case "help":
    case "--help":
    case "-h":
      return ok(memHelp(rest[0]));

    case "init": {
      requireCapability(ctx, "knowledge.db.init");
      const result = await ops.dbInit(ctx, {
        id: "personal",
        title: findFlagValue(rest, "--title") ?? "Personal knowledge",
        description: findFlagValue(rest, "--description"),
      });
      if (!result.ok) {
        throw new Error(result.error ?? "mem init failed");
      }
      return ok(`${result.created ? "initialized" : "already exists"} personal\n`);
    }

    case "list": {
      requireCapability(ctx, "knowledge.list");
      const prefix = resolveMemPrefix(firstPositional(rest));
      const recursive = hasFlag(rest, "--recursive");
      const limit = parseOptionalInteger(findFlagValue(rest, "--limit"));
      const result = await ops.list(ctx, { prefix, recursive, limit });
      return ok(formatKnowledgeList(result.entries));
    }

    case "read": {
      requireCapability(ctx, "knowledge.read");
      const path = resolveMemPath(String(rest[0] ?? "").trim());
      if (!path) {
        throw new Error("Usage: mem read <path>");
      }
      const result = await ops.read(ctx, { path });
      if (!result.exists) {
        throw new Error(`Knowledge note '${path}' does not exist`);
      }
      return ok(`${result.markdown ?? ""}${result.markdown?.endsWith("\n") ? "" : "\n"}`);
    }

    case "write": {
      requireCapability(ctx, "knowledge.write");
      const path = resolveMemPath(String(rest[0] ?? "").trim());
      if (!path) {
        throw new Error("Usage: mem write <path> --text TEXT");
      }
      const text = requireFlagValue(rest.slice(1), "--text", "mem write requires --text");
      const result = await ops.write(ctx, {
        path,
        markdown: text,
        create: true,
      });
      if (!result.ok) {
        throw new Error(result.error ?? "write failed");
      }
      return ok(`${result.created ? "created" : "updated"} ${result.path}\n`);
    }

    case "section":
      return runMemSectionCommand(rest, ctx, ops);

    case "source":
      return runMemSourceCommand(rest, ctx, ops);

    case "search": {
      requireCapability(ctx, "knowledge.search");
      const query = String(rest[0] ?? "").trim();
      if (!query) {
        throw new Error("Usage: mem search <query> [--prefix PREFIX] [--limit N]");
      }
      const prefix = resolveMemPrefix(findFlagValue(rest.slice(1), "--prefix"));
      const limit = parseOptionalInteger(findFlagValue(rest.slice(1), "--limit"));
      const result = await ops.search(ctx, { query, prefix, limit });
      return ok(formatKnowledgeSearch(result.matches));
    }

    case "query": {
      requireCapability(ctx, "knowledge.query");
      const query = String(rest[0] ?? "").trim();
      if (!query) {
        throw new Error("Usage: mem query <query> [--prefix PREFIX ...] [--limit N] [--max-bytes N]");
      }
      const prefixes = findFlagValues(rest.slice(1), "--prefix").map(resolveMemPrefix);
      const limit = parseOptionalInteger(findFlagValue(rest.slice(1), "--limit"));
      const maxBytes = parseOptionalInteger(findFlagValue(rest.slice(1), "--max-bytes"));
      const result = await ops.query(ctx, {
        query,
        prefixes: prefixes.length > 0 ? prefixes : ["personal/pages"],
        limit,
        maxBytes,
      });
      return ok(formatKnowledgeQuery(result.brief, result.refs));
    }

    case "ingest": {
      requireCapability(ctx, "knowledge.ingest");
      const result = await ops.ingest(ctx, {
        db: "personal",
        sources: parseRequiredSources(rest),
        title: findFlagValue(rest, "--title"),
        summary: findFlagValue(rest, "--summary"),
        path: resolveMemPath(findFlagValue(rest, "--path")),
        mode: parseMode(findFlagValue(rest, "--mode"), ["inbox", "page"]) as "inbox" | "page" | undefined,
      });
      if (!result.ok) {
        throw new Error(result.error ?? "ingest failed");
      }
      return ok(`${result.requiresReview ? "staged" : "created"} ${result.path}\n`);
    }

    case "compile": {
      requireCapability(ctx, "knowledge.compile");
      const sourcePath = resolveMemPath(String(rest[0] ?? "").trim());
      if (!sourcePath) {
        throw new Error("Usage: mem compile <source-path> [target-path] [--title TITLE] [--keep-source]");
      }
      const targetPath = resolveMemPath(positionalAfterFlags(rest.slice(1))[0]);
      const result = await ops.compile(ctx, {
        db: "personal",
        sourcePath,
        targetPath,
        title: findFlagValue(rest.slice(1), "--title"),
        keepSource: hasFlag(rest.slice(1), "--keep-source"),
      });
      if (!result.ok) {
        throw new Error(result.error ?? "compile failed");
      }
      return ok(`compiled ${result.sourcePath} -> ${result.path}\n`);
    }

    case "merge": {
      requireCapability(ctx, "knowledge.merge");
      const sourcePath = resolveMemPath(String(rest[0] ?? "").trim());
      const targetPath = resolveMemPath(String(rest[1] ?? "").trim());
      if (!sourcePath || !targetPath) {
        throw new Error("Usage: mem merge <source> <target> [--mode union|prefer-target|prefer-source] [--keep-source]");
      }
      const result = await ops.merge(ctx, {
        sourcePath,
        targetPath,
        mode: parseMode(findFlagValue(rest.slice(2), "--mode"), ["union", "prefer-target", "prefer-source"]) as
          | "union"
          | "prefer-target"
          | "prefer-source"
          | undefined,
        keepSource: hasFlag(rest.slice(2), "--keep-source"),
      });
      if (!result.ok) {
        throw new Error(result.error ?? "merge failed");
      }
      return ok(`merged ${result.sourcePath} -> ${result.targetPath}\n`);
    }

    case "promote": {
      requireCapability(ctx, "knowledge.promote");
      const text = requireFlagValue(rest, "--text", "mem promote requires --text");
      const targetPath = resolveMemPath(findFlagValue(rest, "--to"));
      const mode = parseMode(findFlagValue(rest, "--mode"), ["inbox", "direct"]) as "inbox" | "direct" | undefined;
      const result = await ops.promote(ctx, {
        source: { kind: "text", text },
        targetPath,
        mode,
      });
      if (!result.ok) {
        throw new Error(result.error ?? "promote failed");
      }
      return ok(`${result.requiresReview ? "staged" : "promoted"} ${result.path}\n`);
    }

    default:
      throw new Error(`Unknown mem subcommand: ${subcommand}`);
  }
}

async function runWikiSectionCommand(
  args: string[],
  ctx: KernelContext,
  ops: KnowledgeShellOps,
): Promise<ExecResult> {
  requireCapability(ctx, "knowledge.write");
  const [mode = "help", path, heading, ...rest] = args;
  if (mode === "help" || mode === "--help" || mode === "-h") {
    return ok(wikiHelp("section"));
  }
  if (!path || !heading) {
    throw new Error("Usage: wiki section <set|append|delete> <path> <heading> [--text TEXT]");
  }
  const normalizedMode = parseMode(mode, ["set", "append", "delete"]);
  const sectionMode: "replace" | "append" | "delete" =
    normalizedMode === "set" ? "replace" : (normalizedMode as "append" | "delete");
  const result = await ops.write(ctx, {
    path,
    patch: {
      sections: [
        {
          heading,
          mode: sectionMode,
          content: normalizedMode === "delete" ? undefined : requireFlagValue(rest, "--text", "section writes require --text"),
        },
      ],
    },
    create: normalizedMode === "set" || normalizedMode === "append",
  });
  if (!result.ok) {
    throw new Error(result.error ?? "section update failed");
  }
  return ok(`${normalizedMode} ${heading} in ${result.path}\n`);
}

async function runMemSectionCommand(
  args: string[],
  ctx: KernelContext,
  ops: KnowledgeShellOps,
): Promise<ExecResult> {
  requireCapability(ctx, "knowledge.write");
  const [mode = "help", rawPath, heading, ...rest] = args;
  if (mode === "help" || mode === "--help" || mode === "-h") {
    return ok(memHelp("section"));
  }
  const path = resolveMemPath(rawPath);
  if (!path || !heading) {
    throw new Error("Usage: mem section <set|append|delete> <path> <heading> [--text TEXT]");
  }
  const normalizedMode = parseMode(mode, ["set", "append", "delete"]);
  const sectionMode: "replace" | "append" | "delete" =
    normalizedMode === "set" ? "replace" : (normalizedMode as "append" | "delete");
  const result = await ops.write(ctx, {
    path,
    patch: {
      sections: [
        {
          heading,
          mode: sectionMode,
          content: normalizedMode === "delete" ? undefined : requireFlagValue(rest, "--text", "section writes require --text"),
        },
      ],
    },
    create: normalizedMode === "set" || normalizedMode === "append",
  });
  if (!result.ok) {
    throw new Error(result.error ?? "section update failed");
  }
  return ok(`${normalizedMode} ${heading} in ${result.path}\n`);
}

async function runWikiSourceCommand(
  args: string[],
  ctx: KernelContext,
  ops: KnowledgeShellOps,
): Promise<ExecResult> {
  requireCapability(ctx, "knowledge.write");
  const [sourceSubcommand = "help", path, ...rest] = args;
  if (sourceSubcommand === "help" || sourceSubcommand === "--help" || sourceSubcommand === "-h") {
    return ok(wikiHelp("source"));
  }
  if (sourceSubcommand !== "add" || !path) {
    throw new Error("Usage: wiki source add <path> --source target:/absolute/path[|Title] [--source ...]");
  }
  const result = await ops.write(ctx, {
    path,
    patch: {
      addSources: parseRequiredSources(rest),
    },
    create: false,
  });
  if (!result.ok) {
    throw new Error(result.error ?? "source add failed");
  }
  return ok(`added sources to ${result.path}\n`);
}

async function runMemSourceCommand(
  args: string[],
  ctx: KernelContext,
  ops: KnowledgeShellOps,
): Promise<ExecResult> {
  requireCapability(ctx, "knowledge.write");
  const [sourceSubcommand = "help", rawPath, ...rest] = args;
  if (sourceSubcommand === "help" || sourceSubcommand === "--help" || sourceSubcommand === "-h") {
    return ok(memHelp("source"));
  }
  const path = resolveMemPath(rawPath);
  if (sourceSubcommand !== "add" || !path) {
    throw new Error("Usage: mem source add <path> --source target:/absolute/path[|Title] [--source ...]");
  }
  const result = await ops.write(ctx, {
    path,
    patch: {
      addSources: parseRequiredSources(rest),
    },
    create: false,
  });
  if (!result.ok) {
    throw new Error(result.error ?? "source add failed");
  }
  return ok(`added sources to ${result.path}\n`);
}

function requireCapability(ctx: KernelContext, capability: string): void {
  const capabilities = ctx.identity?.capabilities ?? [];
  if (!hasCapability(capabilities, capability)) {
    throw new Error(`Permission denied: ${capability}`);
  }
}

function ok(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    exitCode: 0,
  };
}

function commandError(command: string, err: unknown): ExecResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    stdout: "",
    stderr: `${command}: ${message}\n`,
    exitCode: 1,
  };
}

function formatDbList(dbs: Array<{ id: string; title?: string }>): string {
  const lines = ["ID\tTITLE"];
  for (const db of dbs) {
    lines.push(`${db.id}\t${db.title ?? ""}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatKnowledgeList(entries: Array<{ path: string; kind: "file" | "dir"; title?: string }>): string {
  const lines = ["TYPE\tPATH\tTITLE"];
  for (const entry of entries) {
    lines.push(`${entry.kind}\t${entry.path}\t${entry.title ?? ""}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatKnowledgeSearch(matches: Array<{ path: string; title?: string; snippet: string }>): string {
  const lines = ["PATH\tTITLE\tSNIPPET"];
  for (const match of matches) {
    lines.push(`${match.path}\t${match.title ?? ""}\t${match.snippet.replace(/\s+/g, " ").trim()}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatKnowledgeQuery(brief: string, refs: Array<{ path: string; title?: string }>): string {
  const refLines = refs.length > 0
    ? `Refs:\n${refs.map((ref) => `- ${ref.path}${ref.title ? ` (${ref.title})` : ""}`).join("\n")}\n`
    : "";
  const normalizedBrief = brief.endsWith("\n") ? brief : `${brief}\n`;
  return `${normalizedBrief}${refLines}`;
}

function firstPositional(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current.startsWith("--")) {
      return current;
    }
    index += 1;
  }
  return undefined;
}

function positionalAfterFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current.startsWith("--")) {
      if (index + 1 < args.length && !args[index + 1].startsWith("--")) {
        index += 1;
      }
      continue;
    }
    out.push(current);
  }
  return out;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function findFlagValue(args: string[], name: string): string | undefined {
  const index = args.findIndex((entry) => entry === name);
  if (index < 0) {
    return undefined;
  }
  return args[index + 1];
}

function findFlagValues(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && typeof args[index + 1] === "string") {
      out.push(args[index + 1]);
      index += 1;
    }
  }
  return out;
}

function requireFlagValue(args: string[], name: string, message: string): string {
  const value = findFlagValue(args, name)?.trim();
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer: ${value}`);
  }
  return parsed;
}

function parseMode(value: string | undefined, allowed: string[]): string | undefined {
  if (!value) {
    return undefined;
  }
  if (!allowed.includes(value)) {
    throw new Error(`Invalid mode '${value}'. Expected one of: ${allowed.join(", ")}`);
  }
  return value;
}

function parseRequiredSources(args: string[]): KnowledgeSourceRef[] {
  const specs = findFlagValues(args, "--source");
  if (specs.length === 0) {
    throw new Error("At least one --source target:/absolute/path[|Title] is required");
  }
  return specs.map(parseSourceSpec);
}

function parseSourceSpec(spec: string): KnowledgeSourceRef {
  const separator = spec.indexOf(":");
  if (separator <= 0) {
    throw new Error(`Invalid source '${spec}'. Expected target:/absolute/path or target:/absolute/path|Title`);
  }
  const target = spec.slice(0, separator).trim();
  const remainder = spec.slice(separator + 1);
  const [pathPart, titlePart] = remainder.split("|", 2);
  const path = pathPart.trim();
  if (!target || !path.startsWith("/")) {
    throw new Error(`Invalid source '${spec}'. Path must be absolute`);
  }
  return {
    target,
    path,
    title: titlePart?.trim() || undefined,
  };
}

function resolveMemPath(path: string | undefined): string | undefined {
  const trimmed = String(path ?? "").trim().replace(/^\/+/, "");
  if (!trimmed) {
    return undefined;
  }
  return trimmed.startsWith("personal/") ? trimmed : `personal/${trimmed}`;
}

function resolveMemPrefix(prefix: string | undefined): string {
  return resolveMemPath(prefix) ?? "personal";
}

function wikiHelp(topic?: string): string {
  const normalized = topic?.trim().toLowerCase();
  switch (normalized) {
    case "write":
      return [
        "wiki write <path> --text TEXT",
        "",
        "Replace or create a knowledge note with arbitrary markdown.",
        "This is the primary note-authoring path.",
        "",
        "Examples:",
        "  wiki write product/pages/auth.md --text \"# Auth\\n\\n## Summary\\n...\"",
        "  wiki write research/pages/llm-notes.md --text \"$(cat notes.md)\"",
        "",
      ].join("\n");
    case "section":
      return [
        "wiki section <set|append|delete> <path> <heading> [--text TEXT]",
        "",
        "Generic section editing helper.",
        "Use this for convenient edits without giving up arbitrary markdown pages.",
        "",
        "Examples:",
        "  wiki section set product/pages/auth.md Summary --text \"Current auth overview\"",
        "  wiki section append product/pages/auth.md Questions --text \"- Clarify token lifetime\"",
        "  wiki section delete product/pages/auth.md Draft",
        "",
      ].join("\n");
    case "source":
      return [
        "wiki source add <path> --source target:/absolute/path[|Title] [--source ...]",
        "",
        "Attach live source refs to an existing note.",
        "Sources are references only. They are not snapshotted into the repo.",
        "",
        "Examples:",
        "  wiki source add product/pages/auth.md --source gsv:/workspaces/gsv/specs/auth.md|Auth spec",
        "  wiki source add product/pages/auth.md --source macbook:/Users/hank/Downloads/auth-notes.txt",
        "",
      ].join("\n");
    case "ingest":
      return [
        "wiki ingest <db> --source target:/absolute/path[|Title] [--source ...] [--title TITLE] [--summary TEXT] [--path PATH] [--mode inbox|page]",
        "",
        "Create a new note from one or more live source refs.",
        "Use mode 'inbox' for staged review and 'page' for direct canonical pages.",
        "",
      ].join("\n");
    case "compile":
      return [
        "wiki compile <db> <source-path> [target-path] [--title TITLE] [--keep-source]",
        "",
        "Turn a staged inbox note into a canonical page under <db>/pages/.",
        "Compiling also keeps index.md in sync.",
        "",
      ].join("\n");
    default:
      return [
        "Usage: wiki <subcommand> [args]",
        "",
        "The wiki CLI is a thin shell wrapper over knowledge.* syscalls.",
        "It operates on the unified ~/knowledge/ substrate and stays explicit by design.",
        "",
        "Core concepts:",
        "  - Each DB lives under ~/knowledge/<db>/",
        "  - index.md is the DB homepage / entrypoint",
        "  - History comes from ripgit commits, not a separate log.md file",
        "  - Notes are arbitrary markdown pages",
        "  - Sources are live refs: target:/absolute/path[|Optional Title]",
        "",
        "Commands:",
        "  wiki db list [--limit N]",
        "  wiki db init <db> [--title TITLE] [--description TEXT]",
        "  wiki list [prefix] [--recursive] [--limit N]",
        "  wiki read <path>",
        "  wiki write <path> --text TEXT",
        "  wiki section <set|append|delete> <path> <heading> [--text TEXT]",
        "  wiki source add <path> --source target:/absolute/path[|Title] [--source ...]",
        "  wiki search <query> [--prefix PREFIX] [--limit N]",
        "  wiki query <query> [--prefix PREFIX ...] [--limit N] [--max-bytes N]",
        "  wiki ingest <db> --source target:/absolute/path[|Title] [--source ...] [--title TITLE] [--summary TEXT] [--path PATH] [--mode inbox|page]",
        "  wiki compile <db> <source-path> [target-path] [--title TITLE] [--keep-source]",
        "  wiki merge <source> <target> [--mode union|prefer-target|prefer-source] [--keep-source]",
        "  wiki promote --text TEXT [--to PATH] [--mode inbox|direct]",
        "",
        "Topic help:",
        "  wiki help write",
        "  wiki help section",
        "  wiki help source",
        "  wiki help ingest",
        "  wiki help compile",
        "",
      ].join("\n");
  }
}

function memHelp(topic?: string): string {
  const normalized = topic?.trim().toLowerCase();
  switch (normalized) {
    case "section":
      return [
        "mem section <set|append|delete> <path> <heading> [--text TEXT]",
        "",
        "Like wiki section, but paths are relative to the personal DB.",
        "Example path: pages/people/alice.md",
        "",
      ].join("\n");
    case "source":
      return [
        "mem source add <path> --source target:/absolute/path[|Title] [--source ...]",
        "",
        "Attach live source refs to a personal-memory page.",
        "Paths are relative to the personal DB.",
        "",
      ].join("\n");
    default:
      return [
        "Usage: mem <subcommand> [args]",
        "",
        "The mem CLI is a thin view over knowledge.* with db=personal by default.",
        "All note paths are relative to ~/knowledge/personal/ unless you pass an explicit personal/... path.",
        "",
        "Typical paths:",
        "  pages/self.md",
        "  pages/people/alice.md",
        "  pages/projects/gsv-alpha.md",
        "  inbox/2026-...-candidate.md",
        "",
        "Commands:",
        "  mem init [--title TITLE] [--description TEXT]",
        "  mem list [prefix] [--recursive] [--limit N]",
        "  mem read <path>",
        "  mem write <path> --text TEXT",
        "  mem section <set|append|delete> <path> <heading> [--text TEXT]",
        "  mem source add <path> --source target:/absolute/path[|Title] [--source ...]",
        "  mem search <query> [--prefix PREFIX] [--limit N]",
        "  mem query <query> [--prefix PREFIX ...] [--limit N] [--max-bytes N]",
        "  mem ingest --source target:/absolute/path[|Title] [--source ...] [--title TITLE] [--summary TEXT] [--path PATH] [--mode inbox|page]",
        "  mem compile <source-path> [target-path] [--title TITLE] [--keep-source]",
        "  mem merge <source> <target> [--mode union|prefer-target|prefer-source] [--keep-source]",
        "  mem promote --text TEXT [--to PATH] [--mode inbox|direct]",
        "",
        "Examples:",
        "  mem read pages/people/alice.md",
        "  mem section append pages/people/alice.md Preferences --text \"- Prefers concise replies\"",
        "  mem query \"What should I remember about Alice?\"",
        "  mem ingest --source gsv:/workspaces/chat/alice.md --title \"Alice onboarding notes\"",
        "",
        "Topic help:",
        "  mem help section",
        "  mem help source",
        "",
      ].join("\n");
  }
}
