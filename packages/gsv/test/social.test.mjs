import assert from "node:assert/strict";
import { test } from "node:test";
import { federationDeliveryEnvelopeSchema, federationDeliveryEnvelopeV2Schema } from "../dist/protocol.js";

const envelope = {
  version: 2, domain: "gsv-federation/2/delivery", deliveryId: "delivery:one",
  senderShipId: "ship:alice", senderSubjectId: "subject:alice", recipientSubjectId: "subject:bob",
  generation: "generation:one", timestampMs: 1, nonce: "nonce", signature: "signature",
  payload: {
    kind: "message", messageId: "message:one", threadId: "thread:one", text: "Hello",
    social: {
      threadId: "thread:one", reference: { actor: { shipId: "ship:alice", subjectId: "subject:alice" }, messageId: "message:one" },
      provenance: { kind: "human" },
    },
  },
};

test("v2 cannot masquerade as v1 or omit provenance", () => {
  assert.equal(federationDeliveryEnvelopeV2Schema.safeParse(envelope).success, true);
  assert.equal(federationDeliveryEnvelopeSchema.safeParse(envelope).success, false);
  assert.equal(federationDeliveryEnvelopeV2Schema.safeParse({ ...envelope, domain: "gsv-federation/2/receipt" }).success, false);
  const { social, ...payload } = envelope.payload;
  assert.equal(federationDeliveryEnvelopeV2Schema.safeParse({ ...envelope, payload }).success, false);
  assert.equal(federationDeliveryEnvelopeV2Schema.safeParse({ ...envelope, payload: { ...payload, social: { ...social, provenance: { kind: "approved" } } } }).success, false);
});
