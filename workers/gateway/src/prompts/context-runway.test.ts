import { describe, expect, it } from "vitest";
import { formatContextRunwayAlertMessage } from "./context-runway";

describe("context runway prompt", () => {
  it("keeps model-facing preservation guidance in the prompt module", () => {
    expect(formatContextRunwayAlertMessage({
      handover: true,
      remainingInputTokens: 12_345,
      runwayBeforeBoundaryTokens: 2_345,
      policy: {
        overflow: "auto-compact",
        compactAtPressure: 0.9,
        compactToPressure: 0.4,
        updatedAt: 0,
      },
    })).toContain("proc compact --summary");
  });
});
