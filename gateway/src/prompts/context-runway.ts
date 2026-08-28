import type { ProcHistoryContextPolicy } from "@humansandmachines/gsv/protocol";

export function formatContextRunwayAlertMessage(input: {
  remainingInputTokens: number;
  runwayBeforeBoundaryTokens: number;
  policy: ProcHistoryContextPolicy;
}): string {
  const safetyBoundary = input.policy.overflow === "auto-compact"
    ? `About ${input.runwayBeforeBoundaryTokens.toLocaleString("en-US")} tokens of that runway remain before GSV automatically compacts older Process history at the configured ${Math.round(input.policy.compactAtPressure * 100)}% safety boundary.`
    : `About ${input.runwayBeforeBoundaryTokens.toLocaleString("en-US")} tokens of that runway remain before this Process stops at its configured ${Math.round(input.policy.compactAtPressure * 100)}% context-pressure boundary.`;
  return [
    "Context runway is getting low.",
    "",
    `About ${input.remainingInputTokens.toLocaleString("en-US")} input tokens remain before the model's reserved output budget.`,
    "Preserve anything that should survive compaction now: use the Personal wiki for durable knowledge, standing context only for explicit stable facts or preferences, and the responsibility ledger for unresolved commitments.",
    "Do not promote transient details merely because the context window is filling.",
    safetyBoundary,
    "Continue normally if there is nothing worth preserving.",
  ].join("\n");
}
