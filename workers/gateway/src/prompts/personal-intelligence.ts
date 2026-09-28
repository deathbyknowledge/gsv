import shipRole from "./role-and-judgment/ship.md";
import shipResponsibilities from "./durable-work/ship.md";
import shipExecution from "./role-and-judgment/ship-execution.md";
import shipInteraction from "./interaction/ship.md";
import shipKnowledge from "./knowledge/ship.md";
import voiceContext from "./voice/ship.md";
import crewContext from "./role-and-judgment/crew.md";
import delegationText from "./instance-facts/ship.md";

export const PERSONAL_INTELLIGENCE_CONTEXT = [
  shipRole, shipResponsibilities, shipExecution, shipInteraction, shipKnowledge,
].map((text) => text.trimEnd()).join("\n\n") + "\n";

export const PERSONAL_INTELLIGENCE_VOICE_CONTEXT = voiceContext;

export const RETIRED_PERSONAL_INTELLIGENCE_COMMITMENTS_CONTEXT = `# Commitments

This is the personal intelligence's compact working memory for promises that must survive the current response. Keep only open commitments. Each entry should state the promised outcome, current state, delegated task id, worker pid, deadline, and opaque reply destination when one exists.

Reconcile entries when results, failures, or timeouts arrive. A past deadline is not "in progress." Remove an entry only after GSV has closed the user-facing loop; durable history belongs elsewhere.

No open commitments.
`;

export const CREW_CONTEXT = crewContext;

export function crewDelegationContext(username: string): string {
  return delegationText.replaceAll("{{crew.username}}", () => username);
}
