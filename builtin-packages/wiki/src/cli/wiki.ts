import { defineCommand } from "@gsv/package/cli";
import { WikiKnowledgeStore } from "../backend/knowledge-store";
import type {
  KnowledgeCompileArgs,
  KnowledgeIngestArgs,
  KnowledgeMergeArgs,
  KnowledgePromoteArgs,
  KnowledgeSourceRef,
  KnowledgeWriteArgs,
  WikiKernelClient,
} from "../backend/knowledge-store";

type CommandContext = {
  kernel: WikiKernelClient;
  argv: string[];
  stdout: { write(text: string): Promise<void> };
};

export default defineCommand(async (ctx) => {
  await ctx.stdout.write(await runWikiCommand(ctx));
});

export async function runWikiCommand(ctx: CommandContext): Promise<string> {
  const [subcommand = "help", ...rest] = ctx.argv;
  const store = new WikiKnowledgeStore(ctx.kernel);

  switch (subcommand) {
    case "help":
    case "--help":
    case "-h":
      return wikiHelp(rest[0]);

    case "db":
      return runDbCommand(store, rest);

    case "list": {
      const prefix = firstPositional(rest);
      const recursive = hasFlag(rest, "--recursive") || hasFlag(rest, "-r");
      const limit = parseOptionalInteger(findFlagValue(rest, "--limit"));
      const result = await store.list({ prefix, recursive, limit });
      return formatKnowledgeList(result.entries);
    }

    case "read": {
      const path = String(rest[0] ?? "").trim();
      if (!path) {
        throw new Error("Usage: wiki read <path>");
      }
      const result = await store.read({ path });
      if (!result.exists) {
        throw new Error(`Knowledge note '${path}' does not exist`);
      }
      return `${result.markdown ?? ""}${result.markdown?.endsWith("\n") ? "" : "\n"}`;
    }

    case "write": {
      const path = String(rest[0] ?? "").trim();
      if (!path) {
        throw new Error("Usage: wiki write <path> --text TEXT");
      }
      const result = await store.write({
        path,
        markdown: requireFlagValue(rest.slice(1), "--text", "wiki write requires --text"),
        create: true,
      });
      if (!result.ok) {
        throw new Error(result.error ?? "write failed");
      }
      return `${result.created ? "created" : "updated"} ${result.path}\n`;
    }

    case "section":
      return runSectionCommand(store, rest);

    case "source":
      return runSourceCommand(store, rest);

    case "search": {
      const query = String(rest[0] ?? "").trim();
      if (!query) {
        throw new Error("Usage: wiki search <query> [--prefix PREFIX] [--limit N]");
      }
      const result = await store.search({
        query,
        prefix: findFlagValue(rest.slice(1), "--prefix"),
        limit: parseOptionalInteger(findFlagValue(rest.slice(1), "--limit")),
      });
      return formatKnowledgeSearch(result.matches);
    }

    case "query": {
      const query = String(rest[0] ?? "").trim();
      if (!query) {
        throw new Error("Usage: wiki query <query> [--prefix PREFIX ...] [--limit N] [--max-bytes N]");
      }
      const result = await store.query({
        query,
        prefixes: findFlagValues(rest.slice(1), "--prefix"),
        limit: parseOptionalInteger(findFlagValue(rest.slice(1), "--limit")),
        maxBytes: parseOptionalInteger(findFlagValue(rest.slice(1), "--max-bytes")),
      });
      return formatKnowledgeQuery(result.brief, result.refs);
    }

    case "ingest": {
      const db = String(rest[0] ?? "").trim();
      if (!db) {
        throw new Error("Usage: wiki ingest <db> --source target:/absolute/path[::Title] [--source ...]");
      }
      const args: KnowledgeIngestArgs = {
        db,
        sources: parseRequiredSources(rest.slice(1)),
        title: findFlagValue(rest.slice(1), "--title"),
        summary: findFlagValue(rest.slice(1), "--summary"),
        path: findFlagValue(rest.slice(1), "--path"),
        mode: parseMode(findFlagValue(rest.slice(1), "--mode"), ["inbox", "page"]) as "inbox" | "page" | undefined,
      };
      const result = await store.ingest(args);
      if (!result.ok) {
        throw new Error(result.error ?? "ingest failed");
      }
      return `${result.requiresReview ? "staged" : "created"} ${result.path}\n`;
    }

    case "compile": {
      const db = String(rest[0] ?? "").trim();
      const sourcePath = String(rest[1] ?? "").trim();
      if (!db || !sourcePath) {
        throw new Error("Usage: wiki compile <db> <source-path> [target-path] [--title TITLE] [--keep-source]");
      }
      const args: KnowledgeCompileArgs = {
        db,
        sourcePath,
        targetPath: positionalAfterFlags(rest.slice(2))[0],
        title: findFlagValue(rest.slice(2), "--title"),
        keepSource: hasFlag(rest.slice(2), "--keep-source"),
      };
      const result = await store.compile(args);
      if (!result.ok) {
        throw new Error(result.error ?? "compile failed");
      }
      return `compiled ${result.sourcePath} -> ${result.path}\n`;
    }

    case "merge": {
      const sourcePath = String(rest[0] ?? "").trim();
      const targetPath = String(rest[1] ?? "").trim();
      if (!sourcePath || !targetPath) {
        throw new Error("Usage: wiki merge <source> <target> [--mode union|prefer-target|prefer-source] [--keep-source]");
      }
      const args: KnowledgeMergeArgs = {
        sourcePath,
        targetPath,
        mode: parseMode(findFlagValue(rest.slice(2), "--mode"), ["union", "prefer-target", "prefer-source"]) as
          | "union"
          | "prefer-target"
          | "prefer-source"
          | undefined,
        keepSource: hasFlag(rest.slice(2), "--keep-source"),
      };
      const result = await store.merge(args);
      if (!result.ok) {
        throw new Error(result.error ?? "merge failed");
      }
      return `merged ${result.sourcePath} -> ${result.targetPath}\n`;
    }

    case "promote": {
      const args: KnowledgePromoteArgs = {
        source: { kind: "text", text: requireFlagValue(rest, "--text", "wiki promote requires --text") },
        targetPath: findFlagValue(rest, "--to"),
        mode: parseMode(findFlagValue(rest, "--mode"), ["inbox", "direct"]) as "inbox" | "direct" | undefined,
      };
      const result = await store.promote(args);
      if (!result.ok) {
        throw new Error(resultError(result, "promote failed"));
      }
      const promoted = result as { path?: string; requiresReview?: boolean };
      return `${promoted.requiresReview ? "staged" : "promoted"} ${promoted.path}\n`;
    }

    default:
      throw new Error(`Unknown wiki subcommand: ${subcommand}`);
  }
}

