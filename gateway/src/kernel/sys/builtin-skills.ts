import browserTargetSkill from "../../../../skills/browser-target/SKILL.md";
import gsvManualSkill from "../../../../skills/gsv-manual/SKILL.md";
import imageReadingSkill from "../../../../skills/image-reading/SKILL.md";
import memorySkill from "../../../../skills/memory/SKILL.md";
import processOrchestrationSkill from "../../../../skills/process-orchestration/SKILL.md";
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
    path: "image-reading/SKILL.md",
    content: imageReadingSkill,
  },
  {
    path: "memory/SKILL.md",
    content: memorySkill,
  },
  {
    path: "process-orchestration/SKILL.md",
    content: processOrchestrationSkill,
  },
  {
    path: "skill-authoring/SKILL.md",
    content: skillAuthoringSkill,
  },
] as const;
