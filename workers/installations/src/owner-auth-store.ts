import { z } from "zod";
import { constantTimeEqual, sha256Hex } from "./tokens";

export const OWNER_CODE_TTL_MS = 10 * 60 * 1000;
export const OWNER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const OWNER_CODE_RESEND_MS = 60 * 1000;
const SEND_WINDOW_MS = 60 * 60 * 1000;
const EMAIL_SEND_LIMIT = 5;
const IP_SEND_LIMIT = 20;
const identifierSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/);
const secretSchema = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/);
const emailSchema = z.string().trim().toLowerCase().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
const codeSecretSchema = z.string().min(32).max(512);
const ipSchema = z.string().min(1).max(128);
const resendSchema = z.boolean().optional();

export type OwnerAuthPurpose = "login" | "link" | "recover";
export type OwnerAuthErrorCode = "invalid" | "expired" | "locked" | "rate_limited" | "unavailable" | "already_used" | "credential_unavailable";
export class OwnerAuthError extends Error {
  constructor(readonly code: OwnerAuthErrorCode, readonly retryAt?: number) { super(`Owner authentication ${code}`); }
}
export type OwnerCodeRequest = {
  challengeId: string;
  email: string;
  ip: string;
  browserSecret: string;
  purpose: OwnerAuthPurpose;
  ownerAttemptId?: string;
  resend?: boolean;
};
export type IssuedOwnerCode = {
  challengeId: string;
  email: string;
  code: string;
  expiresAt: number;
  retryAt: number;
  sendRequired: boolean;
  deliveryId?: string;
  deliveryStatus: "sending" | "sent" | "failed";
};
export type OwnerCodeVerification = {
  challengeId: string;
  code: string;
  browserSecret: string;
  sessionSecret: string;
  purpose: OwnerAuthPurpose;
  ownerAttemptId?: string;
};
export type OwnerAuthReceipt = {
  receiptId: string;
  principalId: string;
  email: string;
  verifiedAt: number;
  purpose: OwnerAuthPurpose;
  ownerAttemptId?: string;
  expiresAt: number;
  sessionExpiresAt: number;
};
export type OwnerAuthSession = { principalId: string; email: string; authenticatedAt: number; expiresAt: number };
type Challenge = {
  id: string; email: string; purpose: OwnerAuthPurpose; owner_attempt_id: string | null;
  browser_secret_hash: string; code_generation: string; code_verifier: string; failed_attempts: number;
  created_at: number; expires_at: number; revoked_at: number | null;
  verification_id: string | null; verified_at: number | null; principal_id: string | null; session_hash: string | null;
  delivery_id: string; delivery_status: IssuedOwnerCode["deliveryStatus"]; delivery_lease_until: number; sent_at: number | null;
};

const AUTHENTICATING_CONTEXT = `(c.purpose = 'login' OR EXISTS (
  SELECT 1 FROM installation_owner_attempts a JOIN installations i ON i.id = a.installation_id
  WHERE a.id = c.owner_attempt_id AND a.purpose = c.purpose AND a.browser_secret_hash = c.browser_secret_hash
    AND a.state = 'authenticating' AND a.code_verifier IS NULL AND a.nonce IS NULL
    AND a.expires_at > ? AND i.state = 'active' AND i.owner_principal_id = a.expected_owner_id
    AND (c.purpose != 'recover' OR EXISTS (
      SELECT 1 FROM principal_email_credentials e JOIN principals p ON p.id = e.principal_id
      WHERE e.email_normalized = c.email AND e.principal_id = a.expected_owner_id AND e.revoked_at IS NULL
        AND p.state = 'active' AND p.email_verified_at IS NOT NULL))))`;
const NATIVE_CREDENTIAL_AVAILABLE = `(EXISTS (
  SELECT 1 FROM principal_email_credentials e JOIN principals p ON p.id = e.principal_id
  WHERE e.email_normalized = c.email AND e.revoked_at IS NULL AND p.state = 'active' AND p.email_verified_at IS NOT NULL)
  OR (c.purpose != 'recover' AND NOT EXISTS (SELECT 1 FROM principals p WHERE p.primary_email_normalized = c.email)
    AND NOT EXISTS (SELECT 1 FROM principal_email_credentials e WHERE e.email_normalized = c.email)))`;

