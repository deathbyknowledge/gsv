import { test } from "node:test";
import assert from "node:assert/strict";
import { forumBase64Url, forumCanonicalJson, forumDigest, forumEnvelopeSchema, forumPublicOrigin, verifyForumEnvelope } from "../dist/services/forum.js";

test("forum signatures bind the service, author, content, identity, and validity window", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicKey = { kty, crv, x, y };
  const request = {
    domain: "gsv-forum/1", audience: "https://commons.gsv.space", id: crypto.randomUUID(), issuedAt: Date.now(),
    shipId: `ship:${await forumDigest(forumCanonicalJson(publicKey))}`, origin: "https://my-space.example.net", publicKey,
    actor: { kind: "agent", name: "ship" },
    operation: { kind: "write", args: { action: "reply", id: crypto.randomUUID(), board: "general", thread: "thread" }, content: { text: "A useful answer" } },
  };
  const signature = forumBase64Url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(forumCanonicalJson(request))));
  const envelope = forumEnvelopeSchema.parse({ request, signature });
  assert.equal(await verifyForumEnvelope(envelope, request.audience), true);
  assert.equal(await verifyForumEnvelope(envelope, "https://elsewhere.example.net"), false);
  assert.equal(await verifyForumEnvelope(envelope, request.audience, request.issuedAt + 300001), false);
  for (const patch of [{ shipId: `ship:${"a".repeat(43)}` }, { actor: { kind: "person", name: "owner" } }, { origin: "https://other.example.net" }]) {
    assert.equal(await verifyForumEnvelope({ ...envelope, request: { ...request, ...patch } }, request.audience), false);
  }
  envelope.request.operation.content.text = "Changed answer";
  assert.equal(await verifyForumEnvelope(envelope, request.audience), false);
});

test("forum enrollment accepts canonical public origins and rejects local, credentialed, IP and path URLs", () => {
  assert.equal(forumPublicOrigin("https://alice.gsv.space"), "https://alice.gsv.space");
  for (const origin of ["http://alice.gsv.space", "https://127.0.0.1", "https://[::1]", "https://localhost", "https://foo.internal", "https://alice.gsv.space/", "https://user:pass@alice.gsv.space", "https://alice.gsv.space:8443", "https://alice.gsv.space/#hello"]) {
    assert.throws(() => forumPublicOrigin(origin));
  }
});
