import type { ProcHistoryEvent } from "@humansandmachines/gsv/protocol";
import { describe, expect, it, vi } from "vitest";
import { collectNodes, collectText } from "../../../testing/testHarness";
import { FeedbackNote, NoteMoment, zenFailure, zenNotice } from "./ZenNotes";
import type { Moment } from "./zenModel";

const RAW = "Generation failed: Model generation timed out after 180000ms";
const timedOut: ProcHistoryEvent = {
  kind: "generation.failed",
  payload: { reason: "generation.error", error: "Model generation timed out after 180000ms" },
  severity: "error",
  audience: "both",
};

function note(event: ProcHistoryEvent | undefined, text: string): Moment {
  return { id: "message:9", role: "note", event, text, streaming: false, thinking: false, runId: "r", timestamp: 1, activities: [], narration: "" };
}

function render(moment: Moment, open: boolean) {
  const onToggle = vi.fn();
  const tree = NoteMoment({ moment, open, focus: false, index: 0, phase: "settled", onToggle });
  return { tree, onToggle, nodes: collectNodes(tree) };
}

describe("error notes in the conversation", () => {
  it("leads with a plain summary and the next step, folding the raw failure", () => {
    const { tree, nodes, onToggle } = render(note(timedOut, RAW), false);
    const text = collectText(tree);
    expect(text).toContain("The model took too long to respond.");
    expect(text).toContain("Try again. If it keeps happening, wait a few minutes or switch to another model.");
    expect(text).not.toContain("180000ms");

    const toggle = nodes.find((node) => node.type === "button");
    expect(nodes.some((node) => node.props.class === "note-text")).toBe(false);
    expect(collectText(toggle?.props.children)).toContain("details");
    toggle?.props.onClick?.();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("shows the gateway's original text once opened", () => {
    const { tree, nodes } = render(note(timedOut, RAW), true);
    expect(nodes.find((node) => node.props.class === "note-text")?.props.children).toBe(RAW);
    expect(collectText(tree)).toContain("hide details");
  });

  it("keeps memory notes as their own first sentence", () => {
    const { tree } = render(note(undefined, "Older history was compacted. It covered the setup."), false);
    expect(collectText(tree)).toContain("Older history was compacted.");
    expect(collectText(tree)).not.toContain("details");
  });
});

describe("the status line", () => {
  it("renders a plain notice as text, not a control", () => {
    const nodes = collectNodes(FeedbackNote({ note: zenNotice("Each attachment must be 25 MiB or smaller.") }));
    expect(nodes.some((node) => node.type === "button" || node.type === "summary")).toBe(false);
  });

  it("puts a failure's summary and action first and its raw text behind details", () => {
    const tree = FeedbackNote({ note: zenFailure("rpc proc.spawn failed T=18488", { summary: "Could not reach your ship.", action: "Check your connection, then reload the page." }) });
    const nodes = collectNodes(tree);
    expect(collectText(nodes.find((node) => node.props.class === "is-err"))).toBe("Could not reach your ship.");
    expect(collectText(nodes.find((node) => node.props.class === "action"))).toBe("Check your connection, then reload the page.");
    const details = nodes.find((node) => node.type === "details");
    expect(collectText(details?.props.children)).toBe("details rpc proc.spawn failed T=18488");
    expect(nodes.some((node) => node.type === "button")).toBe(false);
  });

  it("omits the fold when there is nothing beyond the summary", () => {
    const nodes = collectNodes(FeedbackNote({ note: zenFailure("", { summary: "The decision did not go through.", action: "Try again in a moment." }) }));
    expect(nodes.some((node) => node.type === "details")).toBe(false);
  });
});
