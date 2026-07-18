import { defineCommand } from "just-bash";
import type { CommandContext, ExecResult } from "just-bash";
import { GsvFs } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";
import {
  collectFilesystemSkillDocuments,
  listSkillFiles,
  renderSkillMarkdown,
  resolveSkillDocument,
  type SkillDocument,
  validateSkillMarkdown,
} from "../../../kernel/skills";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { nativeCommandSynopsis } from "./discovery";

export function buildSkillsCommand(fs: GsvFs, ctx: KernelContext, identity: ProcessIdentity) {
  return defineCommand("skills", async (args, commandCtx): Promise<ExecResult> => {
    try {
      return await runSkillsCommand(args, commandCtx, fs, ctx, identity);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: "",
        stderr: `skills: ${message}\n`,
        exitCode: 1,
      };
    }
  });
}

async function runSkillsCommand(
  args: string[],
  commandCtx: CommandContext,
  fs: GsvFs,
  ctx: KernelContext,
  identity: ProcessIdentity,
): Promise<ExecResult> {
  const [subcommand = "list", ...rest] = args;

  switch (subcommand) {
    case "help":
    case "--help":
    case "-h":
      return { stdout: skillsUsage(), stderr: "", exitCode: 0 };
    case "list":
    case "ls": {
      const docs = await collectFilesystemSkillDocuments(fs, ctx, identity);
      return { stdout: formatSkillsList(docs, rest[0]), stderr: "", exitCode: 0 };
    }
    case "tree":
    case "topics": {
      const docs = await collectFilesystemSkillDocuments(fs, ctx, identity);
      return { stdout: formatSkillsTree(docs, rest[0]), stderr: "", exitCode: 0 };
    }
    case "search": {
      const query = rest.join(" ").trim();
      if (!query) {
        throw new Error("Usage: skills search <query>");
      }
      const docs = await collectFilesystemSkillDocuments(fs, ctx, identity);
      return { stdout: formatSkillRows(searchSkills(docs, query)), stderr: "", exitCode: 0 };
    }
    case "show": {
      const docs = await collectFilesystemSkillDocuments(fs, ctx, identity);
      const resolved = resolveSkillDocument(docs, rest[0]);
      if (!resolved.ok) {
        throw new Error(resolved.error);
      }
      return { stdout: formatSkillDocument(resolved.doc, docs), stderr: "", exitCode: 0 };
    }
    case "files": {
      const docs = await collectFilesystemSkillDocuments(fs, ctx, identity);
      const resolved = resolveSkillDocument(docs, rest[0]);
      if (!resolved.ok) {
        throw new Error(resolved.error);
      }
      const files = await listSkillFiles(fs, resolved.doc);
      return { stdout: formatSkillFiles(resolved.doc, files), stderr: "", exitCode: 0 };
    }
    case "read": {
      const docs = await collectFilesystemSkillDocuments(fs, ctx, identity);
      const resolved = resolveSkillDocument(docs, rest[0]);
      if (!resolved.ok) {
        throw new Error(resolved.error);
      }
      const filePath = String(rest[1] ?? "").trim();
      if (!filePath) {
        throw new Error("Usage: skills read <skill> <file>");
      }
      if (filePath.startsWith("/") || filePath.split("/").includes("..")) {
        throw new Error("supporting file path must be relative and must not contain '..'");
      }
      const root = skillDirectoryPath(resolved.doc);
      if (!root) {
        throw new Error(`skill '${resolved.doc.id}' does not have supporting files`);
      }
      const content = await fs.readFile(`${root}/${filePath}`);
      return { stdout: content.endsWith("\n") ? content : `${content}\n`, stderr: "", exitCode: 0 };
    }
    case "create": {
      if (rest.includes("--help") || rest.includes("-h")) {
        return { stdout: skillsCreateUsage(), stderr: "", exitCode: 0 };
      }
      const parsed = parseCreateArgs(rest);
      const body = await readSkillBody(parsed.from, commandCtx, fs, identity);
      const content = renderSkillMarkdown({
        name: parsed.name,
        description: parsed.description,
        body,
      });
      const validation = validateSkillMarkdown(content, parsed.name);
      if (!validation.ok) {
        throw new Error(formatValidationErrors(validation.errors));
      }

      const skillDirectory = `${identity.home}/skills.d/${parsed.name}`;
      const skillPath = `${skillDirectory}/SKILL.md`;
      const exists = await fs.exists(skillPath);
      if (exists && !parsed.replace) {
        throw new Error(`skill '${parsed.name}' already exists; inspect it with 'skills show ${parsed.name}' and pass --replace only for an intentional update`);
      }
      if (!exists && parsed.replace) {
        throw new Error(`skill '${parsed.name}' does not exist, so --replace cannot be used`);
      }

      await fs.mkdir(skillDirectory, { recursive: true });
      await fs.writeFile(skillPath, content);
      return {
        stdout: [
          `${parsed.replace ? "Replaced" : "Created"} ${skillPath}`,
          `Validated skill '${parsed.name}'.`,
          `NEXT: skills show ${parsed.name}`,
          "",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      };
    }
    case "validate": {
      const requested = String(rest[0] ?? "").trim();
      if (!requested || rest.length !== 1) {
        throw new Error("Usage: skills validate <skill-or-path>");
      }
      const candidate = await readSkillValidationCandidate(requested, commandCtx, fs, ctx, identity);
      const validation = validateSkillMarkdown(candidate.content, candidate.expectedName);
      if (!validation.ok) {
        throw new Error(formatValidationErrors(validation.errors));
      }
      return {
        stdout: [
          `Valid skill: ${candidate.path}`,
          `name: ${validation.name}`,
          `description: ${validation.description}`,
          "",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      };
    }
    default:
      throw new Error(`Unknown skills subcommand: ${subcommand}`);
  }
}

type CreateSkillArgs = {
  name: string;
  description: string;
  from?: string;
  replace: boolean;
};

function parseCreateArgs(args: string[]): CreateSkillArgs {
  let rawName = "";
  let description = "";
  let from: string | undefined;
  let replace = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--description" || arg === "-d") {
      index += 1;
      description = requireOptionValue(args[index], arg);
      continue;
    }
    if (arg === "--from") {
      index += 1;
      from = requireOptionValue(args[index], arg);
      continue;
    }
    if (arg === "--replace") {
      replace = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`unsupported option: ${arg}`);
    }
    if (rawName) {
      throw new Error("skills create accepts exactly one skill name");
    }
    rawName = arg;
  }

  if (!rawName) {
    throw new Error(skillsCreateUsage().trimEnd());
  }
  if (rawName.includes("/") || rawName.includes("\\") || rawName.includes("..")) {
    throw new Error("skill name must not contain path separators or '..'");
  }
  const name = normalizeCreatedSkillName(rawName);
  if (!name) {
    throw new Error("skill name must contain at least one ASCII letter or digit");
  }

  if (!description.trim()) {
    throw new Error("--description is required and must explain what the skill does and when to use it");
  }

  return { name, description, ...(from ? { from } : {}), replace };
}

