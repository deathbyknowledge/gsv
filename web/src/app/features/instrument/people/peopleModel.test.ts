import { describe, expect, it } from "vitest";
import type { ApproachSummary, PublicProfile } from "@humansandmachines/gsv/protocol";
import { approachSendIntent, approachStatus, contactProfileUrl, emptyApproachDraft, handleLabel as label, profileAddress as address, requestMayReport } from "./peopleModel";

const deployment = { primaryDomain: "fleet.example", legacyDomains: ["old.example"] };
const profileAddress = (value: string) => address(value, deployment);
const handleLabel = (value: string) => label(value, deployment);

describe("person addresses", () => {
  it("opens managed handles with or without @", () => {
    for (const value of ["esteve", "@esteve", " @Esteve "]) expect(profileAddress(value)).toBe("https://esteve.fleet.example/profile");
    expect(profileAddress("a")).toBe("https://a.fleet.example/profile");
    expect(profileAddress("alex-river")).toBe("https://alex-river.fleet.example/profile");
  });

  it("keeps explicit federated hosts, ports and profile paths", () => {
    expect(profileAddress("person.example")).toBe("https://person.example/profile");
    expect(profileAddress("@person.example")).toBe("https://person.example/profile");
    expect(profileAddress("https://person.example/@person")).toBe("https://person.example/@person");
    expect(profileAddress("http://localhost:8787/profile")).toBe("http://localhost:8787/profile");
    expect(profileAddress("esteve.fleet.example/profile")).toBe("https://esteve.fleet.example/profile");
  });

  it("rejects names, malformed handles, credentials and non-web schemes", () => {
    for (const value of ["", "@", "Alex River", "-alex", "alex-", "alex_", "a".repeat(64), "https://user:pass@person.example", "ftp://person.example", "javascript:alert(1)"]) {
      expect(profileAddress(value)).toBeNull();
    }
  });

  it("shortens only handles directly under a managed domain", () => {
    expect(handleLabel("esteve.fleet.example")).toBe("@esteve");
    expect(handleLabel("esteve.old.example")).toBe("@esteve");
    expect(address("esteve", { legacyDomains: [] })).toBeNull();
    for (const handle of ["fleet.example", "person.example", "esteve.fleet.example.evil.example", "person.esteve.fleet.example"]) {
      expect(handleLabel(handle)).toBe(handle);
    }
  });

  it("uses the most specific configured domain when profile domains overlap", () => {
    const nested = { primaryDomain: "example.com", legacyDomains: ["old.example.com", "fleet.old.example.com"] };
    expect(label("alex.old.example.com", nested)).toBe("@alex");
    expect(label("alex.fleet.old.example.com", nested)).toBe("@alex");
    expect(label("old.example.com", nested)).toBe("old.example.com");
    expect(label("team.alex.old.example.com", nested)).toBe("team.alex.old.example.com");
  });

  it("links to a contact's profile only through a handle that names them back", () => {
    expect(contactProfileUrl({ remoteHandle: "esteve.fleet.example" })).toBe("https://esteve.fleet.example/profile");
    expect(contactProfileUrl({})).toBeNull();
  });
});

const profile: PublicProfile = {
  did: "did:plc:personaaaaaaaaaaaaaaaaaa", handle: "person.example", cid: "bafyreiprofileone",
  displayName: "Person", about: "", contactPolicy: "requests", url: "https://person.example/profile",
};

describe("first-message approval", () => {
  it("retains the exact send identity after a lost response or refreshing the same profile", () => {
    const draft = { ...emptyApproachDraft(profile.url), profile, displayName: " My chosen name ", text: " Hello ", shipHandlesMessages: false };
    const intent = approachSendIntent(draft);
    expect(intent).toMatchObject({ did: profile.did, profileCid: profile.cid, displayName: "My chosen name", text: "Hello" });
    expect(approachSendIntent({ ...draft, profile: { ...profile }, intent })).toBe(intent);
    expect(emptyApproachDraft(profile.url).displayName).toBeNull();
    expect(emptyApproachDraft(profile.url).shipHandlesMessages).toBeNull();
    expect(() => approachSendIntent({ ...draft, shipHandlesMessages: null })).toThrow("Choose who");
  });

  it("does not reuse approval after the recipient, the profile they published, the name or the message changes", () => {
    const draft = { ...emptyApproachDraft(profile.url), profile, displayName: "My name", text: "Hello", shipHandlesMessages: false };
    const intent = approachSendIntent(draft);
    for (const change of [
      { text: "Different message" }, { displayName: "A different name" },
      { shipHandlesMessages: true },
      { profile: { ...profile, cid: "bafyreiprofiletwo" } },
      { profile: { ...profile, did: "did:plc:otheraaaaaaaaaaaaaaaaaaa" } },
    ]) expect(approachSendIntent({ ...draft, intent, ...change }).idempotencyKey).not.toBe(intent.idempotencyKey);
    expect(() => approachSendIntent(emptyApproachDraft(profile.url))).toThrow("Open a profile");
  });
});

describe("message request status", () => {
  const sent: ApproachSummary = {
    id: "approach:sent", direction: "outgoing", requestId: "request:sent", peerDid: profile.did, displayName: "Person",
    conversationId: "conv:sent", state: "pending", revision: 1, delivery: "failed", createdAtMs: 1, updatedAtMs: 1, expiresAtMs: 2,
  };
  const accepting: ApproachSummary = { ...sent, id: "approach:received", direction: "incoming", state: "accepting", delivery: "received", connection: "failed" };

  it("gives a taken-down Ship as the reason a request or an acceptance failed", () => {
    expect(approachStatus(sent, false)).toBe("people.status.deliveryFailed");
    expect(approachStatus(sent, true)).toBe("people.status.shipTakenDown");
    expect(approachStatus(accepting, false)).toBe("people.status.connectionFailed");
    expect(approachStatus(accepting, true)).toBe("people.status.shipTakenDown");
    expect(approachStatus({ ...sent, delivery: "received" }, true)).toBe("people.status.received");
  });

  it("offers a report on a stranger's request once its message arrived, until it's accepted or reported", () => {
    const received: ApproachSummary = { ...sent, direction: "incoming", delivery: "received", messageSequence: 1 };
    expect(requestMayReport(received)).toBe(true);
    expect(requestMayReport({ ...received, state: "declined" })).toBe(true);
    expect(requestMayReport({ ...received, messageSequence: undefined })).toBe(false);
    expect(requestMayReport({ ...received, state: "accepting" })).toBe(false);
    expect(requestMayReport({ ...received, state: "accepted" })).toBe(false);
    expect(requestMayReport({ ...received, reportedAtMs: 5 })).toBe(false);
    expect(requestMayReport({ ...sent, messageSequence: 1 })).toBe(false);
  });
});
