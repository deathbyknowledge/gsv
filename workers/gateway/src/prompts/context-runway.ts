import type { ProcHistoryContextPolicy } from "@humansandmachines/gsv/protocol";
import handoverGuidance from "./tasks/context-runway.md";

export function formatContextRunwayAlertMessage(input: {
  remainingInputTokens: number;
  runwayBeforeBoundaryTokens: number;
  policy: ProcHistoryContextPolicy;
  handover?: true;
}): string {
  const safetyBoundary = input.policy.overflow === "auto-compact"
    ? `Automatic compaction in ~${input.runwayBeforeBoundaryTokens.toLocaleString("en-US")} tokens (${Math.round(input.policy.compactAtPressure * 100)}% boundary).`
    : `Process stops in ~${input.runwayBeforeBoundaryTokens.toLocaleString("en-US")} tokens (${Math.round(input.policy.compactAtPressure * 100)}% boundary).`;
  return [
    `Context low: ~${input.remainingInputTokens.toLocaleString("en-US")} input tokens remain. ${safetyBoundary}`,
    "",
    ...(input.handover ? [handoverGuidance.trimEnd()] : [
      "Preserve durable knowledge in the Personal wiki, explicit stable facts or preferences in standing context, and unresolved commitments in the responsibility ledger.",
      "Don’t preserve transient details just because context is low. Continue normally if nothing needs preserving.",
    ]),
  ].join("\n");
}
