import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AccountStore } from "./store";
import { InstallationOwnerStore, OWNER_ATTEMPT_TTL_MS, type VerifiedOwnerIdentity } from "./owner-store";
import { sha256Hex } from "./tokens";

async function fixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const registry = `principal_registry_${suffix}`;
  const accounts = new AccountStore(env.INSTALLATIONS_DB, "example.com");
  await accounts.createPrincipal({ principalId: registry, email: `${suffix}@registry.invalid`, displayName: "Registry", verified: true });
  const reserve = async (name: string) => {
    const result = await accounts.reserveInstallation({ principalId: registry, operationId: `operation_${name}_${suffix}`, handle: `${name}-${suffix}` });
    await env.INSTALLATIONS_DB.prepare("UPDATE installations SET state = 'active' WHERE id = ?").bind(result.installationId).run();
    return result;
  };
  const installation = await reserve("owner");
  const other = await reserve("other");
  const store = new InstallationOwnerStore(env.INSTALLATIONS_DB, registry);
  const identity = { issuer: "https://identity.example.com", subject: crypto.randomUUID(), email: `${suffix}@example.com`, name: "Owner" };
  const begin = async (installationId = installation.installationId) => {
    const id = crypto.randomUUID();
    const secret = crypto.randomUUID();
    const input = { attemptId: id, installationId, secretHash: await sha256Hex(secret) };
    const attempt = await store.beginLink(input);
    return { id, secret, input, attempt };
  };
  const verify = async (id: string, linkSecretHash: string, principal: VerifiedOwnerIdentity = identity) => {
    const browserSecretHash = await sha256Hex(crypto.randomUUID());
    await store.startAuthentication(id, { linkSecretHash, browserSecretHash, verifier: "verifier", nonce: "nonce" });
    return { attempt: await store.verify(id, browserSecretHash, principal), browserSecretHash };
  };
  return { accounts, store, registry, installation, other, begin, verify, identity };
}

