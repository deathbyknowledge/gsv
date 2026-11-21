import assert from "node:assert/strict";
import { test } from "node:test";
import { contactInviteFrom, contactInviteUrl } from "../dist/protocol/contact-invite.js";

const presentation = { primaryDomain: "ship.space", legacyDomains: ["gsv.space"], signupUrl: "https://signup.ship.space/" };

test("an invite link names a hosted Ship by its handle on the operator's signup page", () => {
  assert.equal(contactInviteUrl("https://esteve.ship.space", presentation), "https://signup.ship.space/?invite=esteve");
  assert.equal(contactInviteUrl("https://esteve.gsv.space", presentation), "https://signup.ship.space/?invite=esteve");
  assert.equal(contactInviteUrl("https://ship.example.com", presentation), "https://signup.ship.space/?invite=ship.example.com");
  assert.equal(
    contactInviteUrl("https://esteve.ship.space", { ...presentation, signupUrl: "https://ship.space/owner/signup/?utm_source=people" }),
    "https://ship.space/owner/signup/?utm_source=people&invite=esteve",
  );
});

test("without operator signup an invite link is the Ship's public profile", () => {
  assert.equal(contactInviteUrl("https://ship.example.com", { legacyDomains: [] }), "https://ship.example.com");
});

test("an invite link names the inviter and the profile their request goes to", () => {
  assert.deepEqual(contactInviteFrom(" Esteve ", "ship.space"), { name: "@esteve", profile: "https://esteve.ship.space" });
  assert.deepEqual(contactInviteFrom("ship.example.com", "ship.space"), { name: "ship.example.com", profile: "https://ship.example.com" });
  assert.deepEqual(contactInviteFrom("ship.example.com", undefined), { name: "ship.example.com", profile: "https://ship.example.com" });
  assert.equal(contactInviteFrom("esteve", undefined), null);
  assert.equal(contactInviteFrom("<script>", "ship.space"), null);
  assert.equal(contactInviteFrom("", "ship.space"), null);
  assert.equal(contactInviteFrom(null, "ship.space"), null);
});
