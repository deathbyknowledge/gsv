import type { ComponentChildren } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import type { ChatErrorContext } from "../../../services/chat/domain/errorPresentation";
import { FeedbackNote, NoteMoment, zenFailure } from "./ZenNotes";
import type { Moment } from "./zenModel";

let root: ReturnType<typeof createTestRoot> | undefined;
afterEach(async () => { await root?.unmount(); root = undefined; vi.unstubAllGlobals(); });

/** Renders a note inside a test root, since it reads the interface language, and returns what it rendered. */
async function rendered(render: () => ComponentChildren): Promise<ComponentChildren> {
  let tree: ComponentChildren;
  function Harness() { tree = render(); return null; }
  vi.stubGlobal("document", {});
  root ??= createTestRoot("Zen notes");
  await root.render(<Harness />);
  return tree;
}

describe("error details", () => {
  it("hides the original failure until the reader opens it", async () => {
    const text = "Generation failed: Model generation timed out after 180000ms";
    const moment: Moment = {
      id: "message:9", role: "note", text, streaming: false, thinking: false, runId: "r", timestamp: 1, activities: [], narration: "",
      event: { kind: "generation.failed", payload: { reason: "generation.error", error: "Model generation timed out after 180000ms" }, severity: "error", audience: "both" },
    };
    const onToggle = vi.fn();
    const props = { moment, open: false, focus: false, index: 0, phase: "settled" as const, onToggle };
    const tree = await rendered(() => NoteMoment(props));
    expect(collectText(tree)).not.toContain(text);
    collectNodes(tree).find((node) => node.type === "button")?.props.onClick?.();
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(collectText(await rendered(() => NoteMoment({ ...props, open: true })))).toContain(text);
  });

  it("keeps a failed operation's original diagnostic available in collapsed details", async () => {
    const detail = "rpc proc.spawn failed T=18488";
    const context: ChatErrorContext = { summary: "chat.error.shipUnreachable.summary", action: "chat.error.shipUnreachable.action" };
    const tree = await rendered(() => FeedbackNote({ note: zenFailure(detail, context) }));
    const details = collectNodes(tree).find((node) => node.type === "details");
    expect(collectText(tree)).toContain("Could not reach your Ship.");
    expect(collectText(tree)).toContain("Check your connection, then reload the page.");
    expect(collectText(details?.props.children)).toContain(detail);
    expect(details?.props).not.toHaveProperty("open", true);
  });
});
