import { describe, expect, it } from "vitest";
import type { PublicProfile } from "@humansandmachines/gsv/protocol";
import { approachSendIntent, emptyApproachDraft } from "./peopleModel";

const profile: PublicProfile = {
  version: 2, domain: "gsv-federation/2/profile", actor: { shipId: "ship:one", subjectId: "person:one" },
  publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" }, origin: "https://person.example", url: "https://person.example/@person",
  alias: "person", displayName: "Person", about: "", contactPolicy: "requests", representation: "human",
  revision: 1, publishedAtMs: 1, signature: "fixture",
};

describe("first-message approval", () => {
  it("retains the exact send identity after a lost response or refreshing the same profile", () => {
    const draft = { ...emptyApproachDraft(profile.url), profile, displayName: " My chosen name ", text: " Hello " };
    const intent = approachSendIntent(draft);
    expect(intent.displayName).toBe("My chosen name");
    expect(approachSendIntent({ ...draft, profile: { ...profile }, intent })).toBe(intent);
    expect(emptyApproachDraft(profile.url).displayName).toBe("");
  });

  it("does not reuse approval after the recipient, published revision, name or message changes", () => {
    const draft = { ...emptyApproachDraft(profile.url), profile, displayName: "My name", text: "Hello" };
    const intent = approachSendIntent(draft);
    for (const change of [
      { text: "Different message" }, { displayName: "A different name" },
      { profile: { ...profile, revision: 2 } },
      { profile: { ...profile, actor: { ...profile.actor, subjectId: "person:other" } } },
    ]) expect(approachSendIntent({ ...draft, intent, ...change }).idempotencyKey).not.toBe(intent.idempotencyKey);
    expect(() => approachSendIntent(emptyApproachDraft(profile.url))).toThrow("Open a profile");
  });
});