/** Native email credentials are explicit; matching an external identity's email never grants its principal. */
export class InstallationOwnerAuthStore {
  private readonly key: Promise<CryptoKey>;
  constructor(private readonly db: D1Database, codeSecret: string) {
    if (!codeSecretSchema.safeParse(codeSecret).success) throw new OwnerAuthError("unavailable");
    this.key = crypto.subtle.importKey("raw", new TextEncoder().encode(codeSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  }

  async issue(input: OwnerCodeRequest, now = Date.now()): Promise<IssuedOwnerCode> {
    const id = identifier(input.challengeId);
    const email = normalizeEmail(input.email);
    const ownerAttemptId = attemptId(input.purpose, input.ownerAttemptId);
    if (!resendSchema.safeParse(input.resend).success) throw new OwnerAuthError("invalid");
    const browser = await sha256Hex(secret(input.browserSecret));
    if (!ipSchema.safeParse(input.ip).success) throw new OwnerAuthError("invalid");
    const [emailKey, ipKey] = await Promise.all([this.mac("email-rate", email), this.mac("ip-rate", input.ip)]);
    const existing = await this.get(id);
    const generation = existing?.code_generation ?? crypto.randomUUID();
    const code = await this.code(id, email, input.purpose, ownerAttemptId, browser, generation);
    const verifier = await this.verifier(id, browser, input.purpose, ownerAttemptId, generation, code);
    if (existing) {
      this.match(existing, browser, input.purpose, ownerAttemptId, now);
      if (existing.email !== email || existing.verified_at !== null) throw new OwnerAuthError("already_used");
      if (!constantTimeEqual(existing.code_verifier, verifier)) throw new OwnerAuthError("unavailable");
      if ((existing.delivery_status === "sent" && !input.resend) || existing.delivery_lease_until > now) return this.issued(existing, code, false);
    }
    const deliveryId = crypto.randomUUID();
    const allowedRate = `NOT EXISTS (SELECT 1 FROM owner_auth_send_events WHERE email_key = ? AND created_at > ?)
      AND (SELECT COUNT(*) FROM owner_auth_send_events WHERE email_key = ? AND created_at > ?) < ${EMAIL_SEND_LIMIT}
      AND (SELECT COUNT(*) FROM owner_auth_send_events WHERE ip_key = ? AND created_at > ?) < ${IP_SEND_LIMIT}`;
    const rateArgs = [emailKey, now - OWNER_CODE_RESEND_MS, emailKey, now - SEND_WINDOW_MS, ipKey, now - SEND_WINDOW_MS];
    const statements: D1PreparedStatement[] = [];
    if (existing) {
      statements.push(this.db.prepare(`UPDATE owner_auth_challenges AS c
        SET delivery_id = ?, delivery_status = 'sending', delivery_lease_until = ?
        WHERE id = ? AND email = ? AND browser_secret_hash = ? AND purpose = ? AND owner_attempt_id IS ?
          AND verified_at IS NULL AND revoked_at IS NULL AND failed_attempts < 5 AND expires_at > ?
          AND (delivery_status != 'sent' OR ? = 1) AND delivery_lease_until <= ? AND ${AUTHENTICATING_CONTEXT} AND ${allowedRate}`)
        .bind(deliveryId, now + OWNER_CODE_RESEND_MS, id, email, browser, input.purpose, ownerAttemptId, now, input.resend ? 1 : 0, now, now, ...rateArgs));
    } else {
      statements.push(this.db.prepare(`WITH candidate AS (SELECT ? AS id, ? AS email, ? AS purpose, ? AS owner_attempt_id,
          ? AS browser_secret_hash)
        INSERT INTO owner_auth_challenges (id, email, purpose, owner_attempt_id, browser_secret_hash, code_generation, code_verifier,
          created_at, expires_at, delivery_id, delivery_status, delivery_lease_until)
        SELECT c.id, c.email, c.purpose, c.owner_attempt_id, c.browser_secret_hash, ?, ?, ?,
          MIN(?, COALESCE((SELECT expires_at FROM installation_owner_attempts WHERE id = c.owner_attempt_id), ?)), ?, 'sending', ?
        FROM candidate c WHERE ${AUTHENTICATING_CONTEXT} AND ${allowedRate} ON CONFLICT(id) DO NOTHING`)
        .bind(id, email, input.purpose, ownerAttemptId, browser, generation, verifier, now, now + OWNER_CODE_TTL_MS,
          now + OWNER_CODE_TTL_MS, deliveryId, now + OWNER_CODE_RESEND_MS, now, ...rateArgs));
    }
    statements.push(this.db.prepare(`INSERT INTO owner_auth_send_events (id, email_key, ip_key, created_at, expires_at)
      SELECT delivery_id, ?, ?, ?, ? FROM owner_auth_challenges WHERE id = ? AND delivery_id = ?`)
      .bind(emailKey, ipKey, now, now + SEND_WINDOW_MS, id, deliveryId));
    statements.push(this.db.prepare(`UPDATE owner_auth_challenges SET revoked_at = ?
      WHERE id != ? AND email = ? AND browser_secret_hash = ? AND purpose = ? AND owner_attempt_id IS ?
        AND verified_at IS NULL AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM owner_auth_challenges c WHERE c.id = ? AND c.delivery_id = ?)`)
      .bind(now, id, email, browser, input.purpose, ownerAttemptId, id, deliveryId));
    await this.db.batch(statements);
    const issued = await this.get(id);
    if (!issued) throw new OwnerAuthError("rate_limited", await this.nextSendAt(emailKey, ipKey, now));
    this.match(issued, browser, input.purpose, ownerAttemptId, now);
    if (issued.email !== email) throw new OwnerAuthError("already_used");
    const issuedCode = await this.code(id, email, input.purpose, ownerAttemptId, browser, issued.code_generation);
    const issuedVerifier = await this.verifier(id, browser, input.purpose, ownerAttemptId, issued.code_generation, issuedCode);
    if (!constantTimeEqual(issued.code_verifier, issuedVerifier)) throw new OwnerAuthError("unavailable");
    if (issued.delivery_id !== deliveryId && (issued.delivery_status !== "sent" || input.resend) && issued.delivery_lease_until <= now) {
      throw new OwnerAuthError("rate_limited", await this.nextSendAt(emailKey, ipKey, now));
    }
    return this.issued(issued, issuedCode, issued.delivery_id === deliveryId);
  }

  async recordDelivery(input: { challengeId: string; deliveryId: string; browserSecret: string; sent: boolean }, now = Date.now()): Promise<void> {
    const result = await this.db.prepare(`UPDATE owner_auth_challenges SET delivery_status = ?, sent_at = CASE WHEN ? THEN ? ELSE sent_at END
      WHERE id = ? AND delivery_id = ? AND browser_secret_hash = ? AND delivery_status = 'sending'
        AND expires_at > ? AND revoked_at IS NULL`)
      .bind(input.sent ? "sent" : "failed", input.sent ? 1 : 0, now, identifier(input.challengeId), identifier(input.deliveryId),
        await sha256Hex(secret(input.browserSecret)), now).run();
    if (result.meta.changes !== 1) throw new OwnerAuthError("unavailable");
  }

  async verify(input: OwnerCodeVerification, now = Date.now()): Promise<OwnerAuthReceipt> {
    const id = identifier(input.challengeId);
    const ownerAttemptId = attemptId(input.purpose, input.ownerAttemptId);
    if (!/^[0-9]{6}$/.test(input.code)) throw new OwnerAuthError("invalid");
    const [browser, sessionHash] = await Promise.all([sha256Hex(secret(input.browserSecret)), sha256Hex(secret(input.sessionSecret))]);
    const challenge = await this.get(id);
    if (!challenge) throw new OwnerAuthError("unavailable");
    this.match(challenge, browser, input.purpose, ownerAttemptId, now);
    const verifier = await this.verifier(id, browser, input.purpose, ownerAttemptId, challenge.code_generation, input.code);
    if (challenge.verified_at !== null) {
      if (!constantTimeEqual(challenge.code_verifier, verifier) || challenge.session_hash !== sessionHash) throw new OwnerAuthError("already_used");
      return this.receipt({ receiptId: id, browserSecret: input.browserSecret, purpose: input.purpose, ownerAttemptId: input.ownerAttemptId }, now);
    }
    const verificationId = crypto.randomUUID();
    const principalId = `principal_native_${crypto.randomUUID()}`;
    const success = `c.id = ? AND c.verification_id = ?`;
    await this.db.batch([
      this.db.prepare(`UPDATE owner_auth_challenges SET failed_attempts = failed_attempts + 1
        WHERE id = ? AND browser_secret_hash = ? AND purpose = ? AND owner_attempt_id IS ? AND code_verifier != ?
          AND verified_at IS NULL AND revoked_at IS NULL AND failed_attempts < 5 AND expires_at > ?`)
        .bind(id, browser, input.purpose, ownerAttemptId, verifier, now),
      this.db.prepare(`UPDATE owner_auth_challenges AS c SET verification_id = ?, verified_at = ?, session_hash = ?
        WHERE id = ? AND browser_secret_hash = ? AND purpose = ? AND owner_attempt_id IS ? AND code_verifier = ?
          AND verified_at IS NULL AND revoked_at IS NULL AND failed_attempts < 5 AND expires_at > ?
          AND ${AUTHENTICATING_CONTEXT} AND ${NATIVE_CREDENTIAL_AVAILABLE}
          AND NOT EXISTS (SELECT 1 FROM owner_auth_sessions WHERE token_hash = ?)`)
        .bind(verificationId, now, sessionHash, id, browser, input.purpose, ownerAttemptId, verifier, now, now, sessionHash),
      this.db.prepare(`INSERT INTO principals (id, primary_email, primary_email_normalized, display_name, email_verified_at, state, created_at, updated_at)
        SELECT ?, c.email, c.email, c.email, ?, 'active', ?, ? FROM owner_auth_challenges c WHERE ${success}
          AND NOT EXISTS (SELECT 1 FROM principal_email_credentials WHERE email_normalized = c.email)`)
        .bind(principalId, now, now, now, id, verificationId),
      this.db.prepare(`INSERT INTO principal_email_credentials (email_normalized, principal_id, created_at)
        SELECT c.email, ?, ? FROM owner_auth_challenges c WHERE ${success}
          AND EXISTS (SELECT 1 FROM principals p WHERE p.id = ?)
        ON CONFLICT(email_normalized) DO NOTHING`).bind(principalId, now, id, verificationId, principalId),
      this.db.prepare(`UPDATE owner_auth_challenges AS c SET principal_id = (
          SELECT principal_id FROM principal_email_credentials WHERE email_normalized = c.email AND revoked_at IS NULL)
        WHERE ${success}`).bind(id, verificationId),
      this.db.prepare(`INSERT INTO owner_auth_sessions (token_hash, principal_id, authenticated_at, expires_at)
        SELECT c.session_hash, c.principal_id, c.verified_at, c.verified_at + ? FROM owner_auth_challenges c
        WHERE ${success} AND c.principal_id IS NOT NULL`).bind(OWNER_SESSION_TTL_MS, id, verificationId),
    ]);
    const current = await this.get(id);
    if (current?.verified_at !== null && current?.session_hash === sessionHash && constantTimeEqual(current.code_verifier, verifier)) {
      return this.receipt({ receiptId: id, browserSecret: input.browserSecret, purpose: input.purpose, ownerAttemptId: input.ownerAttemptId }, now);
    }
    if (current?.failed_attempts === 5) throw new OwnerAuthError("locked");
    if (constantTimeEqual(challenge.code_verifier, verifier)) {
      const collision = await this.db.prepare(`SELECT 1 FROM principals p WHERE p.primary_email_normalized = ?
        AND NOT EXISTS (SELECT 1 FROM principal_email_credentials e WHERE e.email_normalized = ?)`).bind(challenge.email, challenge.email).first();
      if (collision) throw new OwnerAuthError("credential_unavailable");
      throw new OwnerAuthError("unavailable");
    }
    throw new OwnerAuthError("invalid");
  }

  async receipt(input: { receiptId: string; browserSecret: string; purpose: OwnerAuthPurpose; ownerAttemptId?: string }, now = Date.now()): Promise<OwnerAuthReceipt> {
    const ownerAttemptId = attemptId(input.purpose, input.ownerAttemptId);
    const browser = await sha256Hex(secret(input.browserSecret));
    const row = await this.db.prepare(`SELECT c.*, s.expires_at AS session_expires_at FROM owner_auth_challenges c
      JOIN owner_auth_sessions s ON s.token_hash = c.session_hash AND s.principal_id = c.principal_id
      JOIN principals p ON p.id = c.principal_id
      JOIN principal_email_credentials e ON e.principal_id = p.id AND e.email_normalized = c.email
      WHERE c.id = ? AND c.purpose = ? AND c.owner_attempt_id IS ? AND c.browser_secret_hash = ?
        AND c.verified_at IS NOT NULL AND c.revoked_at IS NULL AND c.expires_at > ?
        AND s.revoked_at IS NULL AND s.expires_at > ? AND p.state = 'active' AND p.email_verified_at IS NOT NULL AND e.revoked_at IS NULL
        AND (c.purpose = 'login' OR EXISTS (
          SELECT 1 FROM installation_owner_attempts a JOIN installations i ON i.id = a.installation_id
          WHERE a.id = c.owner_attempt_id AND a.purpose = c.purpose AND a.browser_secret_hash = c.browser_secret_hash
            AND a.code_verifier IS NULL AND a.nonce IS NULL
            AND a.expires_at > ? AND i.state = 'active' AND (a.principal_id IS NULL OR a.principal_id = c.principal_id)
            AND ((i.owner_principal_id = a.expected_owner_id AND a.state IN ('authenticating', 'verified', 'complete'))
              OR (a.purpose = 'link' AND a.state = 'complete' AND i.owner_principal_id = c.principal_id AND a.principal_id = c.principal_id))))`)
      .bind(identifier(input.receiptId), input.purpose, ownerAttemptId, browser, now, now, now)
      .first<Challenge & { session_expires_at: number }>();
    if (!row || !row.principal_id || row.verified_at === null) throw new OwnerAuthError("unavailable");
    const receipt: OwnerAuthReceipt = { receiptId: row.id, principalId: row.principal_id, email: row.email, verifiedAt: row.verified_at,
      purpose: row.purpose,
      expiresAt: row.expires_at, sessionExpiresAt: row.session_expires_at };
    if (row.owner_attempt_id) receipt.ownerAttemptId = row.owner_attempt_id;
    return receipt;
  }

  async session(sessionSecret: string, now = Date.now()): Promise<OwnerAuthSession | null> {
    const row = await this.db.prepare(`SELECT s.principal_id, e.email_normalized, s.authenticated_at, s.expires_at
      FROM owner_auth_sessions s JOIN principals p ON p.id = s.principal_id JOIN principal_email_credentials e ON e.principal_id = p.id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND p.state = 'active'
        AND p.email_verified_at IS NOT NULL AND e.revoked_at IS NULL`).bind(await sha256Hex(secret(sessionSecret)), now)
      .first<{ principal_id: string; email_normalized: string; authenticated_at: number; expires_at: number }>();
    return row ? { principalId: row.principal_id, email: row.email_normalized, authenticatedAt: row.authenticated_at, expiresAt: row.expires_at } : null;
  }

  async logout(sessionSecret: string, now = Date.now()): Promise<void> {
    await this.db.prepare("UPDATE owner_auth_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ?")
      .bind(now, await sha256Hex(secret(sessionSecret))).run();
  }

  async cleanup(now = Date.now(), limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new OwnerAuthError("invalid");
    const results = await this.db.batch([
      this.db.prepare("DELETE FROM owner_auth_challenges WHERE id IN (SELECT id FROM owner_auth_challenges WHERE expires_at <= ? ORDER BY expires_at, id LIMIT ?)").bind(now, limit),
      this.db.prepare(`DELETE FROM installation_owner_attempts WHERE id IN (
        SELECT a.id FROM installation_owner_attempts a WHERE a.expires_at <= ?
          AND NOT EXISTS (SELECT 1 FROM owner_auth_challenges c WHERE c.owner_attempt_id = a.id)
        ORDER BY a.expires_at, a.id LIMIT ?)`).bind(now, limit),
      this.db.prepare("DELETE FROM owner_auth_sessions WHERE token_hash IN (SELECT token_hash FROM owner_auth_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL ORDER BY expires_at, token_hash LIMIT ?)").bind(now, limit),
      this.db.prepare("DELETE FROM owner_auth_send_events WHERE id IN (SELECT id FROM owner_auth_send_events WHERE expires_at <= ? ORDER BY expires_at, id LIMIT ?)").bind(now, limit),
    ]);
    return results.reduce((count, result) => count + (result.meta.changes ?? 0), 0);
  }

  private get(id: string): Promise<Challenge | null> {
    return this.db.prepare("SELECT * FROM owner_auth_challenges WHERE id = ?").bind(id).first<Challenge>();
  }
  private match(row: Challenge, browser: string, purpose: OwnerAuthPurpose, ownerAttemptId: string | null, now: number): void {
    if (!constantTimeEqual(row.browser_secret_hash, browser) || row.purpose !== purpose || row.owner_attempt_id !== ownerAttemptId) throw new OwnerAuthError("unavailable");
    if (row.expires_at <= now) throw new OwnerAuthError("expired");
    if (row.revoked_at !== null) throw new OwnerAuthError("unavailable");
    if (row.failed_attempts >= 5) throw new OwnerAuthError("locked");
  }
  private issued(row: Challenge, code: string, sendRequired: boolean): IssuedOwnerCode {
    const issued: IssuedOwnerCode = { challengeId: row.id, email: row.email, code, expiresAt: row.expires_at, retryAt: row.delivery_lease_until,
      sendRequired, deliveryStatus: row.delivery_status };
    if (sendRequired) issued.deliveryId = row.delivery_id;
    return issued;
  }
  private async nextSendAt(emailKey: string, ipKey: string, now: number): Promise<number> {
    const row = await this.db.prepare(`SELECT
      MAX(CASE WHEN email_key = ? THEN created_at END) AS last_email,
      COUNT(CASE WHEN email_key = ? THEN 1 END) AS email_count, MIN(CASE WHEN email_key = ? THEN created_at END) AS first_email,
      COUNT(CASE WHEN ip_key = ? THEN 1 END) AS ip_count, MIN(CASE WHEN ip_key = ? THEN created_at END) AS first_ip
      FROM owner_auth_send_events WHERE created_at > ? AND (email_key = ? OR ip_key = ?)`)
      .bind(emailKey, emailKey, emailKey, ipKey, ipKey, now - SEND_WINDOW_MS, emailKey, ipKey)
      .first<{ last_email: number | null; email_count: number; first_email: number | null; ip_count: number; first_ip: number | null }>();
    return Math.max(now, (row?.last_email ?? now) + OWNER_CODE_RESEND_MS,
      (row?.email_count ?? 0) >= EMAIL_SEND_LIMIT ? (row?.first_email ?? now) + SEND_WINDOW_MS : now,
      (row?.ip_count ?? 0) >= IP_SEND_LIMIT ? (row?.first_ip ?? now) + SEND_WINDOW_MS : now);
  }
  private async mac(domain: string, value: string): Promise<string> {
    const signature = await crypto.subtle.sign("HMAC", await this.key, new TextEncoder().encode(JSON.stringify([domain, value])));
    return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  private async code(id: string, email: string, purpose: OwnerAuthPurpose, ownerAttemptId: string | null, browser: string, generation: string): Promise<string> {
    const digest = await this.mac("owner-code", JSON.stringify([id, email, purpose, ownerAttemptId, browser, generation]));
    return (BigInt(`0x${digest}`) % 1_000_000n).toString().padStart(6, "0");
  }
  private verifier(id: string, browser: string, purpose: OwnerAuthPurpose, ownerAttemptId: string | null, generation: string, code: string): Promise<string> {
    return this.mac("owner-code-verifier", JSON.stringify([id, browser, purpose, ownerAttemptId, generation, code]));
  }
}

function identifier(value: string): string {
  const parsed = identifierSchema.safeParse(value);
  if (!parsed.success) throw new OwnerAuthError("invalid");
  return parsed.data;
}
function secret(value: string): string {
  const parsed = secretSchema.safeParse(value);
  if (!parsed.success) throw new OwnerAuthError("invalid");
  return parsed.data;
}
function normalizeEmail(value: string): string {
  const parsed = emailSchema.safeParse(value);
  if (!parsed.success) throw new OwnerAuthError("invalid");
  return parsed.data;
}
function attemptId(purpose: OwnerAuthPurpose, value?: string): string | null {
  if (purpose !== "login" && purpose !== "link" && purpose !== "recover") throw new OwnerAuthError("invalid");
  if (purpose === "login") {
    if (value !== undefined) throw new OwnerAuthError("invalid");
    return null;
  }
  return identifier(value ?? "");
}
