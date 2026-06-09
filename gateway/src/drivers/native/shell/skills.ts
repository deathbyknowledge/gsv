import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import { GsvFs } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";
import {
  collectFilesystemSkillDocuments,
  listSkillFiles,
  resolveSkillDocument,
  type SkillDocument,
} from "../../../kernel/skills";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";

export function buildSkillsCommand(fs: GsvFs, ctx: KernelContext, identity: ProcessIdentity) {
  return defineCommand("skills", async (args): Promise<ExecResult> => {
    try {
      return await runSkillsCommand(args, fs, ctx, identity);
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
    default:
      throw new Error(`Unknown skills subcommand: ${subcommand}`);
  }
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
    "  skills list [skill]",
    "  skills tree [skill]",
    "  skills search <query>",
    "  skills show <skill>",
    "  skills files <skill>",
    "  skills read <skill> <file>",
    "",
    "Skill names come from layered skills.d directories. `skills list`",
    "shows top-level skills; `skills list <skill>` and `skills tree <skill>`",
    "disclose nested skills under a parent.",
    "",
  ].join("\n");
}
