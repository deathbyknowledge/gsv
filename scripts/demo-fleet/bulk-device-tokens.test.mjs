import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDeviceTokens,
  revokeDeviceTokens,
} from "./bulk-device-tokens.mjs";

function options(tokenFile, overrides = {}) {
  return {
    tokenFile,
    count: 3,
    concurrency: 3,
    paceMs: 0,
    ttlHours: 12,
    fleetId: "test",
    force: false,
    keepFile: false,
    reason: "test cleanup",
    now: () => 1_700_000_000_000,
    shouldAbort: () => false,
    ...overrides,
  };
}

async function doesNotExist(path) {
  await assert.rejects(stat(path), { code: "ENOENT" });
}

test("mismatched issued metadata is revoked without writing a CSV", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gsv-bulk-token-mismatch-"));
  const tokenFile = join(directory, "tokens.csv");
  const revoked = [];
  const client = {
    async call(call, args) {
      if (call === "sys.token.revoke") {
        revoked.push(args.tokenId);
        return { revoked: true };
      }
      assert.equal(call, "sys.token.create");
      return {
        token: {
          tokenId: `id-${args.allowedDeviceId}`,
          token: `secret-${args.allowedDeviceId}`,
          kind: "node",
          allowedRole: args.allowedDeviceId === "edge-002" ? "service" : "driver",
          allowedDeviceId: args.allowedDeviceId,
          expiresAt: args.expiresAt,
        },
      };
    },
  };

  await assert.rejects(
    createDeviceTokens(client, options(tokenFile)),
    /failed to create 1 token/,
  );
  assert.deepEqual(revoked.sort(), ["id-edge-001", "id-edge-002", "id-edge-003"]);
  await doesNotExist(tokenFile);
  await doesNotExist(`${tokenFile}.operation.json`);
  await doesNotExist(`${tokenFile}.lock`);
});

test("creates and revokes an exact 1000-device CSV with bounded concurrency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gsv-bulk-token-1000-"));
  const tokenFile = join(directory, "tokens.csv");
  const revoked = [];
  let activeCreates = 0;
  let maximumActiveCreates = 0;
  const client = {
    async call(call, args) {
      if (call === "sys.token.revoke") {
        revoked.push(args.tokenId);
        return { revoked: true };
      }
      assert.equal(call, "sys.token.create");
      activeCreates += 1;
      maximumActiveCreates = Math.max(maximumActiveCreates, activeCreates);
      await new Promise((resolve) => setImmediate(resolve));
      activeCreates -= 1;
      return {
        token: {
          tokenId: `id-${args.allowedDeviceId}`,
          token: `secret-${args.allowedDeviceId}`,
          kind: "node",
          allowedRole: "driver",
          allowedDeviceId: args.allowedDeviceId,
          expiresAt: args.expiresAt,
        },
      };
    },
  };
  const bulkOptions = options(tokenFile, { count: 1_000, concurrency: 32 });

  const created = await createDeviceTokens(client, bulkOptions);
  assert.equal(created.created, 1_000);
  assert.equal(maximumActiveCreates, 32);
  const info = await stat(tokenFile);
  assert.equal(info.mode & 0o777, 0o600);
  const lines = (await readFile(tokenFile, "utf8")).trimEnd().split("\n");
  assert.equal(lines.length, 1_001);
  assert.match(lines[1], /^edge-001,id-edge-001,/);
  assert.match(lines[1_000], /^edge-1000,id-edge-1000,/);

  const result = await revokeDeviceTokens(client, bulkOptions);
  assert.equal(result.revoked, 1_000);
  assert.equal(new Set(revoked).size, 1_000);
  await doesNotExist(tokenFile);
  await doesNotExist(`${tokenFile}.operation.json`);
  await doesNotExist(`${tokenFile}.lock`);
});
