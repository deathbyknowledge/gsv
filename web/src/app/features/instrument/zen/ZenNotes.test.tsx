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

describe("owner notices", () => {
  const notice = (payload: Partial<Extract<NonNullable<Moment["event"]>, { kind: "owner.notified" }>["payload"]>, link: { kind: "contact"; contactId: string } | { kind: "contact.request"; requestId: string }): Moment => ({
    id: "message:7", role: "note", text: "", streaming: false, thinking: false, runId: null, timestamp: 1, activities: [], narration: "",
    event: { kind: "owner.notified", severity: "info", audience: "both", link, payload: {
      noticeId: "notice", topic: "contact.message", channel: "WhatsApp", from: "Ada", contactId: "contact:ada", sentAtMs: 1, ...payload } },
  });
  const card = (moment: Moment) => rendered(() => NoteMoment({ moment, open: false, focus: false, index: 0, phase: "settled", onToggle: () => {} }));

  it("shows who wrote, where the owner heard, and what they said, without folding it away", async () => {
    const tree = await card(notice({ handle: "ada.ship.space", preview: "are we still on for tomorrow?", messages: 1 }, { kind: "contact", contactId: "contact:ada" }));
    const text = collectText(tree);
    for (const part of ["Ada", "@ada.ship.space", "via WhatsApp", "are we still on for tomorrow?"]) expect(text).toContain(part);
    expect(text).not.toContain("Notified you on");
    expect(collectNodes(tree).some((node) => node.type === "button")).toBe(false);
    const anchor = collectNodes(tree).find((node) => node.props?.href !== undefined);
    expect(anchor?.props.href).toBe("/people?contact=contact%3Aada");
    expect(collectText(anchor?.props.children)).toBe("Open in People");
  });

  it("counts several messages and names an attachment without text", async () => {
    const text = collectText(await card(notice({ messages: 3 }, { kind: "contact", contactId: "contact:ada" })));
    expect(text).toContain("3 messages");
    expect(text).toContain("Sent an attachment");
  });

  it("opens a message request where the owner decides it", async () => {
    const tree = await card(notice({ topic: "contact.request", from: "Bo" }, { kind: "contact.request", requestId: "approach:bo" }));
    expect(collectText(tree)).toContain("Wants to message you.");
    const anchor = collectNodes(tree).find((node) => node.props?.href !== undefined);
    expect(anchor?.props.href).toBe("/people?view=requests&request=approach%3Abo");
    expect(collectText(anchor?.props.children)).toBe("Review the request");
  });
});

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
