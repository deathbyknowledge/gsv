import type {
  AuthenticatorTransportFuture,
  CredentialDeviceType,
  WebAuthnCredential,
} from "@simplewebauthn/server";
import type { LoginHandoffVerificationResult } from "@humansandmachines/gsv/protocol";
import { normalizeEmail, nowMs, parseOpaqueId } from "../domain";
import {
  base64UrlDecode,
  base64UrlEncode,
  constantTimeEqual,
  createOpaqueToken,
  createRecoveryCode,
  normalizeRecoveryCode,
  sha256Hex,
  tokenPrefix,
} from "../security/tokens";

const EMAIL_VERIFICATION_TTL_MS = 20 * 60 * 1000;
const BOOTSTRAP_SESSION_TTL_MS = 30 * 60 * 1000;
const PLATFORM_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const LOGIN_HANDOFF_TTL_MS = 60 * 1000;

export type PlatformAuthMethod = "email_verification" | "passkey" | "recovery";

export type PlatformPrincipal = {
  id: string;
  email: string;
  displayName: string;
  state: "pending" | "active" | "recovery" | "disabled";
  emailVerifiedAt: number | null;
};

export type PlatformSession = {
  principal: PlatformPrincipal;
  sessionHash: string;
  authMethod: PlatformAuthMethod;
  recentAuthAt: number;
  expiresAt: number;
};

export type IssuedPlatformSession = PlatformSession & {
  token: string;
};

export type WebAuthnChallenge = {
  id: string;
  principalId: string | null;
  sessionHash: string | null;
  kind: "registration" | "authentication";
  challenge: string;
  expiresAt: number;
};

export type StoredPasskey = {
  credentialId: string;
  principalId: string;
  publicKey: Uint8Array;
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  deviceType: CredentialDeviceType;
  backedUp: boolean;
};

type PrincipalRow = {
  id: string;
  primary_email: string;
  display_name: string;
  state: PlatformPrincipal["state"];
  email_verified_at: number | null;
};

type SessionRow = PrincipalRow & {
  id_hash: string;
  auth_method: PlatformAuthMethod;
  recent_auth_at: number;
  expires_at: number;
  revoked_at: number | null;
};

type VerificationTokenRow = {
  token_hash: string;
  principal_id: string;
  expires_at: number;
  used_at: number | null;
};

type StoredPasskeyData = {
  publicKey: string;
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  deviceType: CredentialDeviceType;
  backedUp: boolean;
};

export class PlatformAuthStore {
  constructor(private readonly db: D1Database) {}

  async createOrFindPendingPrincipal(input: {
    email: string;
    displayName: string;
  }): Promise<PlatformPrincipal> {
    const normalizedEmail = normalizeEmail(input.email);
    const displayName = parseDisplayName(input.displayName);
    const existing = await this.getPrincipalByEmail(normalizedEmail);
    if (existing) {
      if (existing.state === "disabled") {
        throw new Error("account is unavailable");
      }
      if (existing.state === "pending" && existing.displayName !== displayName) {
        await this.db.prepare(
          "UPDATE principals SET display_name = ?, updated_at = ? WHERE id = ? AND state = 'pending'",
        ).bind(displayName, nowMs(), existing.id).run();
        return { ...existing, displayName };
      }
      return existing;
    }

    const principalId = `principal_${crypto.randomUUID()}`;
    const now = nowMs();
    try {
      await this.db.prepare(
        `INSERT INTO principals (
           id, primary_email, primary_email_normalized, display_name,
           email_verified_at, state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, NULL, 'pending', ?, ?)`,
      ).bind(
        principalId,
        input.email.trim(),
        normalizedEmail,
        displayName,
        now,
        now,
      ).run();
    } catch (error) {
      const raced = await this.getPrincipalByEmail(normalizedEmail);
      if (raced && raced.state !== "disabled") return raced;
      throw error;
    }
    return {
      id: principalId,
      email: input.email.trim(),
      displayName,
      state: "pending",
      emailVerifiedAt: null,
    };
  }

