import assert from "node:assert/strict";
import test from "node:test";
import {
  assertStatusAbsent,
  normalizeBootstrapSource,
  toWebSocketUrl,
  validateInstance,
  validateLeaseManifest,
} from "../../lib/config.mjs";

const instance = "gsv-e2e-07141230-abcd";
const release = "0123456789abcdef0123456789abcdef01234567";

function validLease() {
  return {
    schema_version: 1,
    instance,
    release,
    components: ["ripgit", "assembler", "gateway"],
    workers: {
      ripgit: `${instance}-ripgit`,
      assembler: `${instance}-assembler`,
      gateway: instance,
    },
    r2_bucket: `${instance}-storage`,
    gateway_url: `https://${instance}.example.workers.dev`,
  };
}

function absentStatus() {
  return {
    schema_version: 1,
    instance,
    state: "absent",
    workers: [
      { component: "ripgit", name: `${instance}-ripgit`, deployed: false },
      { component: "assembler", name: `${instance}-assembler`, deployed: false },
      { component: "channel-whatsapp", name: `${instance}-channel-whatsapp`, deployed: false },
      { component: "channel-discord", name: `${instance}-channel-discord`, deployed: false },
      { component: "channel-telegram", name: `${instance}-channel-telegram`, deployed: false },
      { component: "gateway", name: instance, deployed: false },
    ],
    r2_bucket: { name: `${instance}-storage`, exists: false },
  };
}

test("validates an exact core lease and returns its gateway", () => {
  assert.deepEqual(
    validateLeaseManifest(validLease(), { instance, release }),
    {
      instance,
      gatewayUrl: `https://${instance}.example.workers.dev`,
    },
  );
});

test("rejects credential-bearing fields anywhere in a lease", () => {
  const lease = validLease();
  lease.metadata = { api_token: "must-not-be-here" };
  assert.throws(
    () => validateLeaseManifest(lease, { instance, release }),
    /credential-bearing field/,
  );
});

test("rejects unmodeled fields from the retained lease", () => {
  const lease = validLease();
  lease.notes = "unexpected retained content";
  assert.throws(
    () => validateLeaseManifest(lease, { instance, release }),
    /lease fields must contain exactly/,
  );
});

test("rejects a lease for an unexpected worker or release", () => {
  const wrongWorker = validLease();
  wrongWorker.workers.gateway = "someone-elses-worker";
  assert.throws(
    () => validateLeaseManifest(wrongWorker, { instance, release }),
    /lease worker gateway/,
  );
  assert.throws(
    () => validateLeaseManifest(validLease(), { instance, release: "other" }),
    /lease release does not match/,
  );
});

test("accepts only an absent status for namespace acquisition", () => {
  assert.doesNotThrow(() => assertStatusAbsent(absentStatus(), instance));
  const collision = absentStatus();
  collision.state = "partial";
  collision.workers[0].deployed = true;
  assert.throws(() => assertStatusAbsent(collision, instance), /instance collision/);

  const inconsistent = absentStatus();
  inconsistent.workers[0].deployed = true;
  assert.throws(
    () => assertStatusAbsent(inconsistent, instance),
    /inconsistent with resource inventory partial/,
  );
});

test("normalizes public GitHub SSH remotes and rejects embedded credentials", () => {
  assert.equal(
    normalizeBootstrapSource("git@github.com:deathbyknowledge/gsv.git"),
    "https://github.com/deathbyknowledge/gsv.git",
  );
  assert.throws(
    () => normalizeBootstrapSource("https://user:secret@example.com/repo.git"),
    /must not contain credentials/,
  );
});

test("validates owned instance names and derives the websocket endpoint", () => {
  assert.equal(validateInstance(instance), instance);
  assert.throws(() => validateInstance("production"), /must start with gsv-e2e-/);
  assert.equal(
    toWebSocketUrl(`https://${instance}.example.workers.dev`),
    `wss://${instance}.example.workers.dev/ws`,
  );
});
