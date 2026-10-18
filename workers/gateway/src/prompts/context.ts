import runtime from "./system/context.d/00-runtime.md";
import gsv from "./system/context.d/01-gsv.md";
import interaction from "./system/context.d/02-interaction.md";
import targets from "./system/context.d/05-targets.md";
import responsibilities from "./system/context.d/10-responsibilities.md";
import memory from "./system/context.d/15-memory.md";
import discovery from "./system/context.d/20-discovery.md";
import processes from "./system/context.d/30-process-orchestration.md";
import shipRole from "./ship/context.d/00-role.md";
import voice from "./ship/context.d/05-voice.md";
import delegation from "./ship/context.d/10-delegation.md";
import crewRole from "./crew/context.d/00-role.md";
import personal from "./user/context.d/10-personal.md";

// The bundle and source editor share this catalogue. Every source is one complete entry.
export const CONTEXT_SOURCES = {
  // Used by ConfigStore defaults for config/ai/context.d/00-runtime.md.
  "system/context.d/00-runtime.md": runtime,
  // Used by ConfigStore defaults for config/ai/context.d/01-gsv.md.
  "system/context.d/01-gsv.md": gsv,
  "system/context.d/02-interaction.md": interaction,
  // Used by ConfigStore defaults for config/ai/context.d/05-targets.md.
  "system/context.d/05-targets.md": targets,
  // Used by ConfigStore defaults for config/ai/context.d/10-responsibilities.md.
  "system/context.d/10-responsibilities.md": responsibilities,
  "system/context.d/15-memory.md": memory,
  // Used by ConfigStore defaults for config/ai/context.d/20-discovery.md.
  "system/context.d/20-discovery.md": discovery,
  // Used by ConfigStore defaults for config/ai/context.d/30-process-orchestration.md.
  "system/context.d/30-process-orchestration.md": processes,
  "ship/context.d/00-role.md": shipRole,
  "ship/context.d/05-voice.md": voice,
  "ship/context.d/10-delegation.md": delegation,
  "crew/context.d/00-role.md": crewRole,
  "user/context.d/10-personal.md": personal,
} satisfies Record<string, string>;

export type ContextScope = "system" | "ship" | "crew" | "user";

export function contextFiles(scope: ContextScope): Array<{ name: string; text: string }> {
  const prefix = `${scope}/context.d/`;
  return Object.entries(CONTEXT_SOURCES)
    .filter(([path]) => path.startsWith(prefix))
    .map(([path, text]) => ({ name: path.slice(prefix.length), text }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
