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

export async function seedRepoKnowledgeToHome(
  ripgit: RipgitClient,
  sourceRepo: RipgitRepoRef,
  identity: ProcessIdentity,
): Promise<BootstrapKnowledgeSeedResult> {
  const sourceFiles = await listSourceKnowledgeFiles(ripgit, sourceRepo, SOURCE_KNOWLEDGE_ROOT);
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
    ripgit.readPath(homeRepo, "knowledge"),
    ripgit.readPath(homeRepo, TARGET_KNOWLEDGE_ROOT),
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

  for (const sourcePath of sourceFiles) {
    const relativePath = sourcePath.slice(`${SOURCE_KNOWLEDGE_ROOT}/`.length);
    const targetPath = `${TARGET_KNOWLEDGE_ROOT}/${relativePath}`;
    const existing = await ripgit.readPath(homeRepo, targetPath);
    if (existing.kind !== "missing") {
      skipped += 1;
      continue;
    }

    const source = await ripgit.readPath(sourceRepo, sourcePath);
    if (source.kind !== "file") {
      skipped += 1;
      continue;
    }

    ops.push({
      type: "put",
      path: targetPath,
      contentBytes: Array.from(source.bytes),
    });
  }

  if (ops.length > 0) {
    await ripgit.apply(
      homeRepo,
      identity.username,
      `${identity.username}@gsv.local`,
      "gsv: seed bootstrap knowledge",
      ops,
    );
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
): Promise<string[]> {
  const tree = await ripgit.readPath(repo, root);
  if (tree.kind !== "tree") {
    return [];
  }

  const files: string[] = [];
  await walkSourceKnowledgeFiles(ripgit, repo, root, tree.entries, files, 0);
  return files.sort((left, right) => left.localeCompare(right));
}

async function walkSourceKnowledgeFiles(
  ripgit: RipgitClient,
  repo: RipgitRepoRef,
  path: string,
  entries: RipgitTreeEntry[],
  files: string[],
  depth: number,
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
      const tree = await ripgit.readPath(repo, child);
      if (tree.kind === "tree") {
        await walkSourceKnowledgeFiles(ripgit, repo, child, tree.entries, files, depth + 1);
      }
    }
  }
}
