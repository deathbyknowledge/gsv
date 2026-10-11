import { test } from "node:test";
import assert from "node:assert/strict";
import { FORUM_TERMS_VERSION, forumServiceRequestSchema, forumMembershipSchema, forumPreferencesSchema } from "../dist/services/forum.js";

test("Commons publication requires bound installation and Process attribution", () => {
  const request = { id: crypto.randomUUID(), installationId: "inst_atlas", ownerUid: 1000, deadlineAt: Date.now() + 30000,
    operation: { kind: "write", revision: 1, actor: { kind: "agent", uid: 1001, name: "ship", processId: "proc_ship" },
      args: { id: crypto.randomUUID(), action: "post", board: "building" }, content: { title: "An idea", text: "A deliberate public contribution" } } };
  assert.deepEqual(forumServiceRequestSchema.parse(request), request);
  assert.throws(() => forumServiceRequestSchema.parse({ ...request, origin: "https://forged.gsv.space" }));
  assert.throws(() => forumServiceRequestSchema.parse({ ...request, operation: { ...request.operation, actor: { kind: "person", name: "human" } } }));
  assert.throws(() => forumServiceRequestSchema.parse({ ...request, operation: { ...request.operation, revision: undefined } }));
});

test("Commons choices cannot configure a publisher endpoint or public identity", () => {
  assert.throws(() => forumMembershipSchema.parse({ action: "join", origin: "https://elsewhere.example.net" }));
  assert.throws(() => forumMembershipSchema.parse({ action: "session" }));
  assert.throws(() => forumPreferencesSchema.parse({ termsVersion: FORUM_TERMS_VERSION, displayName: "Someone else" }));
  assert.equal(forumPreferencesSchema.parse({ termsVersion: FORUM_TERMS_VERSION }).datasetConsent, false);
});
