import type {
  AuthorizeInstallationOnboardingInput,
  CompleteInstallationOnboardingInput,
  CompleteInstallationOnboardingResult,
  InstallationOnboardingAuthorization,
} from "@humansandmachines/gsv/services/onboarding";
import type { InstallationIdentity } from "@humansandmachines/gsv/services/directory";
import { parseOpaqueId } from "./domain";
import { AccountStore } from "./store";
import {
  constantTimeEqual,
  createOpaqueToken,
  sha256Hex,
  tokenPrefix,
  type OpaqueToken,
} from "./tokens";

const ONBOARDING_TOKEN_TTL_MS = 60 * 60 * 1000;

export type IssuedInstallationOnboarding = {
  installationId: string;
  onboardingUrl: string;
  expiresAt: number;
};

type OnboardingClaimRow = {
  id: string;
  token_hash: string;
  installation_id: string;
  handle: string;
  canonical_origin: string;
};

export class InstallationOnboardingStore {
  constructor(
    private readonly db: D1Database,
    private readonly accounts: AccountStore,
    private readonly resumeSecret?: string,
  ) {}

  async begin(
    installationIdValue: string,
    now = Date.now(),
  ): Promise<IssuedInstallationOnboarding> {
    const installationId = parseOpaqueId(installationIdValue, "installationId");
    const operation = await this.db.prepare(
      `SELECT p.operation_id, p.principal_id, p.state
       FROM provisioning_operations p
       JOIN installations i ON i.id = p.installation_id
       WHERE p.installation_id = ? AND p.kind = 'create'
         AND i.state IN ('reserved', 'provisioning')
       LIMIT 1`,
    ).bind(installationId).first<{
      operation_id: string;
      principal_id: string;
      state: "reserved" | "provisioning";
    }>();
    if (!operation) throw new Error("installation is not awaiting onboarding");
    if (operation.state === "reserved") {
      await this.accounts.beginProvisioning(
        operation.operation_id,
        operation.principal_id,
      );
    }
    return await this.issue(installationId, now, Boolean(this.resumeSecret));
  }

  async issue(
    installationIdValue: string,
    now = Date.now(),
    resume = false,
  ): Promise<IssuedInstallationOnboarding> {
    const installationId = parseOpaqueId(installationIdValue, "installationId");
    const installation = await this.db.prepare(
      `SELECT i.id, i.handle, i.canonical_origin, c.id AS claim_id, c.token_hash,
         c.created_at, c.expires_at, c.revoked_at, c.completed_at
       FROM installations i
       JOIN provisioning_operations p
         ON p.installation_id = i.id AND p.kind = 'create'
       LEFT JOIN installation_onboarding_claims c ON c.installation_id = i.id
       WHERE i.id = ? AND i.state = 'provisioning'
         AND p.state = 'provisioning'
       LIMIT 1`,
    ).bind(installationId).first<{
      id: string;
      handle: string;
      canonical_origin: string;
      claim_id: string | null;
      token_hash: string | null;
      created_at: number | null;
      expires_at: number | null;
      revoked_at: number | null;
      completed_at: number | null;
    }>();
    if (!installation) throw new Error("installation is not awaiting onboarding");

    const urlFor = (raw: string) => {
      const url = new URL("/onboarding", installation.canonical_origin);
      url.hash = raw;
      return url.toString();
    };
    if (resume && installation.claim_id && installation.expires_at! > now
      && installation.revoked_at === null && installation.completed_at === null) {
      const token = await this.resumeToken(installationId, installation.claim_id, installation.created_at!, installation.expires_at!);
      if (constantTimeEqual(token.hash, installation.token_hash!)) {
        return { installationId, onboardingUrl: urlFor(token.raw), expiresAt: installation.expires_at! };
      }
    }
    // The Kernel retains this claim across activation retries; reissue only rotates its bearer.
    const claimId = installation.claim_id ?? `onboarding_${crypto.randomUUID()}`;
    const createdAt = Math.max(now, (installation.created_at ?? 0) + 1);
    const expiresAt = now + ONBOARDING_TOKEN_TTL_MS;
    const token = resume ? await this.resumeToken(installationId, claimId, createdAt, expiresAt) : await createOpaqueToken("onboard");
    const result = await this.db.prepare(
      `INSERT INTO installation_onboarding_claims (
         id, installation_id, token_prefix, token_hash,
         expires_at, completed_at, revoked_at, created_at, issuer_version
       ) SELECT ?, i.id, ?, ?, ?, NULL, NULL, ?, 1
         FROM installations i JOIN provisioning_operations p ON p.installation_id = i.id AND p.kind = 'create'
         WHERE i.id = ? AND i.state = 'provisioning' AND p.state = 'provisioning'
       ON CONFLICT (installation_id) DO UPDATE SET
         token_prefix = excluded.token_prefix,
         token_hash = excluded.token_hash,
         expires_at = excluded.expires_at,
         completed_at = NULL,
         revoked_at = NULL,
         created_at = excluded.created_at,
         issuer_version = excluded.issuer_version
       WHERE ? = 0 OR installation_onboarding_claims.token_hash = ?`,
    ).bind(
      claimId,
      token.prefix,
      token.hash,
      expiresAt,
      createdAt,
      installationId,
      resume ? 1 : 0,
      installation.token_hash,
    ).run();
    if ((result.meta.changes ?? 0) !== 1) {
      if (resume) {
        const current = await this.db.prepare(`SELECT c.id, c.token_hash, c.created_at, c.expires_at
          FROM installation_onboarding_claims c JOIN installations i ON i.id = c.installation_id
          WHERE c.installation_id = ? AND c.completed_at IS NULL AND c.revoked_at IS NULL
            AND c.expires_at > ? AND i.state = 'provisioning'`)
          .bind(installationId, now).first<{ id: string; token_hash: string; created_at: number; expires_at: number }>();
        if (current) {
          const accepted = await this.resumeToken(installationId, current.id, current.created_at, current.expires_at);
          if (constantTimeEqual(accepted.hash, current.token_hash)) {
            return { installationId, onboardingUrl: urlFor(accepted.raw), expiresAt: current.expires_at };
          }
        }
      }
      throw new Error("installation is not awaiting onboarding");
    }

    return {
      installationId,
      onboardingUrl: urlFor(token.raw),
      expiresAt,
    };
  }