  async issueEmailVerification(principalIdValue: string): Promise<{
    token: string;
    expiresAt: number;
  }> {
    const principalId = parseOpaqueId(principalIdValue, "principalId");
    const principal = await this.getPrincipal(principalId);
    if (!principal || principal.state !== "pending") {
      throw new Error("pending principal is required");
    }
    const token = await createOpaqueToken("gsvverify");
    const now = nowMs();
    const expiresAt = now + EMAIL_VERIFICATION_TTL_MS;
    await this.db.batch([
      this.db.prepare(
        `UPDATE verification_and_recovery_tokens
         SET used_at = ?
         WHERE principal_id = ? AND purpose = 'verify_email' AND used_at IS NULL`,
      ).bind(now, principalId),
      this.db.prepare(
        `INSERT INTO verification_and_recovery_tokens (
           token_prefix, token_hash, principal_id, purpose,
           payload_json, expires_at, used_at
         ) VALUES (?, ?, ?, 'verify_email', NULL, ?, NULL)`,
      ).bind(token.prefix, token.hash, principalId, expiresAt),
      this.auditStatement({
        principalId,
        action: "auth.email_verification_requested",
        outcome: "accepted",
        now,
      }),
    ]);
    return { token: token.raw, expiresAt };
  }

  async consumeEmailVerification(input: {
    token: string;
    ipHash?: string;
    userAgent?: string;
  }): Promise<IssuedPlatformSession> {
    const prefix = tokenPrefix(input.token);
    const hash = await sha256Hex(input.token);
    const now = nowMs();
    const candidate = await this.db.prepare(
      `SELECT token_hash, principal_id, expires_at, used_at
       FROM verification_and_recovery_tokens
       WHERE token_prefix = ? AND purpose = 'verify_email'
       LIMIT 1`,
    ).bind(prefix).first<VerificationTokenRow>();
    if (
      !candidate
      || candidate.used_at !== null
      || candidate.expires_at <= now
      || !constantTimeEqual(candidate.token_hash, hash)
    ) {
      throw new Error("verification token is invalid or expired");
    }

    const issued = await createOpaqueToken("gsvsession");
    const expiresAt = now + BOOTSTRAP_SESSION_TTL_MS;
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO sessions (
           id_hash, principal_id, created_at, expires_at, recent_auth_at,
           revoked_at, ip_hash, user_agent, auth_method
         )
         SELECT ?, v.principal_id, ?, ?, ?, NULL, ?, ?, 'email_verification'
         FROM verification_and_recovery_tokens v
         JOIN principals p ON p.id = v.principal_id
         WHERE v.token_prefix = ? AND v.token_hash = ?
           AND v.purpose = 'verify_email' AND v.used_at IS NULL
           AND v.expires_at > ? AND p.state IN ('pending', 'active')`,
      ).bind(
        issued.hash,
        now,
        expiresAt,
        now,
        input.ipHash ?? null,
        normalizeUserAgent(input.userAgent),
        prefix,
        hash,
        now,
      ),
      this.db.prepare(
        `UPDATE principals
         SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ?
         WHERE id = ? AND state IN ('pending', 'active')
           AND EXISTS (
             SELECT 1 FROM verification_and_recovery_tokens v
             WHERE v.token_prefix = ? AND v.token_hash = ?
               AND v.used_at IS NULL AND v.expires_at > ?
           )`,
      ).bind(now, now, candidate.principal_id, prefix, hash, now),
      this.db.prepare(
        `UPDATE verification_and_recovery_tokens
         SET used_at = ?
         WHERE token_prefix = ? AND token_hash = ?
           AND purpose = 'verify_email' AND used_at IS NULL AND expires_at > ?`,
      ).bind(now, prefix, hash, now),
      this.sessionAuditStatement({
        principalId: candidate.principal_id,
        action: "auth.email_verified",
        outcome: "succeeded",
        now,
      }, issued.hash),
    ]);
    if (changes(results[0]) !== 1 || changes(results[2]) !== 1) {
      throw new Error("verification token is invalid or expired");
    }
    const principal = await this.requirePrincipal(candidate.principal_id);
    return {
      token: issued.raw,
      principal,
      sessionHash: issued.hash,
      authMethod: "email_verification",
      recentAuthAt: now,
      expiresAt,
    };
  }

  async authenticateSession(token: string): Promise<PlatformSession | null> {
    let hash: string;
    try {
      tokenPrefix(token);
      hash = await sha256Hex(token);
    } catch {
      return null;
    }
    const row = await this.db.prepare(
      `SELECT
         s.id_hash, s.auth_method, s.recent_auth_at, s.expires_at, s.revoked_at,
         p.id, p.primary_email, p.display_name, p.state, p.email_verified_at
       FROM sessions s
       JOIN principals p ON p.id = s.principal_id
       WHERE s.id_hash = ?
       LIMIT 1`,
    ).bind(hash).first<SessionRow>();
    if (
      !row
      || row.revoked_at !== null
      || row.expires_at <= nowMs()
      || (
        row.state !== "active"
        && row.state !== "recovery"
        && !(
          row.state === "pending"
          && row.auth_method === "email_verification"
          && row.email_verified_at !== null
        )
      )
    ) {
      return null;
    }
    return {
      principal: principalFromRow(row),
      sessionHash: row.id_hash,
      authMethod: row.auth_method,
      recentAuthAt: row.recent_auth_at,
      expiresAt: row.expires_at,
    };
  }

  async revokeSession(token: string): Promise<boolean> {
    let hash: string;
    try {
      hash = await sha256Hex(token);
    } catch {
      return false;
    }
    const result = await this.db.prepare(
      "UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL",
    ).bind(nowMs(), hash).run();
    return changes(result) === 1;
  }

  async consumeRecoveryCode(input: {
    email: string;
    code: string;
    ipHash?: string;
    userAgent?: string;
  }): Promise<IssuedPlatformSession> {
    const email = normalizeEmail(input.email);
    const normalizedCode = normalizeRecoveryCode(input.code);
    const hash = await sha256Hex(normalizedCode);
    const lookupKey = hash.slice(0, 24);
    const now = nowMs();
    const candidate = await this.db.prepare(
      `SELECT c.id, c.principal_id, c.secret_hash
       FROM credentials c
       JOIN principals p ON p.id = c.principal_id
       WHERE c.kind = 'recovery_code' AND c.lookup_key = ?
         AND c.revoked_at IS NULL AND p.primary_email_normalized = ?
         AND p.state IN ('active', 'recovery')
       LIMIT 1`,
    ).bind(lookupKey, email).first<{
      id: string;
      principal_id: string;
      secret_hash: string;
    }>();
    if (!candidate || !constantTimeEqual(candidate.secret_hash, hash)) {
      throw new Error("recovery code is invalid");
    }

    const useNonce = crypto.randomUUID();
    const session = await createOpaqueToken("gsvsession");
    const expiresAt = now + BOOTSTRAP_SESSION_TTL_MS;
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE credentials
         SET revoked_at = ?, last_used_at = ?, last_use_nonce = ?
         WHERE id = ? AND kind = 'recovery_code'
           AND secret_hash = ? AND revoked_at IS NULL`,
      ).bind(now, now, useNonce, candidate.id, hash),
      this.db.prepare(
        `UPDATE credentials
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE principal_id = ? AND kind = 'recovery_code'
           AND EXISTS (
             SELECT 1 FROM credentials WHERE id = ? AND last_use_nonce = ?
           )`,
      ).bind(now, candidate.principal_id, candidate.id, useNonce),
      this.db.prepare(
        `UPDATE sessions
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE principal_id = ?
           AND EXISTS (
             SELECT 1 FROM credentials WHERE id = ? AND last_use_nonce = ?
           )`,
      ).bind(now, candidate.principal_id, candidate.id, useNonce),
      this.db.prepare(
        `UPDATE credentials
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE principal_id = ? AND kind = 'passkey'
           AND EXISTS (
             SELECT 1 FROM credentials WHERE id = ? AND last_use_nonce = ?
           )`,
      ).bind(now, candidate.principal_id, candidate.id, useNonce),
      this.db.prepare(
        `UPDATE principals
         SET state = 'recovery', updated_at = ?
         WHERE id = ? AND state IN ('active', 'recovery')
           AND EXISTS (
             SELECT 1 FROM credentials WHERE id = ? AND last_use_nonce = ?
           )`,
      ).bind(now, candidate.principal_id, candidate.id, useNonce),
      this.db.prepare(
        `INSERT INTO sessions (
           id_hash, principal_id, created_at, expires_at, recent_auth_at,
           revoked_at, ip_hash, user_agent, auth_method
         )
         SELECT ?, ?, ?, ?, ?, NULL, ?, ?, 'recovery'
         FROM credentials
         WHERE id = ? AND last_use_nonce = ?`,
      ).bind(
        session.hash,
        candidate.principal_id,
        now,
        expiresAt,
        now,
        input.ipHash ?? null,
        normalizeUserAgent(input.userAgent),
        candidate.id,
        useNonce,
      ),
      this.sessionAuditStatement({
        principalId: candidate.principal_id,
        action: "auth.recovery_code_consumed",
        outcome: "succeeded",
        now,
      }, session.hash),
    ]);
    if (changes(results[0]) !== 1 || changes(results[5]) !== 1) {
      throw new Error("recovery code is invalid");
    }
    return {
      token: session.raw,
      principal: await this.requirePrincipal(candidate.principal_id),
      sessionHash: session.hash,
      authMethod: "recovery",
      recentAuthAt: now,
      expiresAt,
    };
  }

  async createWebAuthnChallenge(input: {
    principalId?: string;
    sessionHash?: string;
    kind: WebAuthnChallenge["kind"];
    challenge: string;
  }): Promise<WebAuthnChallenge> {
    const now = nowMs();
    const id = `challenge_${crypto.randomUUID()}`;
    const principalId = input.principalId
      ? parseOpaqueId(input.principalId, "principalId")
      : null;
    const sessionHash = input.sessionHash ?? null;
    if (
      !input.challenge
      || (input.kind === "registration" && (!principalId || !sessionHash))
      || (input.kind === "authentication" && sessionHash !== null)
    ) {
      throw new Error("WebAuthn challenge input is invalid");
    }
    const expiresAt = now + WEBAUTHN_CHALLENGE_TTL_MS;
    await this.db.prepare(
      `INSERT INTO webauthn_challenges (
         id, principal_id, session_id_hash, kind, challenge,
         created_at, expires_at, used_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).bind(
      id,
      principalId,
      sessionHash,
      input.kind,
      input.challenge,
      now,
      expiresAt,
    ).run();
    return {
      id,
      principalId,
      sessionHash,
      kind: input.kind,
      challenge: input.challenge,
      expiresAt,
    };
  }

  async getWebAuthnChallenge(
    challengeIdValue: string,
    kind: WebAuthnChallenge["kind"],
  ): Promise<WebAuthnChallenge | null> {
    const challengeId = parseOpaqueId(challengeIdValue, "challengeId");
    const row = await this.db.prepare(
      `SELECT id, principal_id, session_id_hash, kind, challenge, expires_at
       FROM webauthn_challenges
       WHERE id = ? AND kind = ? AND used_at IS NULL AND expires_at > ?
       LIMIT 1`,
    ).bind(challengeId, kind, nowMs()).first<{
      id: string;
      principal_id: string | null;
      session_id_hash: string | null;
      kind: WebAuthnChallenge["kind"];
      challenge: string;
      expires_at: number;
    }>();
    return row ? {
      id: row.id,
      principalId: row.principal_id,
      sessionHash: row.session_id_hash,
      kind: row.kind,
      challenge: row.challenge,
      expiresAt: row.expires_at,
    } : null;
  }

  async listPasskeys(principalIdValue: string): Promise<StoredPasskey[]> {
    const principalId = parseOpaqueId(principalIdValue, "principalId");
    const rows = await this.db.prepare(
      `SELECT lookup_key, principal_id, public_data_json
       FROM credentials
       WHERE principal_id = ? AND kind = 'passkey' AND revoked_at IS NULL
       ORDER BY created_at`,
    ).bind(principalId).all<{
      lookup_key: string;
      principal_id: string;
      public_data_json: string;
    }>();
    return rows.results.map(passkeyFromRow);
  }

  async getPasskey(credentialId: string): Promise<StoredPasskey | null> {
    if (!credentialId || credentialId.length > 1024) return null;
    const row = await this.db.prepare(
      `SELECT lookup_key, principal_id, public_data_json
       FROM credentials
       WHERE kind = 'passkey' AND lookup_key = ? AND revoked_at IS NULL
       LIMIT 1`,
    ).bind(credentialId).first<{
      lookup_key: string;
      principal_id: string;
      public_data_json: string;
    }>();
    return row ? passkeyFromRow(row) : null;
  }

  async commitPasskeyRegistration(input: {
    challenge: WebAuthnChallenge;
    session: PlatformSession;
    credential: WebAuthnCredential;
    deviceType: CredentialDeviceType;
    backedUp: boolean;
  }): Promise<{ recoveryCodes: string[]; expiresAt: number }> {
    if (
      input.challenge.kind !== "registration"
      || input.challenge.principalId !== input.session.principal.id
      || input.challenge.sessionHash !== input.session.sessionHash
    ) {
      throw new Error("WebAuthn registration challenge does not match the session");
    }
    const now = nowMs();
    const credentialId = input.credential.id;
    const useNonce = crypto.randomUUID();
    const credentialData = serializePasskey({
      publicKey: input.credential.publicKey,
      counter: input.credential.counter,
      transports: input.credential.transports,
      deviceType: input.deviceType,
      backedUp: input.backedUp,
    });
    const credentialRecordId = `credential_${crypto.randomUUID()}`;
    const expiresAt = now + PLATFORM_SESSION_TTL_MS;
    const recoveryGenerationNonce = crypto.randomUUID();
    const recoveryCodes = await Promise.all(
      Array.from({ length: 10 }, () => createRecoveryCode()),
    );
    const statements: D1PreparedStatement[] = [
      this.db.prepare(
        `UPDATE webauthn_challenges
         SET used_at = ?, use_nonce = ?
         WHERE id = ? AND kind = 'registration' AND used_at IS NULL
           AND expires_at > ? AND principal_id = ? AND session_id_hash = ?`,
      ).bind(
        now,
        useNonce,
        input.challenge.id,
        now,
        input.session.principal.id,
        input.session.sessionHash,
      ),
      this.db.prepare(
        `UPDATE credentials
         SET revoked_at = ?
         WHERE principal_id = ? AND kind = 'passkey' AND revoked_at IS NULL
           AND EXISTS (
             SELECT 1 FROM principals
             WHERE id = ? AND state = 'recovery'
           )
           AND EXISTS (
             SELECT 1 FROM webauthn_challenges WHERE id = ? AND use_nonce = ?
           )`,
      ).bind(
        now,
        input.session.principal.id,
        input.session.principal.id,
        input.challenge.id,
        useNonce,
      ),
      this.db.prepare(
        `INSERT INTO credentials (
           id, principal_id, kind, lookup_key, public_data_json,
           secret_hash, created_at, last_used_at, revoked_at
         )
         SELECT ?, ?, 'passkey', ?, ?, NULL, ?, NULL, NULL
         FROM webauthn_challenges c
         JOIN sessions s ON s.id_hash = ? AND s.revoked_at IS NULL
         WHERE c.id = ? AND c.use_nonce = ?`,
      ).bind(
        credentialRecordId,
        input.session.principal.id,
        credentialId,
        credentialData,
        now,
        input.session.sessionHash,
        input.challenge.id,
        useNonce,
      ),
      this.db.prepare(
        `INSERT OR IGNORE INTO recovery_code_sets (
           principal_id, generation, generation_nonce, created_at
         )
         SELECT ?, 1, ?, ?
         FROM credentials
         WHERE id = ?`,
      ).bind(
        input.session.principal.id,
        recoveryGenerationNonce,
        now,
        credentialRecordId,
      ),
      this.db.prepare(
        `UPDATE recovery_code_sets
         SET generation = generation + 1, generation_nonce = ?, created_at = ?
         WHERE principal_id = ? AND generation_nonce != ?
           AND EXISTS (
             SELECT 1 FROM principals WHERE id = ? AND state = 'recovery'
           )
           AND EXISTS (
             SELECT 1 FROM credentials WHERE id = ?
           )`,
      ).bind(
        recoveryGenerationNonce,
        now,
        input.session.principal.id,
        recoveryGenerationNonce,
        input.session.principal.id,
        credentialRecordId,
      ),
    ];
    for (const code of recoveryCodes) {
      statements.push(this.db.prepare(
        `INSERT INTO credentials (
           id, principal_id, kind, lookup_key, public_data_json,
           secret_hash, created_at, last_used_at, revoked_at, last_use_nonce
         )
         SELECT ?, ?, 'recovery_code', ?, NULL, ?, ?, NULL, NULL, NULL
         FROM recovery_code_sets
         WHERE principal_id = ? AND generation_nonce = ?
           AND EXISTS (SELECT 1 FROM credentials WHERE id = ?)`,
      ).bind(
        `credential_${crypto.randomUUID()}`,
        input.session.principal.id,
        code.lookupKey,
        code.hash,
        now,
        input.session.principal.id,
        recoveryGenerationNonce,
        credentialRecordId,
      ));
    }
    statements.push(
      this.db.prepare(
        `UPDATE principals
         SET state = 'active', updated_at = ?
         WHERE id = ? AND state IN ('pending', 'active', 'recovery')
           AND EXISTS (SELECT 1 FROM credentials WHERE id = ?)`,
      ).bind(now, input.session.principal.id, credentialRecordId),
      this.db.prepare(
        `UPDATE sessions
         SET auth_method = 'passkey', recent_auth_at = ?, expires_at = ?
         WHERE id_hash = ? AND revoked_at IS NULL
           AND EXISTS (SELECT 1 FROM credentials WHERE id = ?)`,
      ).bind(now, expiresAt, input.session.sessionHash, credentialRecordId),
      this.credentialAuditStatement({
        principalId: input.session.principal.id,
        action: "auth.passkey_registered",
        outcome: "succeeded",
        now,
      }, credentialRecordId),
    );
    const results = await this.db.batch(statements);
    const recoveryResultStart = 5;
    const sessionResultIndex = recoveryResultStart + recoveryCodes.length + 1;
    if (
      changes(results[0]) !== 1
      || changes(results[2]) !== 1
      || changes(results[sessionResultIndex]) !== 1
    ) {
      throw new Error("WebAuthn registration challenge is invalid or already used");
    }
    return {
      expiresAt,
      recoveryCodes: recoveryCodes
        .filter((_code, index) => changes(results[recoveryResultStart + index]) === 1)
        .map((code) => code.raw),
    };
  }

  async commitPasskeyAuthentication(input: {
    challenge: WebAuthnChallenge;
    passkey: StoredPasskey;
    newCounter: number;
    deviceType: CredentialDeviceType;
    backedUp: boolean;
    ipHash?: string;
    userAgent?: string;
  }): Promise<IssuedPlatformSession> {
    if (input.challenge.kind !== "authentication") {
      throw new Error("WebAuthn authentication challenge is invalid");
    }
    const principal = await this.requirePrincipal(input.passkey.principalId);
    if (principal.state !== "active") {
      throw new Error("principal is unavailable");
    }
    const now = nowMs();
    const useNonce = crypto.randomUUID();
    const session = await createOpaqueToken("gsvsession");
    const expiresAt = now + PLATFORM_SESSION_TTL_MS;
    const publicData = serializePasskey({
      publicKey: input.passkey.publicKey,
      counter: input.newCounter,
      transports: input.passkey.transports,
      deviceType: input.deviceType,
      backedUp: input.backedUp,
    });
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE webauthn_challenges
         SET used_at = ?, use_nonce = ?
         WHERE id = ? AND kind = 'authentication'
           AND used_at IS NULL AND expires_at > ?`,
      ).bind(now, useNonce, input.challenge.id, now),
      this.db.prepare(
        `UPDATE credentials
         SET public_data_json = ?, last_used_at = ?, last_use_nonce = ?
         WHERE principal_id = ? AND kind = 'passkey' AND lookup_key = ?
           AND revoked_at IS NULL
           AND CAST(json_extract(public_data_json, '$.counter') AS INTEGER) = ?
           AND EXISTS (
             SELECT 1 FROM webauthn_challenges WHERE id = ? AND use_nonce = ?
           )`,
      ).bind(
        publicData,
        now,
        useNonce,
        principal.id,
        input.passkey.credentialId,
        input.passkey.counter,
        input.challenge.id,
        useNonce,
      ),
      this.db.prepare(
        `INSERT INTO sessions (
           id_hash, principal_id, created_at, expires_at, recent_auth_at,
           revoked_at, ip_hash, user_agent, auth_method
         )
         SELECT ?, ?, ?, ?, ?, NULL, ?, ?, 'passkey'
         FROM webauthn_challenges c
         JOIN credentials p
           ON p.principal_id = ? AND p.kind = 'passkey' AND p.lookup_key = ?
         WHERE c.id = ? AND c.use_nonce = ? AND p.last_use_nonce = ?`,
      ).bind(
        session.hash,
        principal.id,
        now,
        expiresAt,
        now,
        input.ipHash ?? null,
        normalizeUserAgent(input.userAgent),
        principal.id,
        input.passkey.credentialId,
        input.challenge.id,
        useNonce,
        useNonce,
      ),
      this.sessionAuditStatement({
        principalId: principal.id,
        action: "auth.passkey_authenticated",
        outcome: "succeeded",
        now,
      }, session.hash),
    ]);
    if (
      changes(results[0]) !== 1
      || changes(results[1]) !== 1
      || changes(results[2]) !== 1
    ) {
      throw new Error("WebAuthn authentication challenge is invalid or already used");
    }
    return {
      token: session.raw,
      principal,
      sessionHash: session.hash,
      authMethod: "passkey",
      recentAuthAt: now,
      expiresAt,
    };
  }

  async createLoginHandoff(input: {
    principalId: string;
    installationId: string;
  }): Promise<{ token: string; canonicalOrigin: string; expiresAt: number }> {
    const principalId = parseOpaqueId(input.principalId, "principalId");
    const installationId = parseOpaqueId(input.installationId, "installationId");
    const target = await this.db.prepare(
      `SELECT i.canonical_origin, m.local_uid
       FROM memberships m
       JOIN installations i ON i.id = m.installation_id
       WHERE m.principal_id = ? AND m.installation_id = ?
         AND m.state = 'active' AND m.local_uid IS NOT NULL
         AND i.state IN ('trialing', 'active', 'past_due', 'restricted', 'cancelled', 'retained')
       LIMIT 1`,
    ).bind(principalId, installationId).first<{
      canonical_origin: string;
      local_uid: number;
    }>();
    if (!target) throw new Error("installation membership is unavailable");
    const token = await createOpaqueToken("gsvhandoff");
    const now = nowMs();
    const expiresAt = now + LOGIN_HANDOFF_TTL_MS;
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO login_handoffs (
           token_prefix, token_hash, principal_id, installation_id,
           local_uid, expires_at, used_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      ).bind(
        token.prefix,
        token.hash,
        principalId,
        installationId,
        target.local_uid,
        expiresAt,
      ),
      this.auditStatement({
        principalId,
        installationId,
        action: "installation.login_handoff_issued",
        outcome: "succeeded",
        now,
      }),
    ]);
    return {
      token: token.raw,
      canonicalOrigin: target.canonical_origin,
      expiresAt,
    };
  }

  async consumeLoginHandoff(
    rawToken: string,
    hostnameValue: string,
  ): Promise<LoginHandoffVerificationResult> {
    let prefix: string;
    let hash: string;
    try {
      prefix = tokenPrefix(rawToken);
      hash = await sha256Hex(rawToken);
    } catch {
      return { ok: false };
    }
    const hostname = normalizeHostname(hostnameValue);
    if (!hostname) return { ok: false };
    const now = nowMs();
    const useNonce = crypto.randomUUID();
    const candidate = await this.db.prepare(
      `SELECT token_hash, principal_id, expires_at, used_at
       FROM login_handoffs
       WHERE token_prefix = ?
       LIMIT 1`,
    ).bind(prefix).first<VerificationTokenRow>();
    if (
      !candidate
      || candidate.used_at !== null
      || candidate.expires_at <= now
      || !constantTimeEqual(candidate.token_hash, hash)
    ) {
      return { ok: false };
    }
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE login_handoffs
       SET used_at = ?, use_nonce = ?
       WHERE token_prefix = ? AND token_hash = ?
         AND used_at IS NULL AND expires_at > ?
         AND EXISTS (
           SELECT 1
           FROM hostnames h
           JOIN memberships m
             ON m.installation_id = login_handoffs.installation_id
            AND m.principal_id = login_handoffs.principal_id
           JOIN installations i ON i.id = login_handoffs.installation_id
           WHERE h.normalized_hostname = ?
             AND h.installation_id = login_handoffs.installation_id
             AND h.state = 'active'
             AND m.state = 'active'
             AND m.local_uid = login_handoffs.local_uid
             AND i.state IN ('trialing', 'active', 'past_due', 'restricted', 'cancelled', 'retained')
         )
       RETURNING installation_id, principal_id, local_uid`,
      ).bind(now, useNonce, prefix, hash, now, hostname),
      this.db.prepare(
        `INSERT INTO audit_events (
           id, principal_id, installation_id, action, outcome, created_at, metadata_json
         )
         SELECT ?, principal_id, installation_id,
                'installation.login_handoff_consumed', 'succeeded', ?, '{}'
         FROM login_handoffs
         WHERE token_prefix = ? AND token_hash = ? AND use_nonce = ?`,
      ).bind(`audit_${crypto.randomUUID()}`, now, prefix, hash, useNonce),
    ]);
    const result = results[0]?.results[0] as {
      installation_id: string;
      principal_id: string;
      local_uid: number;
    } | undefined;
    if (!result) return { ok: false };
    return {
      ok: true,
      installationId: result.installation_id,
      principalId: result.principal_id,
      localUid: result.local_uid,
    };
  }

  async getPrincipal(principalIdValue: string): Promise<PlatformPrincipal | null> {
    const principalId = parseOpaqueId(principalIdValue, "principalId");
    const row = await this.db.prepare(
      `SELECT id, primary_email, display_name, state, email_verified_at
       FROM principals WHERE id = ? LIMIT 1`,
    ).bind(principalId).first<PrincipalRow>();
    return row ? principalFromRow(row) : null;
  }

  async getPrincipalByEmail(emailValue: string): Promise<PlatformPrincipal | null> {
    const email = normalizeEmail(emailValue);
    const row = await this.db.prepare(
      `SELECT id, primary_email, display_name, state, email_verified_at
       FROM principals WHERE primary_email_normalized = ? LIMIT 1`,
    ).bind(email).first<PrincipalRow>();
    return row ? principalFromRow(row) : null;
  }

  private async requirePrincipal(principalId: string): Promise<PlatformPrincipal> {
    const principal = await this.getPrincipal(principalId);
    if (!principal) throw new Error("principal is unavailable");
    return principal;
  }

  private auditStatement(input: {
    principalId?: string;
    installationId?: string;
    action: string;
    outcome: string;
    now: number;
  }): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO audit_events (
         id, principal_id, installation_id, action, outcome, created_at, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, '{}')`,
    ).bind(
      `audit_${crypto.randomUUID()}`,
      input.principalId ?? null,
      input.installationId ?? null,
      input.action,
      input.outcome,
      input.now,
    );
  }

  private credentialAuditStatement(input: {
    principalId: string;
    action: string;
    outcome: string;
    now: number;
  }, credentialId: string): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO audit_events (
         id, principal_id, installation_id, action, outcome, created_at, metadata_json
       )
       SELECT ?, ?, NULL, ?, ?, ?, '{}'
       FROM credentials
       WHERE id = ?`,
    ).bind(
      `audit_${crypto.randomUUID()}`,
      input.principalId,
      input.action,
      input.outcome,
      input.now,
      credentialId,
    );
  }

  private sessionAuditStatement(input: {
    principalId: string;
    action: string;
    outcome: string;
    now: number;
  }, sessionHash: string): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO audit_events (
         id, principal_id, installation_id, action, outcome, created_at, metadata_json
       )
       SELECT ?, ?, NULL, ?, ?, ?, '{}'
       FROM sessions
       WHERE id_hash = ?`,
    ).bind(
      `audit_${crypto.randomUUID()}`,
      input.principalId,
      input.action,
      input.outcome,
      input.now,
      sessionHash,
    );
  }
}

