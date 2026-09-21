import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeWorkStream, projectWork, workActions, federationDeliveryPayloadV2Schema } from "../dist/protocol.js";

const work = { offer: { reference: { actor: { shipId: "ship:a", subjectId: "subject:a" }, id: "request:one" }, kind: "task", title: "Review the draft", createdAtMs: 1 }, requester: [], performer: [] };
const accepted = { id: "op:accept", revision: 1, action: "accept", observedPeerRevision: 0 };
const withdrawal = { id: "op:withdraw", revision: 1, action: "withdraw", observedPeerRevision: 0 };
const complete = { id: "op:complete", revision: 2, action: "complete", observedPeerRevision: 0, note: "Review delivered" };

test("crossed acceptance and withdrawal converge without claiming cancellation", () => {
  const first = mergeWorkStream(mergeWorkStream(work, "requester", [withdrawal]), "performer", [accepted]);
  const second = mergeWorkStream(mergeWorkStream(work, "performer", [accepted]), "requester", [withdrawal]);
  assert.deepEqual(first, second);
  assert.deepEqual(projectWork(first), { state: "accepted", status: "stop_requested", outcome: "unreviewed" });
  assert.deepEqual(workActions(first, "performer"), ["complete", "cancel"]);
  assert.deepEqual(workActions(first, "requester"), []);
  const cancelled = mergeWorkStream(first, "performer", [accepted, { id: "op:cancel", revision: 2, action: "cancel", observedPeerRevision: 1 }]);
  assert.equal(projectWork(cancelled).state, "cancelled");
  assert.equal(cancelled.requester[0].action, "withdraw");
});

test("a full prefix repairs missed updates; shorter duplicates never regress or undo a result", () => {
  const result = mergeWorkStream(work, "performer", [accepted, complete]);
  const crossed = mergeWorkStream(result, "requester", [withdrawal]);
  assert.equal(projectWork(crossed).state, "completed");
  assert.equal(mergeWorkStream(crossed, "performer", [accepted]), crossed);
  assert.equal(mergeWorkStream(crossed, "performer", [accepted, complete]), crossed);
  const disputed = mergeWorkStream(crossed, "requester", [withdrawal, { id: "op:dispute", revision: 2, action: "dispute", observedPeerRevision: 2, note: "One section is missing" }]);
  assert.equal(projectWork(disputed).outcome, "disputed");
  assert.equal(projectWork(disputed).state, "completed");
  assert.deepEqual(workActions(disputed, "requester"), ["acknowledge"]);
  assert.deepEqual(disputed.offer, work.offer);
});

test("participants cannot rewrite an operation, forge causality or settle each other's work", () => {
  const existing = mergeWorkStream(work, "performer", [accepted]);
  assert.throws(() => mergeWorkStream(existing, "performer", [{ ...accepted, note: "Changed" }]), /reused/);
  assert.throws(() => mergeWorkStream(work, "requester", [accepted]), /participant/);
  assert.throws(() => mergeWorkStream(work, "performer", [{ ...accepted, observedPeerRevision: 1 }]), /causal/);
  assert.throws(() => mergeWorkStream(work, "performer", [complete]), /contiguous/);
  assert.throws(() => mergeWorkStream(mergeWorkStream(work, "requester", [withdrawal]), "performer", [{ ...accepted, observedPeerRevision: 1 }]), /participant/);
  assert.throws(() => mergeWorkStream(work, "requester", [{ id: "forged-review", revision: 1, action: "acknowledge", observedPeerRevision: 0 }]), /participant/);
});

test("wire bounds include note bytes, strict operations and a finite full prefix", () => {
  const delivery = { kind: "work", offer: work.offer, participant: "performer", operations: [accepted] };
  assert.equal(federationDeliveryPayloadV2Schema.safeParse(delivery).success, true);
  assert.equal(federationDeliveryPayloadV2Schema.safeParse({ ...delivery, operations: [{ ...accepted, note: "🐱".repeat(257) }] }).success, false);
  assert.equal(federationDeliveryPayloadV2Schema.safeParse({ ...delivery, operations: Array(9).fill(accepted) }).success, false);
  assert.equal(federationDeliveryPayloadV2Schema.safeParse({ ...delivery, operations: [{ ...accepted, execute: "anything" }] }).success, false);
});
