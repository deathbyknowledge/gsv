import { describe, expect, it, vi } from "vitest";
import type { ContactRequestRecord, WorkRecord } from "@humansandmachines/gsv/protocol";
import { collectNodes, collectText } from "../../../testing/testHarness";
import { WorkRequestRow } from "./WorkRequestRow";

const work: WorkRecord = {
  offer: { reference: { actor: { shipId: "ship:requester", subjectId: "subject:requester" }, id: "request:one" }, kind: "task", title: "Review", createdAtMs: 1 },
  requester: [{ id: "operation:stop", revision: 1, action: "withdraw", observedPeerRevision: 0 }],
  performer: [{ id: "operation:accept", revision: 1, action: "accept", observedPeerRevision: 0 }],
};
const request: ContactRequestRecord = { id: "request:one", contactId: "contact:one", contactGeneration: "generation:one", direction: "incoming", kind: "task", title: "Review", state: "accepted", revision: 3, createdAtMs: 1, updatedAtMs: 2, work, exchange: { state: "acknowledged" } };

describe("work request decisions", () => {
  it("distinguishes asking to stop from confirmation, and offers only the performer's remaining choices", () => {
    const onAction = vi.fn();
    const tree = WorkRequestRow({ request, work, editable: true, busy: false, onAction });
    const text = collectText(tree);
    expect(text).toContain("Stop requested · awaiting confirmation");
    expect(text).toContain("Their statements");
    const buttons = collectNodes(tree).filter((node) => node.type === "button");
    expect(buttons.map((node) => collectText(node))).toEqual(["report result", "confirm cancellation"]);
    buttons[1].props.onClick?.();
    expect(onAction).toHaveBeenCalledWith("cancel");
  });

  it("keeps a disputed result visible and prevents read-only callers from changing it", () => {
    const completed: WorkRecord = { ...work,
      requester: [...work.requester, { id: "operation:dispute", revision: 2, action: "dispute", observedPeerRevision: 2, note: "Please review the last section" }],
      performer: [...work.performer, { id: "operation:complete", revision: 2, action: "complete", observedPeerRevision: 0, note: "First review delivered" }],
    };
    const tree = WorkRequestRow({ request: { ...request, direction: "outgoing", state: "completed" }, work: completed, editable: false, busy: false, onAction: vi.fn() });
    expect(collectText(tree)).toContain("Result reported");
    expect(collectText(tree)).toContain("The requester has disputed");
    expect(collectText(tree)).toContain("First review delivered");
    const buttons = collectNodes(tree).filter((node) => node.type === "button");
    expect(buttons.map((node) => collectText(node))).toEqual(["acknowledge result"]);
    expect(buttons[0].props.disabled).toBe(true);
  });
});
