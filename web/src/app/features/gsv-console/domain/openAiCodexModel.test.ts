import { describe, expect, it } from "vitest";
import {
  MODEL_TRANSPORT_TARGET_KEY,
  firstAvailableFetchTargetId,
  withOpenAiCodexTransportTargetDefault,
} from "./openAiCodexModel";

describe("OpenAI Codex model target defaults", () => {
  const codexDrafts = {
    "config/ai/provider": "openai-codex",
    "config/ai/transport_target": "",
  };

  it("applies a machine that becomes available after the provider was selected", () => {
    const beforeTargetsLoad = withOpenAiCodexTransportTargetDefault(
      codexDrafts,
      firstAvailableFetchTargetId([]),
      false,
    );
    expect(beforeTargetsLoad).toBe(codexDrafts);

    const afterTargetsLoad = withOpenAiCodexTransportTargetDefault(
      beforeTargetsLoad,
      firstAvailableFetchTargetId([
        { id: "offline", label: "A", online: false, implements: ["net.fetch"] },
        { id: "machine-2", label: "B", online: true, implements: ["net.*"] },
      ]),
      false,
    );

    expect(afterTargetsLoad[MODEL_TRANSPORT_TARGET_KEY]).toBe("machine-2");
  });

  it("preserves an explicit target selection", () => {
    expect(withOpenAiCodexTransportTargetDefault(codexDrafts, "machine-1", true)).toBe(codexDrafts);
  });

  it("preserves an existing machine target", () => {
    const drafts = {
      ...codexDrafts,
      [MODEL_TRANSPORT_TARGET_KEY]: "machine-stored",
    };

    expect(withOpenAiCodexTransportTargetDefault(drafts, "machine-1", false)).toBe(drafts);
  });
});
