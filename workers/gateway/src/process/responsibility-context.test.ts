import type {
  ResponsibilityRecord,
  ResponsibilityTransition,
} from "@humansandmachines/gsv/protocol";
import { describe, expect, it } from "vitest";
import {
  formatResponsibilityBaseline,
  formatResponsibilityTransitionEvent,
} from "./responsibility-context";

const responsibility: ResponsibilityRecord = {
  id: "r12y:00000000-0000-4000-8000-000000000001",
  ownerUid: 1000,
  title: "Inspect the failed deployment",
  source: { kind: "process", processId: "proc:ship" },
  assignee: { kind: "ship" },
  state: "open",
  priority: "normal",
  revision: 1,
  createdAtMs: 1,
  updatedAtMs: 1,
};

describe("responsibility context formatting", () => {
  it("renders the immutable baseline", () => {
    expect(formatResponsibilityBaseline({
      responsibilities: [responsibility],
      count: 1,
      revision: 1,
    })).toBe([
      "Ledger revision 1.",
      "",
      "- `r12y:00000000-0000-4000-8000-000000000001` [open, normal, ship]: \"Inspect the failed deployment\"",
    ].join("\n"));
  });

  it("renders ordered transitions with an optional specialized creation", () => {
    const transition: ResponsibilityTransition = {
      revision: 2,
      responsibilityId: responsibility.id,
      kind: "updated",
      beforeState: "open",
      afterState: "active",
      changedFields: ["state", "assignee"],
      actor: { kind: "process", processId: "proc:ship" },
      record: {
        ...responsibility,
        state: "active",
        assignee: { kind: "process", processId: "proc:worker" },
        revision: 2,
        updatedAtMs: 2,
      },
      createdAtMs: 2,
    };

    expect(formatResponsibilityTransitionEvent(transition)).toContain(
      "State: open -> active.",
    );
    expect(formatResponsibilityTransitionEvent({
      ...transition,
      kind: "created",
    }, () => "specialized event")).toBe("specialized event");
  });
});
