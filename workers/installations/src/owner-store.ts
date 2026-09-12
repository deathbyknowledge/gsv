import type { BeginInstallationOwnerLinkInput } from "@humansandmachines/gsv/services/ownership";
import { sha256Hex } from "./tokens";

export const OWNER_ATTEMPT_TTL_MS = 10 * 60 * 1000;

export type VerifiedOwnerIdentity = { issuer: string; subject: string; email: string; name: string };
export type OwnerAttempt = {
  id: string;
  installation_id: string;
  purpose: "link" | "recover";
  expected_owner_id: string;
  link_secret_hash: string | null;
  browser_secret_hash: string | null;
  code_verifier: string | null;
  nonce: string | null;
  principal_id: string | null;
  state: "pending" | "authenticating" | "verified" | "complete";
  created_at: number;
  expires_at: number;
};

/** Accounts owns external identity and ownership. This store never reads or writes Kernel credentials. */
export class InstallationOwnerStore {
  constructor(private readonly db: D1Database, private readonly registryPrincipalId: string) {}

  async beginLink(input: BeginInstallationOwnerLinkInput, now = Date.now()): Promise<OwnerAttempt> {
    if (!/^[a-f0-9]{64}$/.test(input.secretHash)) throw new Error("Invalid owner link proof");
    await this.db.prepare(`INSERT INTO installation_owner_attempts
      (id, installation_id, purpose, expected_owner_id, link_secret_hash, state, created_at, expires_at)
      SELECT ?, id, 'link', owner_principal_id, ?, 'pending', ?, ? FROM installations
      WHERE id = ? AND state = 'active' AND owner_principal_id = ?
      ON CONFLICT(id) DO NOTHING`).bind(input.attemptId, input.secretHash, now, now + OWNER_ATTEMPT_TTL_MS,
      input.installationId, this.registryPrincipalId).run();
    const attempt = await this.get(input.attemptId);
    if (!attempt || attempt.installation_id !== input.installationId || attempt.purpose !== "link"
      || attempt.link_secret_hash !== input.secretHash || attempt.expires_at <= now) throw new Error("Owner linking is unavailable");
    return attempt;
  }

  async beginRecovery(handle: string, id: string, now = Date.now()): Promise<OwnerAttempt> {
    await this.db.prepare(`INSERT INTO installation_owner_attempts
      (id, installation_id, purpose, expected_owner_id, state, created_at, expires_at)
      SELECT ?, id, 'recover', owner_principal_id, 'pending', ?, ? FROM installations
      WHERE handle = ? AND state = 'active' AND owner_principal_id != ? ON CONFLICT(id) DO NOTHING`).bind(
      id, now, now + OWNER_ATTEMPT_TTL_MS, handle, this.registryPrincipalId).run();
    const attempt = await this.get(id);
    const valid = await this.db.prepare(`SELECT 1 FROM installations WHERE id = ? AND handle = ? AND state = 'active'
      AND owner_principal_id = ?`).bind(attempt?.installation_id ?? "", handle, attempt?.expected_owner_id ?? "").first();
    if (!attempt || attempt.purpose !== "recover" || attempt.expires_at <= now || !valid) throw new Error("Owner recovery is unavailable");
    return attempt;
  }

  async startAuthentication(id: string, input: { linkSecretHash?: string; browserSecretHash: string; verifier: string; nonce: string }, now = Date.now()): Promise<OwnerAttempt> {
    const result = await this.db.prepare(`UPDATE installation_owner_attempts
      SET browser_secret_hash = ?, code_verifier = ?, nonce = ?, state = 'authenticating'
      WHERE id = ? AND state = 'pending' AND expires_at > ?
      AND (purpose = 'recover' OR link_secret_hash = ?)
      AND EXISTS (SELECT 1 FROM installations i WHERE i.id = installation_id AND i.state = 'active' AND i.owner_principal_id = expected_owner_id)`)
      .bind(input.browserSecretHash, input.verifier, input.nonce, id, now, input.linkSecretHash ?? null).run();
    if (result.meta.changes !== 1) throw new Error("Owner authentication attempt is unavailable");
    return (await this.get(id))!;
  }