async function runDbCommand(store: WikiKnowledgeStore, args: string[]): Promise<string> {
  const [dbCommand = "list", ...dbArgs] = args;
  if (dbCommand === "list") {
    const result = await store.listDbs({ limit: parseOptionalInteger(findFlagValue(dbArgs, "--limit")) });
    return formatDbList(result.dbs);
  }
  if (dbCommand === "init") {
    const db = String(dbArgs[0] ?? "").trim();
    if (!db) {
      throw new Error("Usage: wiki db init <db> [--title TITLE] [--description TEXT]");
    }
    const result = await store.initDb({
      id: db,
      title: findFlagValue(dbArgs.slice(1), "--title"),
      description: findFlagValue(dbArgs.slice(1), "--description"),
    });
    return `${result.created ? "initialized" : "already exists"} ${result.id}\n`;
  }
  if (dbCommand === "delete" || dbCommand === "rm") {
    const db = String(dbArgs[0] ?? "").trim();
    if (!db) {
      throw new Error("Usage: wiki db delete <db>");
    }
    const result = await store.deleteDb({ id: db });
    return `${result.removed ? "deleted" : "not found"} ${result.id}\n`;
  }
  throw new Error(`Unknown wiki db subcommand: ${dbCommand}`);
}

async function runSectionCommand(store: WikiKnowledgeStore, args: string[]): Promise<string> {
  const [mode = "help", path, heading, ...rest] = args;
  if (mode === "help" || mode === "--help" || mode === "-h") {
    return wikiHelp("section");
  }
  if (!path || !heading) {
    throw new Error("Usage: wiki section <set|append|delete> <path> <heading> [--text TEXT]");
  }
  const normalizedMode = parseMode(mode, ["set", "append", "delete"]);
  const sectionMode: "replace" | "append" | "delete" =
    normalizedMode === "set" ? "replace" : (normalizedMode as "append" | "delete");
  const patch: NonNullable<KnowledgeWriteArgs["patch"]> = {
    sections: [
      {
        heading,
        mode: sectionMode,
        content: normalizedMode === "delete" ? undefined : requireFlagValue(rest, "--text", "section writes require --text"),
      },
    ],
  };
  const result = await store.write({
    path,
    patch,
    create: normalizedMode === "set" || normalizedMode === "append",
  });
  if (!result.ok) {
    throw new Error(result.error ?? "section update failed");
  }
  return `${normalizedMode} ${heading} in ${result.path}\n`;
}

