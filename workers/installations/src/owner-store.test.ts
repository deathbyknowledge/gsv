import { env } from "cloudflare:workers";
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

  it("does not merge a different provider subject by matching an email address", async () => {
    const f = await fixture();
    const first = await f.begin();
    await f.verify(first.id, first.input.secretHash);
    const second = await f.begin(f.other.installationId);
    await expect(f.verify(second.id, second.input.secretHash, { ...f.identity, subject: "different-person" })).rejects.toThrow();
    expect((await f.store.get(second.id))?.state).toBe("authenticating");
  });
});
