import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import {
  homeKnowledgeRepoRef,
  packageSourcePathName,
  RipgitClient,
  workspaceRepoRef,
  type RipgitRepoRef,
} from "../fs";
import type { KernelContext } from "./context";
import {
  resolvePackageProfileReference,
  visiblePackageScopesForActor,
  type InstalledPackageRecord,
} from "./packages";
import { isPackageAiContextProfile, isSystemAiContextProfile, type AiContextProfile } from "../syscalls/ai";

const TEXT_DECODER = new TextDecoder();
const MAX_SKILL_WALK_DEPTH = 4;
const MAX_DESCRIPTION_LENGTH = 220;

export type SkillSourceKind = "profile" | "home" | "workspace" | "package";

export type SkillSource = {
  kind: SkillSourceKind;
  label: string;
  writable: boolean;
};

export type SkillDocument = {
  id: string;
  name: string;
  description: string;
  content: string;
  path: string;
  source: SkillSource;
};

export type SkillIndexEntry = Omit<SkillDocument, "content" | "path">;

type SkillFile = {
  fallbackName: string;
  content: string;
  path: string;
  source: SkillSource;
};

type SkillRoot = {
  rootPath: string;
  source: SkillSource;
};

type FsReader = {
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean }>;
  readFile(path: string): Promise<string>;
};

export async function collectPromptSkillIndex(
  ctx: KernelContext,
  profile: AiContextProfile | undefined,
): Promise<SkillIndexEntry[]> {
  const docs = await collectKernelSkillDocuments(ctx, profile);
  return docs.map(({ content: _content, path: _path, ...entry }) => entry);
}

export async function collectKernelSkillDocuments(
  ctx: KernelContext,
  profile: AiContextProfile | undefined,
): Promise<SkillDocument[]> {
  const files: SkillFile[] = [];
  files.push(...collectProfileConfigSkillFiles(ctx, profile));

  const ripgit = ctx.env.RIPGIT ? new RipgitClient(ctx.env.RIPGIT) : null;
  const identity = ctx.identity?.process;
  if (ripgit && identity) {
    files.push(...await collectRipgitRuntimeSkillFiles(ripgit, ctx, identity, profile));
  }

  return buildSkillDocuments(files);
}

export async function collectFilesystemSkillDocuments(
  fs: FsReader,
  ctx: KernelContext,
  identity: ProcessIdentity,
): Promise<SkillDocument[]> {
  const roots = filesystemSkillRoots(ctx, identity);
  const files: SkillFile[] = [];
  for (const root of roots) {
    files.push(...await collectFsSkillFiles(fs, root.rootPath, root.source));
  }
  return buildSkillDocuments(files);
}

export function resolveSkillDocument(
  docs: SkillDocument[],
  rawName: string | undefined,
): { ok: true; doc: SkillDocument } | { ok: false; error: string } {
  const query = normalizeLookup(rawName ?? "");
  if (!query) {
    return { ok: false, error: "skill name is required" };
  }

  const exact = docs.filter((doc) => normalizeLookup(doc.id) === query);
  if (exact.length === 1) {
    return { ok: true, doc: exact[0] };
  }

  const byName = docs.filter((doc) => normalizeLookup(doc.name) === query);
  if (byName.length === 1) {
    return { ok: true, doc: byName[0] };
  }
  if (byName.length > 1) {
    return {
      ok: false,
      error: `ambiguous skill '${rawName}'. Use one of: ${byName.map((doc) => doc.id).join(", ")}`,
    };
  }

  return {
    ok: false,
    error: `skill '${rawName}' not found`,
  };
}

export async function listSkillFiles(
  fs: FsReader,
  doc: SkillDocument,
): Promise<string[]> {
  if (doc.path.endsWith(".md") && !doc.path.endsWith("/SKILL.md")) {
    return [];
  }
  const root = doc.path.endsWith("/SKILL.md")
    ? doc.path.slice(0, -"/SKILL.md".length)
    : doc.path.replace(/\/+$/, "");
  const files: string[] = [];
  await walkFsSupportingFiles(fs, root, "", files, 0);
  return files.sort((left, right) => left.localeCompare(right));
}

export function parseSkillMarkdown(content: string, fallbackName: string): {
  name: string;
  description: string;
} {
  const { frontmatter, body } = parseFrontmatter(content);
  const name = normalizeSkillName(frontmatter.get("name") ?? fallbackName);
  const description = truncateDescription(
    frontmatter.get("description") ?? firstBodyDescription(body),
  );
  return {
    name,
    description,
  };
}

