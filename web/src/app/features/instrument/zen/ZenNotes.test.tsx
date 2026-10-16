import { describe, expect, it, vi } from "vitest";
import { collectNodes, collectText } from "../../../testing/testHarness";
import { FeedbackNote, NoteMoment, zenFailure } from "./ZenNotes";
import type { Moment } from "./zenModel";

describe("error details", () => {
  it("hides the original failure until the reader opens it", () => {
    const text = "Generation failed: Model generation timed out after 180000ms";
    const moment: Moment = {
      id: "message:9", role: "note", text, streaming: false, thinking: false, runId: "r", timestamp: 1, activities: [], narration: "",
      event: { kind: "generation.failed", payload: { reason: "generation.error", error: text }, severity: "error", audience: "both" },
    };
    const onToggle = vi.fn();
    const props = { moment, open: false, focus: false, index: 0, phase: "settled" as const, onToggle };
    const tree = NoteMoment(props);
    expect(collectText(tree)).not.toContain(text);
    collectNodes(tree).find((node) => node.type === "button")?.props.onClick?.();
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(collectText(NoteMoment({ ...props, open: true }))).toContain(text);
  });

  it("keeps a failed operation's original diagnostic available in collapsed details", () => {
    const detail = "rpc proc.spawn failed T=18488";
    const context = { summary: "Could not reach your ship.", action: "Check your connection, then reload the page." };
    const tree = FeedbackNote({ note: zenFailure(detail, context) });
    const details = collectNodes(tree).find((node) => node.type === "details");
    expect(collectText(tree)).toContain(context.summary);
    expect(collectText(tree)).toContain(context.action);
    expect(collectText(details?.props.children)).toContain(detail);
    expect(details?.props).not.toHaveProperty("open", true);
  });
});