  /** A stable server secret recreates a live bearer without storing it in D1. */
  private async resumeToken(installationId: string, claimId: string, createdAt: number, expiresAt: number): Promise<OpaqueToken> {
    if (!this.resumeSecret) throw new Error("Owner setup authorization is not configured");
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(this.resumeSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(["installation-onboarding-v1", installationId, claimId, createdAt, expiresAt])));
    const raw = `onboard_${btoa(String.fromCharCode(...new Uint8Array(signature))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
    return { raw, prefix: raw.slice(0, 16), hash: await sha256Hex(raw) };
  }

  /** Bootstrap retries retain one pre-generated claim; they never reissue it. */
  async prepare(installationIdValue: string, input: {
    claimId: string; tokenPrefix: string; tokenHash: string; expiresAt: number;
  }, now = Date.now()): Promise<boolean> {
    const installationId = parseOpaqueId(installationIdValue, "installationId");
    await this.db.prepare(
      `INSERT INTO installation_onboarding_claims (
         id, installation_id, token_prefix, token_hash, expires_at, completed_at, revoked_at, created_at, issuer_version
       ) SELECT ?, i.id, ?, ?, ?, NULL, NULL, ?, 1
       FROM installations i JOIN provisioning_operations p ON p.installation_id = i.id AND p.kind = 'create'
       WHERE i.id = ? AND i.state = 'provisioning' AND p.state = 'provisioning'
       ON CONFLICT (installation_id) DO NOTHING`,
    ).bind(input.claimId, input.tokenPrefix, input.tokenHash, input.expiresAt, now, installationId).run();
    const claim = await this.db.prepare(
      `SELECT token_hash, completed_at, revoked_at, expires_at
       FROM installation_onboarding_claims WHERE installation_id = ? AND id = ?`,
    ).bind(installationId, input.claimId).first<{
      token_hash: string; completed_at: number | null; revoked_at: number | null; expires_at: number;
    }>();
    return Boolean(claim && constantTimeEqual(claim.token_hash, input.tokenHash)
      && claim.completed_at === null && claim.revoked_at === null && claim.expires_at > now);
  }

  async authorize(
    input: AuthorizeInstallationOnboardingInput,
    now = Date.now(),
  ): Promise<InstallationOnboardingAuthorization> {
    let installationId: string;
    let prefix: string;
    try {
      installationId = parseOpaqueId(input?.installationId, "installationId");
      prefix = tokenPrefix(input?.token);
    } catch {
      return { ok: false };
    }

    const claim = await this.db.prepare(
      `SELECT
         c.id, c.token_hash, c.installation_id,
         i.handle, i.canonical_origin
       FROM installation_onboarding_claims c
       JOIN installations i ON i.id = c.installation_id
       JOIN provisioning_operations p
         ON p.installation_id = i.id AND p.kind = 'create'
       WHERE c.token_prefix = ? AND c.installation_id = ?
         AND c.completed_at IS NULL AND c.revoked_at IS NULL
         AND c.expires_at > ?
         AND i.state = 'provisioning' AND p.state = 'provisioning'
       LIMIT 1`,
    ).bind(prefix, installationId, now).first<OnboardingClaimRow>();
    if (!claim) return { ok: false };
    if (!constantTimeEqual(await sha256Hex(input.token), claim.token_hash)) {
      return { ok: false };
    }
    return {
      ok: true,
      claimId: claim.id,
      installation: installationIdentity(claim),
    };
  }

  async complete(
    input: CompleteInstallationOnboardingInput,
  ): Promise<CompleteInstallationOnboardingResult> {
    const claimId = parseOpaqueId(input?.claimId, "claimId");
    const installationId = parseOpaqueId(input?.installationId, "installationId");
    const claim = await this.db.prepare(
      `SELECT p.operation_id, p.principal_id
       FROM installation_onboarding_claims c
       JOIN installations i ON i.id = c.installation_id
       JOIN provisioning_operations p
         ON p.installation_id = i.id AND p.kind = 'create'
       WHERE c.id = ? AND c.installation_id = ?
         AND c.completed_at IS NULL AND c.revoked_at IS NULL
         AND i.state = 'provisioning' AND p.state = 'provisioning'
       LIMIT 1`,
    ).bind(claimId, installationId).first<{
      operation_id: string;
      principal_id: string;
    }>();
    if (!claim) throw new Error("installation onboarding claim is unavailable");

    await this.accounts.completeInstallationOnboarding(
      claim.operation_id,
      claim.principal_id,
      claimId,
    );
    return { state: "complete", installationId };
  }
}

function installationIdentity(row: OnboardingClaimRow): InstallationIdentity {
  return {
    installationId: row.installation_id,
    handle: row.handle,
    canonicalOrigin: row.canonical_origin,
  };
}