function requireOptionValue(value: string | undefined, option: string): string {
  if (!value) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function normalizeCreatedSkillName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function readSkillBody(
  from: string | undefined,
  commandCtx: CommandContext,
  fs: GsvFs,
  identity: ProcessIdentity,
): Promise<string> {
  const stdin = commandCtx.stdin.trim();
  if (from && stdin) {
    throw new Error("provide workflow instructions with either --from or stdin, not both");
  }
  const body = from
    ? await fs.readFile(fs.resolvePath(commandCtx.cwd || identity.cwd, from))
    : stdin;
  if (!body.trim()) {
    throw new Error("workflow instructions are required on stdin or with --from <file>");
  }
  if (/^---\s*(?:\r?\n|$)/.test(body.trimStart())) {
    throw new Error("--from and stdin must contain only the Markdown instruction body, not SKILL.md frontmatter");
  }
  return body;
}

async function readSkillValidationCandidate(
  requested: string,
  commandCtx: CommandContext,
  fs: GsvFs,
  ctx: KernelContext,
  identity: ProcessIdentity,
): Promise<{ path: string; expectedName: string | undefined; content: string }> {
  const docs = await collectFilesystemSkillDocuments(fs, ctx, identity);
  const resolved = resolveSkillDocument(docs, requested);
  if (resolved.ok) {
    return {
      path: resolved.doc.path,
      expectedName: skillPathName(resolved.doc.path),
      content: resolved.doc.content,
    };
  }

  if (!requested.includes("/") && !requested.endsWith(".md")) {
    throw new Error(resolved.error);
  }
  let path = fs.resolvePath(commandCtx.cwd || identity.cwd, requested);
  const stat = await fs.stat(path);
  if (stat.isDirectory) {
    path = `${path.replace(/\/$/, "")}/SKILL.md`;
  } else if (!stat.isFile) {
    throw new Error(`skill path is not a regular file: ${path}`);
  }
  return {
    path,
    expectedName: skillPathName(path),
    content: await fs.readFile(path),
  };
}

function skillPathName(path: string): string | undefined {
  const parts = path.split("/").filter(Boolean);
  if (parts.at(-1) === "SKILL.md") {
    return parts.at(-2) ?? "";
  }
  return undefined;
}

function formatValidationErrors(errors: string[]): string {
  return ["invalid SKILL.md:", ...errors.map((error) => `- ${error}`)].join("\n");
}

function formatSkillsList(docs: SkillDocument[], parentId?: string): string {
  return formatSkillRows(filterSkillListRows(docs, parentId));
}

function formatSkillRows(rows: SkillDocument[]): string {
  if (rows.length === 0) {
    return "No skills available.\n";
  }
  const lines = ["NAME\tSOURCE\tWRITABLE\tDESCRIPTION"];
  for (const doc of rows) {
    lines.push([
      doc.id,
      doc.source.label,
      doc.source.writable ? "yes" : "no",
      doc.description,
    ].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

function filterSkillListRows(docs: SkillDocument[], parentId?: string): SkillDocument[] {
  const parent = parentId?.trim();
  if (!parent) {
    return docs.filter((doc) => doc.depth === 0);
  }
  const resolved = resolveSkillDocument(docs, parent);
  if (!resolved.ok) {
    return [];
  }
  const parentKey = normalizeLookup(resolved.doc.id);
  return docs.filter((doc) => normalizeLookup(doc.parentId ?? "") === parentKey);
}

function searchSkills(docs: SkillDocument[], query: string): SkillDocument[] {
  const needle = query.toLowerCase();
  return docs.filter((doc) =>
    doc.id.toLowerCase().includes(needle)
    || doc.name.toLowerCase().includes(needle)
    || doc.description.toLowerCase().includes(needle)
    || (doc.parentId ?? "").toLowerCase().includes(needle)
    || doc.aliases.some((alias) => alias.toLowerCase().includes(needle))
    || doc.content.toLowerCase().includes(needle)
  );
}

function formatSkillDocument(doc: SkillDocument, docs: SkillDocument[]): string {
  const metadata = [
    `path: ${doc.path}`,
    `writable: ${doc.source.writable ? "yes" : "no"}`,
    ...(doc.parentId ? [`parent: ${doc.parentId}`] : []),
    ...(doc.aliases.length > 0 ? [`aliases: ${doc.aliases.join(", ")}`] : []),
    "",
  ];
  return [
    ...metadata,
    doc.content,
    ...childSkillSummary(doc, docs),
    "",
  ].join("\n");
}

function childSkillSummary(doc: SkillDocument, docs: SkillDocument[]): string[] {
  const children = docs
    .filter((candidate) => normalizeLookup(candidate.parentId ?? "") === normalizeLookup(doc.id))
    .sort(compareSkillTreeEntries);
  if (children.length === 0) {
    return [];
  }
  return [
    "",
    "Nested skills:",
    ...children.map((child) => `- ${child.id}: ${child.description || "No description."}`),
  ];
}

function formatSkillsTree(docs: SkillDocument[], parentId?: string): string {
  if (docs.length === 0) {
    return "No skills available.\n";
  }

  const children = new Map<string, SkillDocument[]>();
  const roots: SkillDocument[] = [];
  const parent = parentId?.trim();
  let rootDoc: SkillDocument | null = null;

  if (parent) {
    const resolved = resolveSkillDocument(docs, parent);
    if (!resolved.ok) {
      return `No skills available under ${parent}.\n`;
    }
    rootDoc = resolved.doc;
  }

  for (const doc of docs) {
    if (doc.parentId) {
      const parentKey = normalizeLookup(doc.parentId);
      const bucket = children.get(parentKey) ?? [];
      bucket.push(doc);
      children.set(parentKey, bucket);
    } else if (!rootDoc) {
      roots.push(doc);
    }
  }

  for (const bucket of children.values()) {
    bucket.sort(compareSkillTreeEntries);
  }
  roots.sort(compareSkillTreeEntries);

  const lines = ["GSV skill map"];
  const visited = new Set<string>();
  if (rootDoc) {
    appendSkillTree(lines, rootDoc, children, visited, 0);
  } else {
    for (const root of roots) {
      appendSkillTree(lines, root, children, visited, 0);
    }
  }
  return `${lines.join("\n")}\n`;
}

function appendSkillTree(
  lines: string[],
  doc: SkillDocument,
  children: Map<string, SkillDocument[]>,
  visited: Set<string>,
  depth: number,
): void {
  const key = normalizeLookup(doc.id);
  if (visited.has(key)) {
    return;
  }
  visited.add(key);

  const indent = "  ".repeat(depth);
  lines.push(`${indent}- ${doc.id}: ${doc.description || "No description."}`);

  for (const child of children.get(key) ?? []) {
    appendSkillTree(lines, child, children, visited, depth + 1);
  }
}

function compareSkillTreeEntries(left: SkillDocument, right: SkillDocument): number {
  return left.id.localeCompare(right.id);
}

function normalizeLookup(value: string): string {
  return value.trim().toLowerCase();
}

function formatSkillFiles(doc: SkillDocument, files: string[]): string {
  if (files.length === 0) {
    return `No supporting files for ${doc.id}.\n`;
  }
  return `${files.map((file) => `${doc.id}\t${file}`).join("\n")}\n`;
}

function skillDirectoryPath(doc: SkillDocument): string | null {
  if (doc.path.endsWith("/SKILL.md")) {
    return doc.path.slice(0, -"/SKILL.md".length);
  }
  return null;
}

function skillsUsage(): string {
  return [
    "Usage: skills <subcommand> [args]",
    "",
    ...(nativeCommandSynopsis("skills") ?? ["skills --help"]).map((line) => `  ${line}`),
    "",
    "Skill names come from layered skills.d directories. `skills list`",
    "shows top-level skills; `skills list <skill>` and `skills tree <skill>`",
    "disclose nested skills under a parent.",
    "",
    "`skills create` reads a Markdown instruction body from --from or stdin and",
    "writes ~/skills.d/<name>/SKILL.md. It never overwrites without --replace.",
    "",
  ].join("\n");
}

function skillsCreateUsage(): string {
  const synopsis = nativeCommandSynopsis("skills")
    ?.find((line) => line.startsWith("skills create "))
    ?? "skills create <name>";
  return [
    `Usage: ${synopsis}`,
    "",
    "Persist a complete reusable workflow under ~/skills.d. Supply the Markdown",
    "instruction body with --from or stdin. Existing skills require --replace.",
    "",
  ].join("\n");
}
