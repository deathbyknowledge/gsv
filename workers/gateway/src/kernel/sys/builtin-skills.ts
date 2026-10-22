import browserTargetSkill from "../../../../../skills/browser-target/SKILL.md";
import contactsSkill from "../../../../../skills/contacts/SKILL.md";
import gsvManualSkill from "../../../../../skills/gsv-manual/SKILL.md";
import imageReadingSkill from "../../../../../skills/image-reading/SKILL.md";
import memorySkill from "../../../../../skills/memory/SKILL.md";
import processOrchestrationSkill from "../../../../../skills/process-orchestration/SKILL.md";
import skillAuthoringSkill from "../../../../../skills/skill-authoring/SKILL.md";

/** Built-in skills, served read-only to every process at /sys/skills.d. */
export const SYSTEM_SKILLS_ROOT = "/sys/skills.d";

/** Each file of the bundled `skills/` directory, by path relative to /sys/skills.d. */
const BUILTIN_SKILL_FILES = new Map<string, string>([
  ["browser-target/SKILL.md", browserTargetSkill],
  ["contacts/SKILL.md", contactsSkill],
  ["gsv-manual/SKILL.md", gsvManualSkill],
  ["image-reading/SKILL.md", imageReadingSkill],
  ["memory/SKILL.md", memorySkill],
  ["process-orchestration/SKILL.md", processOrchestrationSkill],
  ["skill-authoring/SKILL.md", skillAuthoringSkill],
]);

/** Built-in names are reserved: a home skill cannot take one. */
export const BUILTIN_SKILL_NAMES: ReadonlySet<string> = new Set(
  [...BUILTIN_SKILL_FILES.keys()].map((path) => path.split("/")[0]),
);

export type SystemSkillEntry =
  | { kind: "file"; content: string }
  | { kind: "directory"; entries: string[] }
  | { kind: "missing" };

/** Resolves a path under /sys/skills.d against the bundled files. */
export function readSystemSkillPath(path: string): SystemSkillEntry {
  const rel = path === SYSTEM_SKILLS_ROOT ? "" : path.startsWith(`${SYSTEM_SKILLS_ROOT}/`) ? path.slice(SYSTEM_SKILLS_ROOT.length + 1) : null;
  if (rel === null) return { kind: "missing" };
  const content = BUILTIN_SKILL_FILES.get(rel);
  if (content !== undefined) return { kind: "file", content };
  const prefix = rel ? `${rel}/` : "";
  const entries = new Set<string>();
  for (const file of BUILTIN_SKILL_FILES.keys()) {
    if (file.startsWith(prefix)) entries.add(file.slice(prefix.length).split("/")[0]);
  }
  return entries.size > 0 ? { kind: "directory", entries: [...entries].sort() } : { kind: "missing" };
}

/** Read-only view of /sys/skills.d for the skill collectors. */
export const systemSkillsReader = {
  async readdir(path: string): Promise<string[]> {
    const entry = readSystemSkillPath(path);
    if (entry.kind !== "directory") throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
    return entry.entries;
  },
  async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean }> {
    const entry = readSystemSkillPath(path);
    if (entry.kind === "missing") throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    return { isFile: entry.kind === "file", isDirectory: entry.kind === "directory" };
  },
  async readFile(path: string): Promise<string> {
    const entry = readSystemSkillPath(path);
    if (entry.kind !== "file") throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    return entry.content;
  },
};
