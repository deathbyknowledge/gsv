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
  it("keeps the signup attribution through a save and reload", () => {
    const attribution = { placement: "hero", example: "tickets", utmSource: "facebook", utmCampaign: "launch" };
    const stored = { ...saved, value: { ...saved.value, attribution } };
    expect(welcomeSnapshotSchema.parse(stored).value?.attribution).toEqual(attribution);
    const campaign = { ...saved, value: { ...saved.value, attribution: { utmSource: "facebook" } } };
    expect(welcomeSnapshotSchema.parse(campaign).value?.attribution).toEqual({ utmSource: "facebook" });
    const cleared = { ...saved, value: { ...saved.value, attribution: null } };
    expect(welcomeSnapshotSchema.parse(cleared).value?.attribution).toBeNull();
  });

  it("still reads a record saved before attribution existed", () => {
    expect(welcomeSnapshotSchema.parse(saved).value?.attribution).toBeUndefined();
  });
});
