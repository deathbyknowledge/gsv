import { describe, expect, it } from "vitest";
import { welcomeSnapshotSchema } from "./storage";

const saved = {
  revision: "r1",
  value: {
    origin: "https://accounts.example", flow: "create", sessionSecret: null, challenge: null,
    operationId: "op-1", handle: "newbie", contactInvite: null,
  },
};

describe("welcome snapshot storage", () => {
  it("keeps the website attribution through a save and reload", () => {
    const stored = { ...saved, value: { ...saved.value, attribution: { placement: "hero", example: "tickets" } } };
    expect(welcomeSnapshotSchema.parse(stored).value?.attribution).toEqual({ placement: "hero", example: "tickets" });
    const cleared = { ...saved, value: { ...saved.value, attribution: null } };
    expect(welcomeSnapshotSchema.parse(cleared).value?.attribution).toBeNull();
  });

  it("still reads a record saved before attribution existed", () => {
    expect(welcomeSnapshotSchema.parse(saved).value?.attribution).toBeUndefined();
  });
});
