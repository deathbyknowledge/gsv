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
      "Context low: ~12,345 input tokens remain. Automatic compaction in ~2,345 tokens (90% boundary).",
      "",
      "Preserve durable knowledge in the Personal wiki, explicit stable facts or preferences in standing context, and unresolved commitments in the responsibility ledger.",
      "Don’t preserve transient details just because context is low. Continue normally if nothing needs preserving.",
    ].join("\n"));
  });
});
