import { describe, expect, it } from "vitest";
import { formatContextRunwayAlertMessage } from "./context-runway";

describe("context runway prompt", () => {
  it("keeps model-facing preservation guidance in the prompt module", () => {
    expect(formatContextRunwayAlertMessage({
      remainingInputTokens: 12_345,
      runwayBeforeBoundaryTokens: 2_345,
      policy: {
        overflow: "auto-compact",
        compactAtPressure: 0.9,
        compactToPressure: 0.4,
        updatedAt: 0,
      },
    })).toBe([
      "Context runway is getting low.",
      "",
      "About 12,345 input tokens remain before the model's reserved output budget.",
      "Preserve anything that should survive compaction now: use the Personal wiki for durable knowledge, standing context only for explicit stable facts or preferences, and the responsibility ledger for unresolved commitments.",
      "Do not promote transient details merely because the context window is filling.",
      "About 2,345 tokens of that runway remain before GSV automatically compacts older Process history at the configured 90% safety boundary.",
      "Continue normally if there is nothing worth preserving.",
    ].join("\n"));
  });
});