  async verify(id: string, browserSecretHash: string, identity: VerifiedOwnerIdentity, now = Date.now()): Promise<OwnerAttempt> {
    // Identity is keyed by the provider's immutable subject, never by a caller-supplied email.
    const principalId = `principal_oidc_${await sha256Hex(JSON.stringify([identity.issuer, identity.subject]))}`;
    const attempt = await this.get(id);
    if (!attempt || attempt.browser_secret_hash !== browserSecretHash || attempt.expires_at <= now) throw new Error("Owner authentication attempt is unavailable");
    if (attempt.state === "verified" || attempt.state === "complete") {
      if (attempt.principal_id !== principalId) throw new Error("Owner authentication attempt was already used");
      return attempt;
    }
    if (attempt.state !== "authenticating") throw new Error("Owner authentication attempt is unavailable");
    const active = `EXISTS (SELECT 1 FROM installation_owner_attempts a JOIN installations i ON i.id = a.installation_id
      WHERE a.id = ? AND a.state = 'authenticating' AND a.browser_secret_hash = ? AND a.expires_at > ?
      AND i.state = 'active' AND i.owner_principal_id = a.expected_owner_id)`;
    await this.db.batch([
      this.db.prepare(`INSERT INTO principals (id, primary_email, primary_email_normalized, display_name, email_verified_at, state, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, 'active', ?, ? WHERE ${active} ON CONFLICT(id) DO NOTHING`)
        .bind(principalId, identity.email, identity.email.trim().toLowerCase(), identity.name, now, now, now, id, browserSecretHash, now),
      this.db.prepare(`INSERT INTO principal_external_identities (issuer, subject, principal_id, created_at)
        SELECT ?, ?, ?, ? WHERE ${active} ON CONFLICT(issuer, subject) DO NOTHING`)
        .bind(identity.issuer, identity.subject, principalId, now, id, browserSecretHash, now),
      this.db.prepare(`UPDATE installation_owner_attempts SET principal_id = ?, state = 'verified', code_verifier = NULL, nonce = NULL
        WHERE id = ? AND state = 'authenticating' AND browser_secret_hash = ? AND expires_at > ?
        AND EXISTS (SELECT 1 FROM installations i WHERE i.id = installation_id AND i.state = 'active' AND i.owner_principal_id = expected_owner_id)
        AND EXISTS (SELECT 1 FROM principals p WHERE p.id = ? AND p.state = 'active' AND p.email_verified_at IS NOT NULL)
        AND (purpose = 'link' OR expected_owner_id = ?)`)
        .bind(principalId, id, browserSecretHash, now, principalId, principalId),
    ]);
    const verified = await this.get(id);
    if (verified?.state !== "verified" || verified.principal_id !== principalId) throw new Error("This identity does not own the space");
    return verified;
  }

  async startEmailAuthentication(id: string, input: { linkSecretHash?: string; browserSecretHash: string }, now = Date.now()): Promise<OwnerAttempt> {
    await this.db.prepare(`UPDATE installation_owner_attempts SET browser_secret_hash = ?, state = 'authenticating'
      WHERE id = ? AND state = 'pending' AND expires_at > ? AND (purpose = 'recover' OR link_secret_hash = ?)
      AND EXISTS (SELECT 1 FROM installations i WHERE i.id = installation_id AND i.state = 'active' AND i.owner_principal_id = expected_owner_id)`)
      .bind(input.browserSecretHash, id, now, input.linkSecretHash ?? null).run();
    const attempt = await this.get(id);
    if (!attempt || attempt.browser_secret_hash !== input.browserSecretHash || attempt.expires_at <= now
      || attempt.state !== "authenticating" || attempt.code_verifier !== null || attempt.nonce !== null
      || (attempt.purpose === "link" && attempt.link_secret_hash !== input.linkSecretHash)) {
      throw new Error("Owner authentication attempt is unavailable");
    }
    return attempt;
  }

  /** Called only after Accounts verifies a fresh, purpose-bound native email receipt. */
  async verifyPrincipal(id: string, browserSecretHash: string, principalId: string, now = Date.now()): Promise<OwnerAttempt> {
    await this.db.prepare(`UPDATE installation_owner_attempts SET principal_id = ?, state = 'verified'
      WHERE id = ? AND state = 'authenticating' AND browser_secret_hash = ? AND expires_at > ?
      AND code_verifier IS NULL AND nonce IS NULL
      AND EXISTS (SELECT 1 FROM installations i WHERE i.id = installation_id AND i.state = 'active' AND i.owner_principal_id = expected_owner_id)
      AND EXISTS (SELECT 1 FROM principals p WHERE p.id = ? AND p.state = 'active' AND p.email_verified_at IS NOT NULL)
      AND (purpose = 'link' OR expected_owner_id = ?)`)
      .bind(principalId, id, browserSecretHash, now, principalId, principalId).run();
    const attempt = await this.get(id);
    if (!attempt || !["verified", "complete"].includes(attempt.state) || attempt.principal_id !== principalId
      || attempt.browser_secret_hash !== browserSecretHash || attempt.expires_at <= now) throw new Error("Owner verification is unavailable");
    return attempt;
  }

