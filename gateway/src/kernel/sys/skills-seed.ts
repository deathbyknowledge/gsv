import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import {
  accountHomeRepoRef,
  RipgitClient,
  type RipgitApplyOp,
} from "../../fs";
import { BUILTIN_SKILL_FILES } from "./builtin-skills";

const TARGET_SKILLS_ROOT = "skills.d";
const SKILLS_DIR_MARKER = `${TARGET_SKILLS_ROOT}/.dir`;

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

  const skillsDir = await ripgit.readPath(homeRepo, TARGET_SKILLS_ROOT);
  if (skillsDir.kind === "missing") {
    ops.push({
      type: "put",
      path: SKILLS_DIR_MARKER,
      contentBytes: [],
    });
  }

  for (const skill of BUILTIN_SKILL_FILES) {
    const targetPath = `${TARGET_SKILLS_ROOT}/${skill.path}`;
    const existing = await ripgit.readPath(homeRepo, targetPath);
    if (existing.kind !== "missing") {
      skipped += 1;
      continue;
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
