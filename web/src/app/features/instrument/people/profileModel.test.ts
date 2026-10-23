import { describe, expect, it } from "vitest";
import type { ProfileFields, ProfileState } from "@humansandmachines/gsv/protocol";
import { profileSubmission, profileUnpublished, profileVisibility } from "./profileModel";

const fields: ProfileFields = { displayName: "ada", about: "Hello", contactPolicy: "requests" };
const url = "https://ada.ship.example/profile";
const live = (contactPolicy: ProfileFields["contactPolicy"] = "requests") => ({ url, cid: "bafyreiprofile", revision: 2, contactPolicy });
const state = (overrides: Partial<ProfileState> = {}): ProfileState => ({ revision: 2, url, draft: fields, handle: "ada", ...overrides });
const picture = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: "image/png" as const };

describe("profile submission", () => {
  it("publishes a private profile, naming the action publish", () => {
    expect(profileSubmission(state(), null)).toEqual({ action: "publish", ready: true, revision: 2, fields: null, picture: null });
    expect(profileSubmission(state(), { revision: 2, fields: { ...fields, about: "Edited" } }))
      .toMatchObject({ action: "publish", ready: true, fields: { about: "Edited" } });
  });

  it("saves edits to a public profile and has nothing to save without them", () => {
    expect(profileSubmission(state({ published: live() }), null)).toMatchObject({ action: "save", ready: false });
    expect(profileSubmission(state({ published: live() }), { revision: 2, fields: { ...fields, about: "Edited" } }))
      .toMatchObject({ action: "save", ready: true, revision: 2, fields: { about: "Edited" } });
  });

  it("publishes saved unpublished changes without further edits", () => {
    expect(profileSubmission(state({ revision: 3, published: { ...live(), revision: 2 } }), null))
      .toEqual({ action: "save", ready: true, revision: 3, fields: null, picture: null });
  });

  it("saves a new or removed picture on its own, without committing unchanged fields", () => {
    expect(profileSubmission(state({ published: live() }), null, { revision: 2, picture }))
      .toEqual({ action: "save", ready: true, revision: 2, fields: null, picture: { revision: 2, picture } });
    expect(profileSubmission(state({ published: live() }), null, { revision: 2, picture: null })).toMatchObject({ ready: true, picture: { picture: null } });
    expect(profileSubmission(state({ published: live() }), { revision: 2, fields: { ...fields, about: "Edited" } }, { revision: 2, picture }))
      .toMatchObject({ ready: true, fields: { about: "Edited" }, picture: { picture } });
  });

  it("saves the recorded handle over an older name, even without other edits", () => {
    const older = state({ draft: { ...fields, displayName: "Owner Person" }, published: live() });
    expect(profileSubmission(older, null)).toMatchObject({ action: "save", ready: true, fields: { displayName: "ada" } });
    expect(profileSubmission(older, { revision: 2, fields: { ...older.draft, about: "Edited" } }).fields).toMatchObject({ displayName: "ada", about: "Edited" });
  });

  it("stores a closed profile as invitation-only, which the Kernel enforces the same way", () => {
    expect(profileSubmission(state(), { revision: 2, fields: { ...fields, contactPolicy: "closed" } }).fields).toMatchObject({ contactPolicy: "invitation" });
  });

  it("keeps the stored name when no handle is recorded", () => {
    const unnamed = state({ handle: undefined, draft: { ...fields, displayName: "Owner Person" }, published: live() });
    expect(profileSubmission(unnamed, null)).toMatchObject({ action: "save", ready: false });
    expect(profileSubmission(unnamed, { revision: 2, fields: { ...unnamed.draft, about: "Edited" } }).fields).toMatchObject({ displayName: "Owner Person" });
  });

  it("refuses an edit made against an older revision", () => {
    expect(profileSubmission(state({ revision: 3 }), { revision: 2, fields })).toMatchObject({ ready: false });
    expect(profileSubmission(state({ revision: 3 }), null, { revision: 2, picture })).toMatchObject({ ready: false });
  });
});

describe("profile visibility", () => {
  it("describes what visitors can do on the live page, not unpublished changes", () => {
    expect(profileVisibility(state())).toBe("private");
    expect(profileVisibility(state({ published: live("requests") }))).toBe("requests");
    expect(profileVisibility(state({ revision: 3, draft: { ...fields, contactPolicy: "invitation" }, published: live("requests") }))).toBe("requests");
    expect(profileVisibility(state({ revision: 3, draft: fields, published: live("invitation") }))).toBe("invitation");
    expect(profileVisibility(state({ published: live("closed") }))).toBe("invitation");
  });
});

describe("unpublished changes", () => {
  it("names saved changes the live page doesn't show yet, which a private profile can't have", () => {
    expect(profileUnpublished(state({ revision: 3, published: { ...live(), revision: 2 } }))).toBe(true);
    expect(profileUnpublished(state({ published: live() }))).toBe(false);
    expect(profileUnpublished(state({ revision: 3 }))).toBe(false);
  });
});
