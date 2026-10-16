import { describe, expect, it } from "vitest";
import type { ResponsibilityRecord } from "@humansandmachines/gsv/protocol";
import { responsibilityGroups } from "./responsibilityModel";

function record(id: string, patch: Partial<ResponsibilityRecord> = {}): ResponsibilityRecord {
  return { id, title: id, ownerUid: 1000, source: { kind: "account", uid: 1000, username: "owner" },
    assignee: { kind: "ship" }, state: "open", priority: "normal", revision: 1, createdAtMs: 1, updatedAtMs: 1, ...patch };
}

describe("responsibility hierarchy", () => {
  it("puts blockers and active promises first without flattening their steps", () => {
    const groups = responsibilityGroups([
      record("later", { dueAtMs: 20 }), record("parent", { state: "active" }),
      record("step", { parentId: "parent", blocker: "Needs a decision", state: "waiting" }),
      record("blocked", { state: "waiting", blocker: "Reply needed" }), record("sooner", { dueAtMs: 10 }),
    ]);
    expect(groups.roots.map((item) => item.id)).toEqual(["blocked", "parent", "sooner", "later"]);
    expect(groups.children("parent").map((item) => item.id)).toEqual(["step"]);
  });

  it("keeps a child visible when its parent is outside the loaded page or current filter", () => {
    expect(responsibilityGroups([record("step", { parentId: "archived-parent" })]).roots.map((item) => item.id)).toEqual(["step"]);
  });
});
