import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import {
  homeKnowledgeRepoRef,
  RipgitClient,
  type RipgitApplyOp,
  type RipgitRepoRef,
  type RipgitTreeEntry,
} from "../../fs";

const SOURCE_KNOWLEDGE_ROOT = "knowledge/gsv";
const TARGET_KNOWLEDGE_ROOT = "knowledge/gsv";
const KNOWLEDGE_DIR_MARKER = "knowledge/.dir";
const GSV_KNOWLEDGE_DIR_MARKER = `${TARGET_KNOWLEDGE_ROOT}/.dir`;

export type BootstrapKnowledgeSeedResult = {
  username: string;
  copied: number;
  skipped: number;
};

type KnowledgeSeedOptions = {
  concurrency?: number;
  schedule?: <T>(run: () => T | Promise<T>) => Promise<T>;
};

type KnowledgeSeedFileResult =
  | { status: "copy"; path: string; contentBytes: number[] }
  | { status: "skip" };

export async function seedRepoKnowledgeToHome(
  ripgit: RipgitClient,
  sourceRepo: RipgitRepoRef,
  identity: ProcessIdentity,
  options: KnowledgeSeedOptions = {},
): Promise<BootstrapKnowledgeSeedResult> {
  const schedule = options.schedule ?? ((run) => Promise.resolve().then(run));
  const sourceFiles = await listSourceKnowledgeFiles(ripgit, sourceRepo, SOURCE_KNOWLEDGE_ROOT, schedule);
  if (sourceFiles.length === 0) {
    return {
      username: identity.username,
      copied: 0,
      skipped: 0,
    };
  }

  const homeRepo = homeKnowledgeRepoRef(identity.username);
  const ops: RipgitApplyOp[] = [];
  let skipped = 0;

  const [knowledgeDir, gsvKnowledgeDir] = await Promise.all([
    schedule(() => ripgit.readPath(homeRepo, "knowledge")),
    schedule(() => ripgit.readPath(homeRepo, TARGET_KNOWLEDGE_ROOT)),
  ]);
  if (knowledgeDir.kind === "missing") {
    ops.push({
      type: "put",
      path: KNOWLEDGE_DIR_MARKER,
      contentBytes: [],
    });
  }
  if (gsvKnowledgeDir.kind === "missing") {
    ops.push({
      type: "put",
      path: GSV_KNOWLEDGE_DIR_MARKER,
      contentBytes: [],
    });
  }

  const fileResults = await mapWithConcurrency(
    sourceFiles,
    options.concurrency ?? 5,
    async (sourcePath): Promise<KnowledgeSeedFileResult> => {
      const relativePath = sourcePath.slice(`${SOURCE_KNOWLEDGE_ROOT}/`.length);
      const targetPath = `${TARGET_KNOWLEDGE_ROOT}/${relativePath}`;
      const existing = await schedule(() => ripgit.readPath(homeRepo, targetPath));
      if (existing.kind !== "missing") {
        return { status: "skip" };
      }

      const source = await schedule(() => ripgit.readPath(sourceRepo, sourcePath));
      if (source.kind !== "file") {
        return { status: "skip" };
      }

      return {
        status: "copy",
        path: targetPath,
        contentBytes: Array.from(source.bytes),
      };
    },
  );

  for (const result of fileResults) {
    if (result.status === "skip") {
      skipped += 1;
    } else {
      ops.push({
        type: "put",
        path: result.path,
        contentBytes: result.contentBytes,
      });
    }
  }

  if (ops.length > 0) {
    await schedule(() => ripgit.apply(
      homeRepo,
      identity.username,
      `${identity.username}@gsv.local`,
      "gsv: seed bootstrap knowledge",
      ops,
    ));
  }

  return {
    username: identity.username,
    copied: ops.filter((op) =>
      op.type === "put"
      && op.path !== KNOWLEDGE_DIR_MARKER
      && op.path !== GSV_KNOWLEDGE_DIR_MARKER
    ).length,
    skipped,
  };
}

async function listSourceKnowledgeFiles(
  ripgit: RipgitClient,
  repo: RipgitRepoRef,
  root: string,
  schedule: <T>(run: () => T | Promise<T>) => Promise<T>,
): Promise<string[]> {
  const tree = await schedule(() => ripgit.readPath(repo, root));
  if (tree.kind !== "tree") {
    return [];
  }

  const files: string[] = [];
  await walkSourceKnowledgeFiles(ripgit, repo, root, tree.entries, files, 0, schedule);
  return files.sort((left, right) => left.localeCompare(right));
}

async function walkSourceKnowledgeFiles(
  ripgit: RipgitClient,
  repo: RipgitRepoRef,
  path: string,
  entries: RipgitTreeEntry[],
  files: string[],
  depth: number,
  schedule: <T>(run: () => T | Promise<T>) => Promise<T>,
): Promise<void> {
  if (depth > 12) {
    return;
  }

  for (const entry of entries) {
    if (entry.name === ".dir" || entry.name === ".git" || entry.name === ".github") {
      continue;
    }
    const child = `${path}/${entry.name}`;
    if (entry.type === "blob") {
      files.push(child);
      continue;
    }
    if (entry.type === "tree") {
      const tree = await schedule(() => ripgit.readPath(repo, child));
      if (tree.kind === "tree") {
        await walkSourceKnowledgeFiles(ripgit, repo, child, tree.entries, files, depth + 1, schedule);
      }
    }
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) {
        return;
      }
      results[index] = await mapper(values[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}