function principalFromRow(row: PrincipalRow): PlatformPrincipal {
  return {
    id: row.id,
    email: row.primary_email,
    displayName: row.display_name,
    state: row.state,
    emailVerifiedAt: row.email_verified_at,
  };
}

function parseDisplayName(value: string): string {
  const displayName = value.trim();
  if (!displayName || displayName.length > 100) {
    throw new Error("displayName is invalid");
  }
  return displayName;
}

function normalizeUserAgent(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 256) : null;
}

function normalizeHostname(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized.length > 253) return null;
  try {
    const url = new URL(`https://${normalized}`);
    return url.hostname === normalized && !url.port ? normalized : null;
  } catch {
    return null;
  }
}

function serializePasskey(input: {
  publicKey: Uint8Array;
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  deviceType: CredentialDeviceType;
  backedUp: boolean;
}): string {
  if (!Number.isSafeInteger(input.counter) || input.counter < 0) {
    throw new Error("passkey counter is invalid");
  }
  return JSON.stringify({
    publicKey: base64UrlEncode(input.publicKey),
    counter: input.counter,
    ...(input.transports ? { transports: input.transports } : {}),
    deviceType: input.deviceType,
    backedUp: input.backedUp,
  } satisfies StoredPasskeyData);
}

function passkeyFromRow(row: {
  lookup_key: string;
  principal_id: string;
  public_data_json: string;
}): StoredPasskey {
  let data: StoredPasskeyData;
  try {
    data = JSON.parse(row.public_data_json) as StoredPasskeyData;
  } catch {
    throw new Error("stored passkey data is invalid");
  }
  if (
    !data
    || typeof data.publicKey !== "string"
    || !Number.isSafeInteger(data.counter)
    || data.counter < 0
    || (data.deviceType !== "singleDevice" && data.deviceType !== "multiDevice")
    || typeof data.backedUp !== "boolean"
  ) {
    throw new Error("stored passkey data is invalid");
  }
  return {
    credentialId: row.lookup_key,
    principalId: row.principal_id,
    publicKey: base64UrlDecode(data.publicKey),
    counter: data.counter,
    transports: data.transports,
    deviceType: data.deviceType,
    backedUp: data.backedUp,
  };
}

function changes(result: D1Result<unknown>): number {
  return result.meta.changes ?? 0;
}
