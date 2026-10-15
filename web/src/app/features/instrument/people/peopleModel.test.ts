import { describe, expect, it } from "vitest";
import type { PublicProfile } from "@humansandmachines/gsv/protocol";
import { approachSendIntent, emptyApproachDraft, profileAddress as address, profileAddressLabel as label } from "./peopleModel";

const deployment = { primaryDomain: "fleet.example", legacyDomains: ["old.example"] };
const profileAddress = (value: string) => address(value, deployment);
const profileAddressLabel = (value: string) => label(value, deployment);

describe("person addresses", () => {
  it("opens managed handles with or without @", () => {
    for (const value of ["esteve", "@esteve", " @Esteve "]) expect(profileAddress(value)).toBe("https://esteve.fleet.example/profile");
    expect(profileAddress("a")).toBe("https://a.fleet.example/profile");
    expect(profileAddress("alex-river")).toBe("https://alex-river.fleet.example/profile");
  });

  it("keeps explicit federated hosts, ports and profile paths", () => {
    expect(profileAddress("person.example")).toBe("https://person.example/");
    expect(profileAddress("https://person.example/@person")).toBe("https://person.example/@person");
    expect(profileAddress("http://localhost:8787/profile")).toBe("http://localhost:8787/profile");
    expect(profileAddress("esteve.fleet.example/profile")).toBe("https://esteve.fleet.example/profile");
  });

  it("rejects names, malformed handles, credentials and non-web schemes", () => {
    for (const value of ["", "@", "Alex River", "-alex", "alex-", "alex_", "a".repeat(64), "https://user:pass@person.example", "ftp://person.example", "javascript:alert(1)"]) {
      expect(profileAddress(value)).toBeNull();
    }
  });

  it("shortens only exact managed origins", () => {
    expect(profileAddressLabel("https://esteve.fleet.example")).toBe("@esteve");
    expect(profileAddressLabel("https://esteve.old.example")).toBe("@esteve");
    expect(address("esteve", { legacyDomains: [] })).toBeNull();
    for (const host of ["fleet.example", "person.example", "esteve.fleet.example.evil.example", "person.esteve.fleet.example", "esteve.fleet.example:8787"]) {
      expect(profileAddressLabel(`https://${host}`)).toBe(host);
    }
  });
});

const profile: PublicProfile = {
  version: 2, domain: "gsv-federation/2/profile", actor: { shipId: "ship:one", subjectId: "person:one" },
  publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" }, origin: "https://person.example", url: "https://person.example/@person",
  alias: "person", displayName: "Person", about: "", contactPolicy: "requests", representation: "human",
  revision: 1, publishedAtMs: 1, signature: "fixture",
};

describe("first-message approval", () => {
  it("retains the exact send identity after a lost response or refreshing the same profile", () => {
    const draft = { ...emptyApproachDraft(profile.url), profile, displayName: " My chosen name ", text: " Hello ", shipHandlesMessages: false };
    const intent = approachSendIntent(draft);
    expect(intent.displayName).toBe("My chosen name");
    expect(approachSendIntent({ ...draft, profile: { ...profile }, intent })).toBe(intent);
    expect(emptyApproachDraft(profile.url).displayName).toBeNull();
    expect(emptyApproachDraft(profile.url).shipHandlesMessages).toBeNull();
    expect(() => approachSendIntent({ ...draft, shipHandlesMessages: null })).toThrow("Choose who");
  });

  it("does not reuse approval after the recipient, published revision, name or message changes", () => {
    const draft = { ...emptyApproachDraft(profile.url), profile, displayName: "My name", text: "Hello", shipHandlesMessages: false };
    const intent = approachSendIntent(draft);
    for (const change of [
      { text: "Different message" }, { displayName: "A different name" },
      { shipHandlesMessages: true },
      { profile: { ...profile, revision: 2 } },
      { profile: { ...profile, actor: { ...profile.actor, subjectId: "person:other" } } },
    ]) expect(approachSendIntent({ ...draft, intent, ...change }).idempotencyKey).not.toBe(intent.idempotencyKey);
    expect(() => approachSendIntent(emptyApproachDraft(profile.url))).toThrow("Open a profile");
  });
});
