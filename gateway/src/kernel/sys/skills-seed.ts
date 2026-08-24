import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import {
  accountHomeRepoRef,
  RipgitClient,
  type RipgitApplyOp,
} from "../../fs";
import { BUILTIN_SKILL_FILES } from "./builtin-skills";

const TARGET_SKILLS_ROOT = "skills.d";
const SKILLS_DIR_MARKER = `${TARGET_SKILLS_ROOT}/.dir`;
const TEXT_DECODER = new TextDecoder();

export type BuiltinSkillSeedResult = {
  username: string;
  copied: number;
  skipped: number;
};

export async function seedBuiltinSkillsToHome(
  ripgit: RipgitClient,
  identity: ProcessIdentity,
): Promise<BuiltinSkillSeedResult> {
  const homeRepo = accountHomeRepoRef(identity.username);
  const ops: RipgitApplyOp[] = [];
  let skipped = 0;

  const [skillsDir, ...existingSkills] = await Promise.all([
    ripgit.readPath(homeRepo, TARGET_SKILLS_ROOT),
    ...BUILTIN_SKILL_FILES.map((skill) =>
      ripgit.readPath(homeRepo, `${TARGET_SKILLS_ROOT}/${skill.path}`)
    ),
  ]);
  if (skillsDir.kind === "missing") {
    ops.push({
      type: "put",
      path: SKILLS_DIR_MARKER,
      contentBytes: [],
    });
  }

  for (const [index, skill] of BUILTIN_SKILL_FILES.entries()) {
    const targetPath = `${TARGET_SKILLS_ROOT}/${skill.path}`;
    const existing = existingSkills[index];
    if (existing.kind !== "missing") {
      const previousContents: readonly string[] = "previousContents" in skill
        ? skill.previousContents
        : [];
      const previousSha256s: readonly string[] = "previousSha256s" in skill
        ? skill.previousSha256s
        : [];
      const matchesPreviousHash = existing.kind === "file"
        && previousSha256s.length > 0
        && previousSha256s.includes(await sha256Hex(existing.bytes));
      if (
        existing.kind !== "file"
        || (
          !previousContents.includes(TEXT_DECODER.decode(existing.bytes))
          && !matchesPreviousHash
        )
      ) {
        skipped += 1;
        continue;
      }
    }

    ops.push({
      type: "put",
      path: targetPath,
      contentBytes: Array.from(new TextEncoder().encode(skill.content)),
    });
  }

  if (ops.length > 0) {
    await ripgit.apply(
      homeRepo,
      identity.username,
      `${identity.username}@gsv.local`,
      "gsv: seed built-in skills",
      ops,
    );
  }

  return {
    username: identity.username,
    copied: ops.filter((op) => op.type === "put" && op.path !== SKILLS_DIR_MARKER).length,
    skipped,
  };
}

async function sha256Hex(bytes: Uint8Array | number[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
