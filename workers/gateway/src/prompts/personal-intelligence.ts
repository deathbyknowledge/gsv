import shipContext from "./ship/00-role.md";
import voiceContext from "./ship/05-voice.md";
import crewContext from "./crew/00-role.md";
import delegationText from "./ship/10-delegation.md";

export const PERSONAL_INTELLIGENCE_CONTEXT = shipContext;

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