describe("verified space ownership", () => {
  it.each([
    { removedColumns: false, existingMembership: false },
    { removedColumns: false, existingMembership: true },
    { removedColumns: true, existingMembership: false },
    { removedColumns: true, existingMembership: true },
  ])("links and replays ownership across schema retirement ($removedColumns, existing: $existingMembership)", async ({ removedColumns, existingMembership }) => {
    const f = await fixture();
    const db = env.INSTALLATIONS_DB;
    const link = await f.begin();
    const verified = await f.verify(link.id, link.input.secretHash);
    if (existingMembership) await db.prepare(`INSERT INTO memberships (installation_id, principal_id, state, created_at)
      VALUES (?, ?, 'revoked', 1)`).bind(f.installation.installationId, verified.attempt.principal_id).run();
    const otherMembership = await db.prepare("SELECT installation_id, principal_id, state, created_at FROM memberships WHERE installation_id = ?")
      .bind(f.other.installationId).first();
    const originalSchema = await db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'memberships'").first<{ sql: string }>();
    if (!originalSchema) throw new Error("Missing membership schema");
    const triggers = await db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'memberships' ORDER BY name")
      .all<{ sql: string }>();
    let schemaChanged = false;
    try {
      if (removedColumns) {
        // Test-only future schema: retain ownership rows, constraints and lifecycle fences.
        await applyD1Migrations(db, [{ name: `9999_test_membership_column_retirement_${existingMembership}.sql`, queries: [
          `CREATE TABLE memberships_next (
            installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
            principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
            state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
            created_at INTEGER NOT NULL,
            PRIMARY KEY (installation_id, principal_id)
          )`,
          "INSERT INTO memberships_next SELECT installation_id, principal_id, state, created_at FROM memberships",
          "DROP TABLE memberships",
          "ALTER TABLE memberships_next RENAME TO memberships",
          ...triggers.results.map((trigger) => trigger.sql),
        ] }], "installation_migrations");
        schemaChanged = true;
        expect((await db.prepare("PRAGMA table_info(memberships)").all<{ name: string }>()).results.map((column) => column.name))
          .toEqual(["installation_id", "principal_id", "state", "created_at"]);
      }
      const now = Date.now();
      await f.store.completeLink(link.id, verified.browserSecretHash, now);
      const restarted = new InstallationOwnerStore(db, f.registry);
      await restarted.completeLink(link.id, verified.browserSecretHash, now + 1);
      expect(await db.prepare("SELECT owner_principal_id FROM installations WHERE id = ?").bind(f.installation.installationId).first("owner_principal_id"))
        .toBe(verified.attempt.principal_id);
      expect((await db.prepare("SELECT principal_id, state, created_at FROM memberships WHERE installation_id = ? AND state = 'active'")
        .bind(f.installation.installationId).all()).results).toEqual([
        { principal_id: verified.attempt.principal_id, state: "active", created_at: existingMembership ? 1 : now },
      ]);
      expect(await db.prepare("SELECT state FROM memberships WHERE installation_id = ? AND principal_id = ?")
        .bind(f.installation.installationId, f.registry).first("state")).toBe("revoked");
      expect(await db.prepare("SELECT installation_id, principal_id, state, created_at FROM memberships WHERE installation_id = ?")
        .bind(f.other.installationId).first()).toEqual(otherMembership);
      expect((await restarted.get(link.id))?.state).toBe("complete");
      expect(await restarted.destination(verified.attempt)).toEqual({ installationId: f.installation.installationId, canonicalOrigin: f.installation.canonicalOrigin });
      if (!removedColumns) expect(await db.prepare("SELECT role, local_uid FROM memberships WHERE installation_id = ? AND principal_id = ?")
        .bind(f.installation.installationId, verified.attempt.principal_id).first()).toEqual({ role: "owner", local_uid: null });
      expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    } finally {
      if (schemaChanged) await db.batch([
        db.prepare("ALTER TABLE memberships RENAME TO memberships_test_retired"),
        db.prepare(originalSchema.sql),
        db.prepare(`INSERT INTO memberships (installation_id, principal_id, state, created_at)
          SELECT installation_id, principal_id, state, created_at FROM memberships_test_retired`),
        db.prepare("DROP TABLE memberships_test_retired"),
        ...triggers.results.map((trigger) => db.prepare(trigger.sql)),
      ]);
    }
  });

  it("binds root's exact space and verified provider subject, atomically replacing only registry ownership", async () => {
    const f = await fixture();
    const link = await f.begin();
    expect(await f.store.beginLink(link.input)).toEqual(link.attempt);
    await expect(f.store.beginLink({ ...link.input, installationId: f.other.installationId })).rejects.toThrow("unavailable");
    const verified = await f.verify(link.id, link.input.secretHash);
    await f.store.completeLink(link.id, verified.browserSecretHash);
    await f.store.completeLink(link.id, verified.browserSecretHash);
    const owner = await env.INSTALLATIONS_DB.prepare("SELECT owner_principal_id FROM installations WHERE id = ?").bind(f.installation.installationId).first<{ owner_principal_id: string }>();
    expect(owner?.owner_principal_id).toBe(verified.attempt.principal_id);
    const memberships = await env.INSTALLATIONS_DB.prepare("SELECT principal_id, state, local_uid FROM memberships WHERE installation_id = ? ORDER BY state").bind(f.installation.installationId).all();
    expect(memberships.results).toEqual([
      { principal_id: verified.attempt.principal_id, state: "active", local_uid: null },
      { principal_id: f.registry, state: "revoked", local_uid: null },
    ]);
    expect(await env.INSTALLATIONS_DB.prepare("SELECT owner_principal_id FROM installations WHERE id = ?").bind(f.other.installationId).first("owner_principal_id")).toBe(f.registry);
    expect(await f.store.destination(verified.attempt)).toMatchObject({ installationId: f.installation.installationId });
  });

  it("requires both root link proof and the same browser proof, and permits only one root-authorized claimant", async () => {
    const f = await fixture();
    const first = await f.begin();
    const second = await f.begin();
    await expect(f.store.startAuthentication(first.id, { linkSecretHash: "wrong", browserSecretHash: "browser", verifier: "verifier", nonce: "nonce" })).rejects.toThrow("unavailable");
    const a = await f.verify(first.id, first.input.secretHash);
    const b = await f.verify(second.id, second.input.secretHash, { ...f.identity, subject: crypto.randomUUID(), email: `${crypto.randomUUID()}@example.com` });
    await expect(f.store.completeLink(first.id, "another-browser")).rejects.toThrow("unavailable");
    const results = await Promise.allSettled([f.store.completeLink(first.id, a.browserSecretHash), f.store.completeLink(second.id, b.browserSecretHash)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await env.INSTALLATIONS_DB.prepare("SELECT * FROM memberships WHERE installation_id = ? AND state = 'active'").bind(f.installation.installationId).all()).results).toHaveLength(1);
  });

  it("fences expiry and a reset between provider verification and completion", async () => {
    const f = await fixture();
    const expired = await f.begin();
    await expect(f.store.startAuthentication(expired.id, { linkSecretHash: expired.input.secretHash, browserSecretHash: "browser", verifier: "verifier", nonce: "nonce" }, expired.attempt.created_at + OWNER_ATTEMPT_TTL_MS)).rejects.toThrow("unavailable");
    const link = await f.begin();
    const verified = await f.verify(link.id, link.input.secretHash);
    await env.INSTALLATIONS_DB.prepare("UPDATE installations SET state = 'retained' WHERE id = ?").bind(f.installation.installationId).run();
    await expect(f.store.completeLink(link.id, verified.browserSecretHash)).rejects.toThrow("unavailable");
    expect(await env.INSTALLATIONS_DB.prepare("SELECT owner_principal_id FROM installations WHERE id = ?").bind(f.installation.installationId).first("owner_principal_id")).toBe(f.registry);
  });

  it("recovers only the current real owner and rejects an unrelated subject even with a verified email", async () => {
    const f = await fixture();
    await expect(f.store.beginRecovery(f.other.handle, crypto.randomUUID())).rejects.toThrow("unavailable");
    const link = await f.begin();
    const verified = await f.verify(link.id, link.input.secretHash);
    await f.store.completeLink(link.id, verified.browserSecretHash);
    const recovery = await f.store.beginRecovery(f.installation.handle, crypto.randomUUID());
    const browserSecretHash = await sha256Hex("recovery-browser");
    await f.store.startAuthentication(recovery.id, { browserSecretHash, verifier: "verifier", nonce: "nonce" });
    await expect(f.store.verify(recovery.id, browserSecretHash, { ...f.identity, subject: "unrelated", email: `${crypto.randomUUID()}@example.com` })).rejects.toThrow("does not own");
    const owner = await f.store.verify(recovery.id, browserSecretHash, f.identity);
    expect(owner.principal_id).toBe(verified.attempt.principal_id);
    expect(await f.store.destination(owner)).toMatchObject({ installationId: f.installation.installationId });
  });

  it("keeps two independently claimed spaces isolated when either owner tries the other's recovery", async () => {
    const f = await fixture();
    const otherIdentity = { ...f.identity, subject: crypto.randomUUID(), email: `${crypto.randomUUID()}@example.com` };
    const owners = [{ space: f.installation, identity: f.identity }, { space: f.other, identity: otherIdentity }];
    for (const { space, identity } of owners) {
      const link = await f.begin(space.installationId);
      const verified = await f.verify(link.id, link.input.secretHash, identity);
      await f.store.completeLink(link.id, verified.browserSecretHash);
    }
    const restarted = new InstallationOwnerStore(env.INSTALLATIONS_DB, f.registry);
    for (const [index, { space, identity }] of owners.entries()) {
      const attempt = await restarted.beginRecovery(space.handle, crypto.randomUUID());
      const browserSecretHash = await sha256Hex(crypto.randomUUID());
      await restarted.startAuthentication(attempt.id, { browserSecretHash, verifier: "verifier", nonce: "nonce" });
      await expect(restarted.verify(attempt.id, browserSecretHash, owners[1 - index].identity)).rejects.toThrow("does not own");
      expect((await restarted.get(attempt.id))?.state).toBe("authenticating");
      const recovered = await restarted.verify(attempt.id, browserSecretHash, identity);
      expect(await restarted.destination(recovered)).toEqual({ installationId: space.installationId, canonicalOrigin: space.canonicalOrigin });
      expect(await f.accounts.resolveHostname(new URL(space.canonicalOrigin).hostname)).toMatchObject({ installationId: space.installationId });
    }
    await expect(f.begin(f.installation.installationId)).rejects.toThrow("unavailable");
    await expect(f.begin(f.other.installationId)).rejects.toThrow("unavailable");
  });

  it("lets one verified principal own and recover multiple spaces through their own hostnames", async () => {
    const f = await fixture();
    const principals = new Set<string | null>();
    for (const space of [f.installation, f.other]) {
      const link = await f.begin(space.installationId);
      const verified = await f.verify(link.id, link.input.secretHash);
      await f.store.completeLink(link.id, verified.browserSecretHash);
      principals.add(verified.attempt.principal_id);
    }
    expect(principals.size).toBe(1);
    expect(principals.has(null)).toBe(false);
    const restarted = new InstallationOwnerStore(env.INSTALLATIONS_DB, f.registry);
    for (const space of [f.installation, f.other]) {
      const hostname = new URL(space.canonicalOrigin).hostname;
      const resolved = await f.accounts.resolveHostname(hostname);
      expect(resolved).toMatchObject({ found: true, installationId: space.installationId });
      const attempt = await restarted.beginRecovery(space.handle, crypto.randomUUID());
      const browserSecretHash = await sha256Hex(crypto.randomUUID());
      await restarted.startAuthentication(attempt.id, { browserSecretHash, verifier: "verifier", nonce: "nonce" });
      const recovered = await restarted.verify(attempt.id, browserSecretHash, f.identity);
      expect(principals.has(recovered.principal_id)).toBe(true);
      expect(await restarted.destination(recovered)).toEqual({ installationId: space.installationId, canonicalOrigin: space.canonicalOrigin });
    }
  });

  it("does not merge a different provider subject by matching an email address", async () => {
    const f = await fixture();
    const first = await f.begin();
    await f.verify(first.id, first.input.secretHash);
    const second = await f.begin(f.other.installationId);
    await expect(f.verify(second.id, second.input.secretHash, { ...f.identity, subject: "different-person" })).rejects.toThrow();
    expect((await f.store.get(second.id))?.state).toBe("authenticating");
  });
});