export function renderSkillIndex(entries: SkillIndexEntry[]): string {
  if (entries.length === 0) {
    return [
      "Skill command surface:",
      "- Use `skills list` to discover reusable process skills.",
      "- Use `skills search <query>` and `skills show <skill>` before relying on a workflow you do not already know.",
      "- Use `skills files <skill>` and `skills read <skill> <file>` for supporting references and templates.",
    ].join("\n");
  }

  const lines = [
    "Skill command surface:",
    "- Use `skills list` to discover reusable process skills.",
    "- Use `skills search <query>` and `skills show <skill>` before relying on a workflow you do not already know.",
    "- Use `skills files <skill>` and `skills read <skill> <file>` for supporting references and templates.",
    "- After a difficult reusable workflow or a correction to an existing workflow, read the relevant skill and update its source file if it is writable.",
    "",
    "Available skills:",
  ];
  for (const entry of entries) {
    lines.push(`- ${entry.id}: ${entry.description || "No description."}`);
  }
  return lines.join("\n");
}

function collectProfileConfigSkillFiles(
  ctx: KernelContext,
  profile: AiContextProfile | undefined,
): SkillFile[] {
  const resolvedProfile = profile ?? "task";
  if (!isSystemAiContextProfile(resolvedProfile)) {
    return [];
  }

  const prefix = `config/ai/profile/${resolvedProfile}/skills.d`;
  const files = ctx.config.list(prefix)
    .filter((entry) => isSkillMarkdownPath(entry.key.slice(`${prefix}/`.length)))
    .map((entry): SkillFile => {
      const name = entry.key.slice(`${prefix}/`.length);
      return {
        fallbackName: fallbackSkillName(name),
        content: entry.value,
        path: `/sys/${entry.key}`,
        source: {
          kind: "profile",
          label: `profile:${resolvedProfile}`,
          writable: ctx.identity?.process.uid === 0,
        },
      };
    });
  return files;
}

async function collectRipgitRuntimeSkillFiles(
  ripgit: RipgitClient,
  ctx: KernelContext,
  identity: ProcessIdentity,
  profile: AiContextProfile | undefined,
): Promise<SkillFile[]> {
  const files: SkillFile[] = [];

  if (isPackageAiContextProfile(profile)) {
    const resolved = resolvePackageProfileReference(
      profile,
      ctx.packages,
      visiblePackageScopesForActor(identity),
    );
    if (resolved) {
      const root = packageProfileSkillRoot(resolved.record, resolved.packageProfile.name);
      if (root) {
        files.push(...await collectRipgitSkillFiles(ripgit, root.repo, root.path, {
          kind: "profile",
          label: `profile:${profile}`,
          writable: packageSourceWritable(resolved.record, identity),
        }, root.virtualPath));
      }
    }
  }

  files.push(...await collectRipgitSkillFiles(
    ripgit,
    homeKnowledgeRepoRef(identity.username),
    "skills.d",
    {
      kind: "home",
      label: "home",
      writable: true,
    },
    `${identity.home}/skills.d`,
  ));

  if (identity.workspaceId) {
    files.push(...await collectRipgitSkillFiles(
      ripgit,
      workspaceRepoRef(identity.workspaceId, identity.username),
      ".gsv/skills.d",
      {
        kind: "workspace",
        label: `workspace:${identity.workspaceId}`,
        writable: true,
      },
      `/workspaces/${identity.workspaceId}/.gsv/skills.d`,
    ));
  }

  for (const record of ctx.packages.list({
    enabled: true,
    scopes: visiblePackageScopesForActor(identity),
  })) {
    const root = packageTopLevelSkillRoot(record);
    if (!root) {
      continue;
    }
    files.push(...await collectRipgitSkillFiles(ripgit, root.repo, root.path, {
      kind: "package",
      label: `pkg:${record.manifest.name}`,
      writable: packageSourceWritable(record, identity),
    }, root.virtualPath));
  }

  return files;
}

