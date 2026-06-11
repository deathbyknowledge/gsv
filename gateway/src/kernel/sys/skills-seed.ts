import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import {
  accountHomeRepoRef,
  RipgitClient,
  type RipgitApplyOp,
  type RipgitRepoRef,
} from "../../fs";

const SOURCE_SKILLS_ROOT = "skills";
const TARGET_SKILLS_ROOT = "skills.d";
const SKILLS_DIR_MARKER = `${TARGET_SKILLS_ROOT}/.dir`;

export type BootstrapSkillSeedResult = {
  username: string;
  copied: number;
  skipped: number;
};

export async function seedRepoSkillsToHome(
  ripgit: RipgitClient,
  sourceRepo: RipgitRepoRef,
  identity: ProcessIdentity,
): Promise<BootstrapSkillSeedResult> {
  const sourceFiles = await listSourceSkillFiles(ripgit, sourceRepo, SOURCE_SKILLS_ROOT);
  const homeRepo = accountHomeRepoRef(identity.username);
  const ops: RipgitApplyOp[] = [];
  let skipped = 0;

  const skillsDir = await ripgit.readPath(homeRepo, TARGET_SKILLS_ROOT);
  if (skillsDir.kind === "missing") {
    ops.push({
      type: "put",
      path: SKILLS_DIR_MARKER,
      contentBytes: [],
    });
  }

  for (const sourcePath of sourceFiles) {
    const relativePath = sourcePath.slice(`${SOURCE_SKILLS_ROOT}/`.length);
    const targetPath = `${TARGET_SKILLS_ROOT}/${relativePath}`;
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
      "gsv: seed bootstrap skills",
      ops,
    );
  }

  return {
    username: identity.username,
    copied: ops.filter((op) => op.type === "put" && op.path !== SKILLS_DIR_MARKER).length,
    skipped,
  };
}

async function listSourceSkillFiles(
  ripgit: RipgitClient,
  repo: RipgitRepoRef,
  root: string,
): Promise<string[]> {
  const files: string[] = [];
  await walkSourceSkillFiles(ripgit, repo, root, files, 0);
  return files.sort((left, right) => left.localeCompare(right));
}

async function walkSourceSkillFiles(
  ripgit: RipgitClient,
  repo: RipgitRepoRef,
  path: string,
  files: string[],
  depth: number,
): Promise<void> {
  if (depth > 12) {
    return;
  }

  const tree = await ripgit.readPath(repo, path);
  if (tree.kind === "missing") {
    return;
  }
  if (tree.kind === "file") {
    files.push(path);
    return;
  }

  for (const entry of tree.entries) {
    if (entry.name === ".dir" || entry.name === ".git" || entry.name === ".github") {
      continue;
    }
    const child = `${path}/${entry.name}`;
    if (entry.type === "blob") {
      files.push(child);
      continue;
    }
    if (entry.type === "tree") {
      await walkSourceSkillFiles(ripgit, repo, child, files, depth + 1);
    }
  }
}
