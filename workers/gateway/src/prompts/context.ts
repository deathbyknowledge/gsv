import environment from "./system/context.d/environment.md";
import shipBehaviour from "./ship/context.d/behaviour.md";
import shipVoice from "./ship/context.d/voice.md";
import crewBehaviour from "./crew/context.d/behaviour.md";
import personal from "./user/context.d/10-personal.md";

// The bundle and source editor share this catalogue. Every source is one complete entry.
// System, Ship and Crew sources are the ConfigStore defaults under config/ai/{,ship/,crew/}context.d;
// the user source seeds the owner's home.
export const CONTEXT_SOURCES = {
  "system/context.d/environment.md": environment,
  "ship/context.d/behaviour.md": shipBehaviour,
  "ship/context.d/voice.md": shipVoice,
  "crew/context.d/behaviour.md": crewBehaviour,
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
