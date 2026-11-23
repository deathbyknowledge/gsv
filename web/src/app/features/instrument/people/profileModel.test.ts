import { describe, expect, it } from "vitest";
import type { ProfileFields, ProfileState, PublicTakedown } from "@humansandmachines/gsv/protocol";
import { profileSubmission, profileTakenDown, shipTakenDown, takedownSubject } from "./profileModel";

const fields: ProfileFields = { displayName: "ada", about: "Hello", contactPolicy: "requests" };
const url = "https://ada.ship.example";
const state = (overrides: Partial<ProfileState> = {}): ProfileState => ({ revision: 2, url, fields, cid: "bafyreiprofile", handle: "ada", ...overrides });
const picture = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: "image/png" as const };

describe("profile submission", () => {
  it("publishes edits and has nothing to publish without them", () => {
    expect(profileSubmission(state(), null)).toEqual({ ready: false, revision: 2, fields: null, picture: null });
    expect(profileSubmission(state(), { revision: 2, fields: { ...fields, about: "Edited" } }))
      .toEqual({ ready: true, revision: 2, fields: { ...fields, about: "Edited" }, picture: null });
  });

  it("has nothing to publish for the starting profile until it is edited", () => {
    const starting = state({ revision: 0, cid: undefined, fields: { displayName: "ada", about: "", contactPolicy: "requests" } });
    expect(profileSubmission(starting, null)).toMatchObject({ ready: false });
    expect(profileSubmission(starting, { revision: 0, fields: { ...starting.fields, about: "Hi" } })).toMatchObject({ ready: true, revision: 0 });
  });

  it("publishes a new or removed picture on its own, without republishing unchanged fields", () => {
    expect(profileSubmission(state(), null, { revision: 2, picture }))
      .toEqual({ ready: true, revision: 2, fields: null, picture: { revision: 2, picture } });
    expect(profileSubmission(state(), null, { revision: 2, picture: null })).toMatchObject({ ready: true, picture: { picture: null } });
    expect(profileSubmission(state(), { revision: 2, fields: { ...fields, about: "Edited" } }, { revision: 2, picture }))
      .toMatchObject({ ready: true, fields: { about: "Edited" }, picture: { picture } });
  });

  it("publishes the recorded handle over an older name, even without other edits", () => {
    const older = state({ fields: { ...fields, displayName: "Owner Person" } });
    expect(profileSubmission(older, null)).toMatchObject({ ready: true, fields: { displayName: "ada" } });
    expect(profileSubmission(older, { revision: 2, fields: { ...older.fields, about: "Edited" } }).fields).toMatchObject({ displayName: "ada", about: "Edited" });
  });

  it("publishes a profile closed to requests as the editor shows it", () => {
    expect(profileSubmission(state(), { revision: 2, fields: { ...fields, contactPolicy: "closed" } }).fields).toMatchObject({ contactPolicy: "closed" });
  });

  it("keeps the stored name when no handle is recorded", () => {
    const unnamed = state({ handle: undefined, fields: { ...fields, displayName: "Owner Person" } });
    expect(profileSubmission(unnamed, null)).toMatchObject({ ready: false });
    expect(profileSubmission(unnamed, { revision: 2, fields: { ...unnamed.fields, about: "Edited" } }).fields).toMatchObject({ displayName: "Owner Person" });
  });

  it("refuses an edit made against an older revision", () => {
    expect(profileSubmission(state({ revision: 3 }), { revision: 2, fields })).toMatchObject({ ready: false });
    expect(profileSubmission(state({ revision: 3 }), null, { revision: 2, picture })).toMatchObject({ ready: false });
  });
});

describe("what the operator took down", () => {
  const did = "did:plc:adaaaaaaaaaaaaaaaaaaaaaa";
  const takedown = (subject: PublicTakedown["subject"]): PublicTakedown => ({ subject, ref: "audit_1", reason: "Spam", at: 1 });
  const account = takedown({ $type: "com.atproto.admin.defs#repoRef", did });
  const profile = takedown({ $type: "com.atproto.repo.strongRef", uri: `at://${did}/space.ship.profile/self`, cid: "bafyreiprofile" });
  const note = takedown({ $type: "com.atproto.repo.strongRef", uri: `at://${did}/space.ship.note/first`, cid: "bafyreinote" });
  const file = takedown({ $type: "com.atproto.admin.defs#repoBlobRef", did, cid: "bafkreipicture" });
  const bluesky = takedown({ $type: "com.atproto.repo.strongRef", uri: `at://${did}/app.bsky.actor.profile/self`, cid: "bafyreibluesky" });

  it("names it as the person knows it", () => {
    expect(takedownSubject(account)).toEqual({ kind: "account" });
    expect(takedownSubject(profile)).toEqual({ kind: "profile" });
    expect(takedownSubject(bluesky)).toEqual({ kind: "bluesky" });
    expect(takedownSubject(note)).toEqual({ kind: "record", uri: `at://${did}/space.ship.note/first` });
    expect(takedownSubject(file, "bafkreipicture")).toEqual({ kind: "picture" });
    expect(takedownSubject(file, "bafkreiother")).toEqual({ kind: "file" });
    expect(takedownSubject(file)).toEqual({ kind: "file" });
  });

  it("counts the profile as down with the whole Ship or on its own, but not for its picture or another record", () => {
    expect(profileTakenDown([])).toBe(false);
    expect(profileTakenDown([file, note])).toBe(false);
    // Bluesky's copy being down leaves the profile itself up for other Ships and its page.
    expect(profileTakenDown([bluesky])).toBe(false);
    expect(profileTakenDown([account])).toBe(true);
    expect(profileTakenDown([note, profile])).toBe(true);
  });

  it("counts the whole Ship as down only for its account", () => {
    expect(shipTakenDown([profile, note, file])).toBe(false);
    expect(shipTakenDown([note, account])).toBe(true);
  });
});