async function runSourceCommand(store: WikiKnowledgeStore, args: string[]): Promise<string> {
  const [sourceSubcommand = "help", path, ...rest] = args;
  if (sourceSubcommand === "help" || sourceSubcommand === "--help" || sourceSubcommand === "-h") {
    return wikiHelp("source");
  }
  if (sourceSubcommand !== "add" || !path) {
    throw new Error("Usage: wiki source add <path> --source target:/absolute/path[|Title] [--source ...]");
  }
  const result = await store.write({
    path,
    patch: { addSources: parseRequiredSources(rest) },
    create: false,
  });
  if (!result.ok) {
    throw new Error(result.error ?? "source add failed");
  }
  return `added sources to ${result.path}\n`;
}

function resultError(result: unknown, fallback: string): string {
  if (result && typeof result === "object" && "error" in result && typeof result.error === "string") {
    return result.error;
  }
  return fallback;
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
  return `${brief.endsWith("\n") ? brief : `${brief}\n`}${refLines}`;
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
  return index >= 0 ? args[index + 1] : undefined;
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
    throw new Error("At least one --source target:/absolute/path[::Title] is required");
  }
  return specs.map(parseSourceSpec);
}

function parseSourceSpec(spec: string): KnowledgeSourceRef {
  const separator = spec.indexOf(":");
  if (separator <= 0) {
    throw new Error(`Invalid source '${spec}'. Expected target:/absolute/path or target:/absolute/path::Title`);
  }
  const target = spec.slice(0, separator).trim();
  const remainder = spec.slice(separator + 1);
  const titleSeparator = remainder.includes("::") ? "::" : remainder.includes("|") ? "|" : null;
  const [pathPart, titlePart] = titleSeparator ? remainder.split(titleSeparator, 2) : [remainder, undefined];
  const path = pathPart.trim();
  if (!target || !path.startsWith("/")) {
    throw new Error(`Invalid source '${spec}'. Path must be absolute`);
  }
  return { target, path, title: titlePart?.trim() || undefined };
}

function wikiHelp(topic?: string): string {
  const normalized = topic?.trim().toLowerCase();
  if (normalized === "write") {
    return "wiki write <path> --text TEXT\n\nReplace or create a knowledge note with arbitrary markdown.\n";
  }
  if (normalized === "section") {
    return "wiki section <set|append|delete> <path> <heading> [--text TEXT]\n\nEdit one markdown section in a knowledge note.\n";
  }
  if (normalized === "source") {
    return "wiki source add <path> --source target:/absolute/path[::Title] [--source ...]\n\nAttach live source refs to an existing note.\n";
  }
  if (normalized === "ingest") {
    return "wiki ingest <db> --source target:/absolute/path[::Title] [--source ...] [--title TITLE] [--summary TEXT] [--path PATH] [--mode inbox|page]\n\nCreate a new note from one or more live source refs.\n";
  }
  if (normalized === "compile") {
    return "wiki compile <db> <source-path> [target-path] [--title TITLE] [--keep-source]\n\nMove a reviewed inbox note into a canonical db page.\n";
  }
  if (normalized === "merge") {
    return "wiki merge <source> <target> [--mode union|prefer-target|prefer-source] [--keep-source]\n\nMerge duplicate notes into a canonical target.\n";
  }
  return [
    "wiki - durable markdown knowledge over ~/knowledge",
    "",
    "Usage:",
    "  wiki db list [--limit N]",
    "  wiki db init <db> [--title TITLE] [--description TEXT]",
    "  wiki db delete <db>",
    "  wiki list [prefix] [--recursive] [--limit N]",
    "  wiki read <path>",
    "  wiki write <path> --text TEXT",
    "  wiki section <set|append|delete> <path> <heading> [--text TEXT]",
    "  wiki source add <path> --source target:/absolute/path[::Title] [--source ...]",
    "  wiki search <query> [--prefix PREFIX] [--limit N]",
    "  wiki query <query> [--prefix PREFIX ...] [--limit N] [--max-bytes N]",
    "  wiki ingest <db> --source target:/absolute/path[::Title] [--source ...]",
    "  wiki compile <db> <source-path> [target-path] [--title TITLE] [--keep-source]",
    "  wiki merge <source> <target> [--mode union|prefer-target|prefer-source] [--keep-source]",
    "  wiki promote --text TEXT [--to PATH] [--mode inbox|direct]",
    "",
    "Examples:",
    "  wiki db init product --title \"Product Knowledge\"",
    "  wiki write product/pages/auth.md --text \"# Auth\"",
    "  wiki search auth --prefix product",
    "  wiki query \"adapter routing\" --prefix product/pages",
    "",
  ].join("\n");
}
