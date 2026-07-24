import browserTargetSkill from "../../../../skills/browser-target/SKILL.md";
import gsvManualSkill from "../../../../skills/gsv-manual/SKILL.md";
import skillAuthoringSkill from "../../../../skills/skill-authoring/SKILL.md";

export const BUILTIN_SKILL_FILES = [
  {
    path: "browser-target/SKILL.md",
    content: browserTargetSkill,
  },
  {
    path: "gsv-manual/SKILL.md",
    content: gsvManualSkill,
  },
  {
    path: "skill-authoring/SKILL.md",
    content: skillAuthoringSkill,
  },
] as const;
