import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { creationInvitationUrl, parseCreationInvitation } from "../dist/protocol.js";

const code = `invite_${"x".repeat(43)}`;
describe("creation invitation links", () => {
  it("keeps the credential out of requests and accepts old codes", () => {
    const url = new URL(creationInvitationUrl(code, "https://signup.example.com/"));
    assert.equal(url.search, "");
    assert.equal(parseCreationInvitation(url.href), code);
    assert.equal(parseCreationInvitation(`  ${code}\n`), code);
  });

  it("rejects malformed credentials without repeating them", () => {
    for (const value of ["", "invite_short", `https://signup.example.com/?invite=${code}`,
      `https://user:password@signup.example.com/#invite=${code}`, `javascript:alert(1)#invite=${code}`]) {
      assert.throws(() => parseCreationInvitation(value), { message: "Paste the complete invitation link or code." });
    }
  });
});
