import assert from "node:assert/strict";
import { test } from "node:test";
import { deliverInputSchema } from "../dist/protocol.js";

const ALICE = "did:plc:aliceaaaaaaaaaaaaaaaaaaa";
const delivery = {
  deliveryId: "delivery:one",
  generation: "generation:one",
  payload: {
    kind: "message", messageId: "message:one", threadId: "thread:one", text: "Hello",
    social: { threadId: "thread:one", reference: { did: ALICE, messageId: "message:one" }, provenance: { kind: "human" } },
  },
};

test("a delivered message names its author by DID and says who wrote it", () => {
  assert.equal(deliverInputSchema.safeParse(delivery).success, true);
  const { social, ...payload } = delivery.payload;
  assert.equal(deliverInputSchema.safeParse({ ...delivery, payload }).success, false);
  assert.equal(deliverInputSchema.safeParse({ ...delivery, payload: { ...payload, social: { ...social, provenance: { kind: "approved" } } } }).success, false);
  const actor = { shipId: "ship:alice", subjectId: "subject:alice" };
  assert.equal(deliverInputSchema.safeParse({ ...delivery, payload: { ...payload, social: { ...social, reference: { actor, messageId: "message:one" } } } }).success, false);
  assert.equal(deliverInputSchema.safeParse({ ...delivery, payload: { ...payload, social: { ...social, reference: { did: "ship:alice", messageId: "message:one" } } } }).success, false);
});

test("a delivery carries no sender identity of its own", () => {
  assert.equal(deliverInputSchema.safeParse({ ...delivery, senderDid: ALICE }).success, false);
  assert.equal(deliverInputSchema.safeParse({ ...delivery, payload: { kind: "contact.revoked" } }).success, true);
  assert.equal(deliverInputSchema.safeParse({ ...delivery, payload: { kind: "contact.revoked", generation: "generation:one" } }).success, false);
});