function filesystemSkillRoots(
  ctx: KernelContext,
  identity: ProcessIdentity,
): SkillRoot[] {
  const roots: SkillRoot[] = [];
  const profile = currentProcessProfile(ctx) ?? "task";

  if (isSystemAiContextProfile(profile)) {
    roots.push({
      rootPath: `/sys/config/ai/profile/${profile}/skills.d`,
      source: {
        kind: "profile",
        label: `profile:${profile}`,
        writable: identity.uid === 0,
      },
    });
  } else if (isPackageAiContextProfile(profile)) {
    const resolved = resolvePackageProfileReference(
      profile,
      ctx.packages,
      visiblePackageScopesForActor(identity),
    );
    if (resolved) {
      roots.push({
        rootPath: `/src/packages/${packageSourcePathName(resolved.record)}/profiles/${resolved.packageProfile.name}/skills.d`,
        source: {
          kind: "profile",
          label: `profile:${profile}`,
          writable: packageSourceWritable(resolved.record, identity),
        },
      });
    }
  }

  roots.push({
    rootPath: `${identity.home}/skills.d`,
    source: {
      kind: "home",
      label: "home",
      writable: true,
    },
  });

  if (identity.workspaceId) {
    roots.push({
      rootPath: `/workspaces/${identity.workspaceId}/.gsv/skills.d`,
      source: {
        kind: "workspace",
        label: `workspace:${identity.workspaceId}`,
        writable: true,
      },
    });
  }

  for (const record of ctx.packages.list({
    enabled: true,
    scopes: visiblePackageScopesForActor(identity),
  })) {
    roots.push({
      rootPath: `/src/packages/${packageSourcePathName(record)}/skills.d`,
      source: {
        kind: "package",
        label: `pkg:${record.manifest.name}`,
        writable: packageSourceWritable(record, identity),
      },
    });
  }

  return roots;
}

async function collectFsSkillFiles(
  fs: FsReader,
  rootPath: string,
  source: SkillSource,
): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  await walkFsSkillRoot(fs, rootPath.replace(/\/+$/, ""), "", source, files, 0);
  return files;
}

async function walkFsSkillRoot(
  fs: FsReader,
  absolutePath: string,
  relativePath: string,
  source: SkillSource,
  files: SkillFile[],
  depth: number,
): Promise<void> {
  if (depth > MAX_SKILL_WALK_DEPTH) {
    return;
  }

  let names: string[];
  try {
    names = await fs.readdir(absolutePath);
  } catch {
    return;
  }

  if (names.includes("SKILL.md") && relativePath) {
    const path = `${absolutePath}/SKILL.md`;
    const content = await readFsText(fs, path);
    if (content !== null) {
      files.push({
        fallbackName: fallbackSkillName(`${relativePath}/SKILL.md`),
        content,
        path,
        source,
      });
    }
    return;
  }

  for (const name of names.sort((left, right) => left.localeCompare(right))) {
    const path = `${absolutePath}/${name}`;
    const rel = relativePath ? `${relativePath}/${name}` : name;
    let stat: { isFile: boolean; isDirectory: boolean };
    try {
      stat = await fs.stat(path);
    } catch {
      continue;
    }
    if (stat.isFile && depth === 0 && name.endsWith(".md") && name !== "DESCRIPTION.md") {
      const content = await readFsText(fs, path);
      if (content !== null) {
        files.push({
          fallbackName: fallbackSkillName(rel),
          content,
          path,
          source,
        });
      }
      continue;
    }
    if (stat.isDirectory) {
      await walkFsSkillRoot(fs, path, rel, source, files, depth + 1);
    }
  }
}

async function collectRipgitSkillFiles(
  ripgit: RipgitClient,
  repo: RipgitRepoRef,
  rootPath: string,
  source: SkillSource,
  virtualRoot: string,
): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  await walkRipgitSkillRoot(ripgit, repo, trimSlashes(rootPath), "", source, trimTrailingSlash(virtualRoot), files, 0);
  return files;
}

