import shipRole from "./ship/context.d/00-role.md";
import voiceContext from "./ship/context.d/05-voice.md";
import crewContext from "./crew/context.d/00-role.md";
import { contextFiles } from "./context";

export const PERSONAL_INTELLIGENCE_CONTEXT = shipRole;

export const PERSONAL_INTELLIGENCE_VOICE_CONTEXT = voiceContext;

export const RETIRED_PERSONAL_INTELLIGENCE_COMMITMENTS_CONTEXT = `# Commitments

This is the personal intelligence's compact working memory for promises that must survive the current response. Keep only open commitments. Each entry should state the promised outcome, current state, delegated task id, worker pid, deadline, and opaque reply destination when one exists.

Reconcile entries when results, failures, or timeouts arrive. A past deadline is not "in progress." Remove an entry only after GSV has closed the user-facing loop; durable history belongs elsewhere.

No open commitments.
`;

export const CREW_CONTEXT = crewContext;

export function shipContextFiles(crewUsername?: string): Array<{ name: string; text: string }> {
  return contextFiles("ship")
    .filter(({ text }) => crewUsername !== undefined || !text.includes("{{crew.username}}"))
    .map(({ name, text }) => ({
      name, text: text.replaceAll("{{crew.username}}", () => crewUsername ?? "{{crew.username}}"),
    }));
}