  async spaces(principalId: string): Promise<{ handle: string; canonicalOrigin: string; state: string }[]> {
    const rows = await this.db.prepare(`SELECT i.handle, i.canonical_origin AS canonicalOrigin, i.state
      FROM installations i JOIN principals p ON p.id = i.owner_principal_id
      WHERE i.owner_principal_id = ? AND p.state = 'active' AND p.email_verified_at IS NOT NULL
      AND i.state IN ('active', 'restricted') ORDER BY i.handle`).bind(principalId)
      .all<{ handle: string; canonicalOrigin: string; state: string }>();
    return rows.results;
  }

  async completeLink(id: string, browserSecretHash: string, now = Date.now()): Promise<void> {
    const valid = `EXISTS (SELECT 1 FROM installation_owner_attempts a WHERE a.id = ? AND a.installation_id = installations.id
      AND a.purpose = 'link' AND a.state = 'verified' AND a.browser_secret_hash = ? AND a.expires_at > ?
      AND a.expected_owner_id = installations.owner_principal_id AND a.expected_owner_id = ?)`;
    await this.db.batch([
      this.db.prepare(`UPDATE installations SET owner_principal_id = (SELECT principal_id FROM installation_owner_attempts WHERE id = ?)
        WHERE state = 'active' AND ${valid}
        AND EXISTS (SELECT 1 FROM principals p JOIN installation_owner_attempts a ON a.principal_id = p.id
          WHERE a.id = ? AND p.state = 'active' AND p.email_verified_at IS NOT NULL)`).bind(id, id, browserSecretHash, now, this.registryPrincipalId, id),
      this.db.prepare(`UPDATE memberships SET state = 'revoked' WHERE installation_id = (SELECT installation_id FROM installation_owner_attempts WHERE id = ?)
        AND principal_id = ? AND EXISTS (SELECT 1 FROM installations i JOIN installation_owner_attempts a ON a.installation_id = i.id
        WHERE a.id = ? AND a.state = 'verified' AND i.owner_principal_id = a.principal_id)`)
        .bind(id, this.registryPrincipalId, id),
      this.db.prepare(`INSERT INTO memberships (installation_id, principal_id, role, state, created_at)
        SELECT a.installation_id, a.principal_id, 'owner', 'active', ? FROM installation_owner_attempts a JOIN installations i ON i.id = a.installation_id
        WHERE a.id = ? AND a.state = 'verified' AND i.owner_principal_id = a.principal_id
        ON CONFLICT(installation_id, principal_id) DO UPDATE SET state = 'active', role = 'owner'`).bind(now, id),
      this.db.prepare(`UPDATE installation_owner_attempts SET state = 'complete' WHERE id = ? AND purpose = 'link' AND state = 'verified'
        AND EXISTS (SELECT 1 FROM installations i WHERE i.id = installation_id AND i.owner_principal_id = principal_id)`)
        .bind(id),
    ]);
    const current = await this.get(id);
    if (current?.state !== "complete" || current.browser_secret_hash !== browserSecretHash) throw new Error("Owner linking is unavailable");
  }

  async destination(attempt: OwnerAttempt): Promise<{ canonicalOrigin: string; installationId: string }> {
    const row = await this.db.prepare(`SELECT i.id, i.canonical_origin FROM installations i JOIN principals p ON p.id = i.owner_principal_id
      WHERE i.id = ? AND i.state = 'active' AND i.owner_principal_id = ? AND p.state = 'active' AND p.email_verified_at IS NOT NULL`).bind(attempt.installation_id, attempt.principal_id).first<{ id: string; canonical_origin: string }>();
    if (!row) throw new Error("The space is unavailable");
    return { canonicalOrigin: row.canonical_origin, installationId: row.id };
  }

  async get(id: string): Promise<OwnerAttempt | null> {
    return this.db.prepare("SELECT * FROM installation_owner_attempts WHERE id = ?").bind(id).first<OwnerAttempt>();
  }
}