async function walkRipgitSkillRoot(
  ripgit: RipgitClient,
  repo: RipgitRepoRef,
  absolutePath: string,
  relativePath: string,
  source: SkillSource,
  virtualRoot: string,
  files: SkillFile[],
  depth: number,
): Promise<void> {
  if (depth > MAX_SKILL_WALK_DEPTH) {
    return;
  }

  const tree = await ripgit.readPath(repo, absolutePath).catch(() => ({ kind: "missing" as const }));
  if (tree.kind !== "tree") {
    return;
  }

  const skillEntry = tree.entries.find((entry) => entry.type === "blob" && entry.name === "SKILL.md");
  if (skillEntry && relativePath) {
    const path = joinPath(absolutePath, "SKILL.md");
    const file = await ripgit.readPath(repo, path).catch(() => ({ kind: "missing" as const }));
    if (file.kind === "file") {
      const content = decodeTextFile(file.bytes);
      if (content !== null) {
        files.push({
          fallbackName: fallbackSkillName(`${relativePath}/SKILL.md`),
          content,
          path: `${virtualRoot}/${relativePath}/SKILL.md`,
          source,
        });
      }
    }
    return;
  }

  for (const entry of tree.entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = joinPath(absolutePath, entry.name);
    const rel = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.type === "blob" && depth === 0 && entry.name.endsWith(".md") && entry.name !== "DESCRIPTION.md") {
      const file = await ripgit.readPath(repo, path).catch(() => ({ kind: "missing" as const }));
      if (file.kind === "file") {
        const content = decodeTextFile(file.bytes);
        if (content !== null) {
          files.push({
            fallbackName: fallbackSkillName(rel),
            content,
            path: `${virtualRoot}/${entry.name}`,
            source,
          });
        }
      }
      continue;
    }
    if (entry.type === "tree") {
      await walkRipgitSkillRoot(ripgit, repo, path, rel, source, virtualRoot, files, depth + 1);
    }
  }
}

async function walkFsSupportingFiles(
  fs: FsReader,
  root: string,
  rel: string,
  files: string[],
  depth: number,
): Promise<void> {
  if (depth > MAX_SKILL_WALK_DEPTH) {
    return;
  }
  const path = rel ? `${root}/${rel}` : root;
  let names: string[];
  try {
    names = await fs.readdir(path);
  } catch {
    return;
  }

  for (const name of names.sort((left, right) => left.localeCompare(right))) {
    if (name === "SKILL.md") {
      continue;
    }
    const childRel = rel ? `${rel}/${name}` : name;
    const childPath = `${root}/${childRel}`;
    let stat: { isFile: boolean; isDirectory: boolean };
    try {
      stat = await fs.stat(childPath);
    } catch {
      continue;
    }
    if (stat.isFile) {
      files.push(childRel);
    } else if (stat.isDirectory) {
      await walkFsSupportingFiles(fs, root, childRel, files, depth + 1);
    }
  }
}

async function readFsText(fs: FsReader, path: string): Promise<string | null> {
  try {
    const content = await fs.readFile(path);
    return content.trim().length > 0 ? content : null;
  } catch {
    return null;
  }
}

function buildSkillDocuments(files: SkillFile[]): SkillDocument[] {
  const parsed = files
    .map((file) => {
      const skill = parseSkillMarkdown(file.content, file.fallbackName);
      if (!skill.name) {
        return null;
      }
      return {
        ...file,
        name: skill.name,
        description: skill.description,
      };
    })
    .filter((file): file is SkillFile & { name: string; description: string } => file !== null)
    .sort((left, right) => {
      const source = sourceRank(left.source.kind) - sourceRank(right.source.kind);
      if (source !== 0) {
        return source;
      }
      const label = left.source.label.localeCompare(right.source.label);
      if (label !== 0) {
        return label;
      }
      return left.name.localeCompare(right.name);
    });

  const counts = new Map<string, number>();
  for (const file of parsed) {
    const key = normalizeLookup(file.name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return parsed.map((file) => ({
    id: skillId(file.name, file.source, counts.get(normalizeLookup(file.name)) ?? 0),
    name: file.name,
    description: file.description,
    content: file.content.trimEnd(),
    path: file.path,
    source: file.source,
  }));
}

function skillId(name: string, source: SkillSource, count: number): string {
  if (count <= 1) {
    return name;
  }
  if (source.kind === "package") {
    return `${source.label.slice("pkg:".length)}:${name}`;
  }
  return `${source.kind}:${name}`;
}

function sourceRank(kind: SkillSourceKind): number {
  switch (kind) {
    case "profile": return 0;
    case "home": return 1;
    case "workspace": return 2;
    case "package": return 3;
  }
}

function currentProcessProfile(ctx: KernelContext): AiContextProfile | null {
  if (!ctx.processId) {
    return null;
  }
  const procs = ctx.procs as unknown as { get?: (processId: string) => { profile?: string } | null };
  const proc = procs.get?.(ctx.processId);
  return proc?.profile as AiContextProfile | null;
}

function packageTopLevelSkillRoot(record: InstalledPackageRecord): {
  repo: RipgitRepoRef;
  path: string;
  virtualPath: string;
} | null {
  const repo = repoRefFromPackage(record);
  if (!repo) {
    return null;
  }
  return {
    repo,
    path: joinPath(record.manifest.source.subdir, "skills.d"),
    virtualPath: `/src/packages/${packageSourcePathName(record)}/skills.d`,
  };
}

function packageProfileSkillRoot(record: InstalledPackageRecord, profileName: string): {
  repo: RipgitRepoRef;
  path: string;
  virtualPath: string;
} | null {
  const repo = repoRefFromPackage(record);
  if (!repo) {
    return null;
  }
  const profileRoot = joinPath(record.manifest.source.subdir, "profiles");
  return {
    repo,
    path: joinPath(joinPath(profileRoot, profileName), "skills.d"),
    virtualPath: `/src/packages/${packageSourcePathName(record)}/profiles/${profileName}/skills.d`,
  };
}

function repoRefFromPackage(record: InstalledPackageRecord): RipgitRepoRef | null {
  const [owner, repo, ...rest] = record.manifest.source.repo.split("/");
  if (!owner || !repo || rest.length > 0) {
    return null;
  }
  return {
    owner,
    repo,
    branch: record.manifest.source.resolvedCommit ?? record.manifest.source.ref,
  };
}

function packageSourceWritable(record: InstalledPackageRecord, identity: ProcessIdentity): boolean {
  if (identity.uid === 0) {
    return true;
  }
  return record.scope.kind === "user" && record.scope.uid === identity.uid;
}

function parseFrontmatter(content: string): { frontmatter: Map<string, string>; body: string } {
  const frontmatter = new Map<string, string>();
  if (!content.startsWith("---")) {
    return { frontmatter, body: content };
  }

  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter, body: content };
  }

  const raw = content.slice(3, end);
  const body = content.slice(end + 4).replace(/^\r?\n/, "");
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1];
    const value = match[2].trim();
    if (value === ">" || value === "|") {
      const block: string[] = [];
      while (index + 1 < lines.length && /^(?:\s+|$)/.test(lines[index + 1])) {
        index += 1;
        block.push(lines[index].trim());
      }
      frontmatter.set(key, value === ">" ? block.join(" ") : block.join("\n"));
      continue;
    }
    frontmatter.set(key, unquoteYamlScalar(value));
  }
  return { frontmatter, body };
}

function firstBodyDescription(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("---")) {
      continue;
    }
    return trimmed;
  }
  return "";
}

function unquoteYamlScalar(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeSkillName(value: string): string {
  return value.trim().replace(/\s+/g, "-").toLowerCase();
}

function normalizeLookup(value: string): string {
  return value.trim().toLowerCase();
}

function truncateDescription(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= MAX_DESCRIPTION_LENGTH) {
    return oneLine;
  }
  return `${oneLine.slice(0, MAX_DESCRIPTION_LENGTH - 3).trimEnd()}...`;
}

function fallbackSkillName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.at(-1) === "SKILL.md" && parts.length >= 2) {
    return parts[parts.length - 2];
  }
  const last = parts.at(-1) ?? "skill";
  return last.replace(/\.md$/i, "");
}

function isSkillMarkdownPath(path: string): boolean {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 1) {
    return parts[0].endsWith(".md") && parts[0] !== "DESCRIPTION.md";
  }
  return parts.at(-1) === "SKILL.md";
}

function decodeTextFile(bytes: Uint8Array): string | null {
  for (const byte of bytes) {
    if (byte === 0) {
      return null;
    }
  }
  const text = TEXT_DECODER.decode(bytes).trim();
  return text.length > 0 ? text : null;
}

function joinPath(base: string, child: string): string {
  const normalizedBase = trimSlashes(base);
  const normalizedChild = trimSlashes(child);
  if (!normalizedBase) {
    return normalizedChild;
  }
  if (!normalizedChild) {
    return normalizedBase;
  }
  return `${normalizedBase}/${normalizedChild}`;
}

function trimSlashes(path: string): string {
  return path.trim().replace(/^\/+|\/+$/g, "");
}

function trimTrailingSlash(path: string): string {
  return path.replace(/\/+$/g, "");
}
