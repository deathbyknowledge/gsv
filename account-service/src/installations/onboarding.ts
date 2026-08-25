import type {
  AuthorizeInstallationOnboardingInput,
  CompleteInstallationOnboardingInput,
  CompleteInstallationOnboardingResult,
  InstallationOnboardingAuthorization,
  ManagedInstallationIdentity,
} from "@humansandmachines/gsv/protocol";
import { parseOpaqueId } from "../domain";
import {
  constantTimeEqual,
  createOpaqueToken,
  sha256Hex,
  tokenPrefix,
} from "../security/tokens";
import { AccountStore } from "../store";

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

type OnboardingCompletionRow = {
  operation_id: string;
  principal_id: string;
};

export class InstallationOnboardingStore {
  constructor(
    private readonly db: D1Database,
    private readonly accounts: AccountStore,
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
      state: "reserved" | "provisioning" | "failed";
    }>();
    if (!operation) {
      throw new Error("installation is not awaiting onboarding");
    }
    if (operation.state !== "provisioning") {
      await this.accounts.beginProvisioning(
        operation.operation_id,
        operation.principal_id,
      );
    }
    return await this.issue(installationId, now);
  }

  async issue(
    installationIdValue: string,
    now = Date.now(),
  ): Promise<IssuedInstallationOnboarding> {
    const installationId = parseOpaqueId(installationIdValue, "installationId");
    const installation = await this.db.prepare(
      `SELECT i.id, i.handle, i.canonical_origin
       FROM installations i
       JOIN provisioning_operations p
         ON p.installation_id = i.id AND p.kind = 'create'
       WHERE i.id = ? AND i.state = 'provisioning'
         AND p.state = 'provisioning'
       LIMIT 1`,
    ).bind(installationId).first<{
      id: string;
      handle: string;
      canonical_origin: string;
    }>();
    if (!installation) {
      throw new Error("installation is not awaiting onboarding");
    }

    const token = await createOpaqueToken("onboard");
    const claimId = `onboarding_${crypto.randomUUID()}`;
    const expiresAt = now + ONBOARDING_TOKEN_TTL_MS;
    const result = await this.db.prepare(
      `INSERT INTO installation_onboarding_claims (
         id, installation_id, token_prefix, token_hash,
         expires_at, completed_at, revoked_at, created_at
       )
       SELECT ?, i.id, ?, ?, ?, NULL, NULL, ?
       FROM installations i
       JOIN provisioning_operations p
         ON p.installation_id = i.id AND p.kind = 'create'
       WHERE i.id = ? AND i.state = 'provisioning'
         AND p.state = 'provisioning'
       ON CONFLICT (installation_id) DO UPDATE SET
         id = excluded.id,
         token_prefix = excluded.token_prefix,
         token_hash = excluded.token_hash,
         expires_at = excluded.expires_at,
         completed_at = NULL,
         revoked_at = NULL,
         created_at = excluded.created_at`,
    ).bind(
      claimId,
      token.prefix,
      token.hash,
      expiresAt,
      now,
      installationId,
    ).run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new Error("installation is not awaiting onboarding");
    }

    const onboardingUrl = new URL("/onboarding", installation.canonical_origin);
    onboardingUrl.hash = token.raw;
    return {
      installationId,
      onboardingUrl: onboardingUrl.toString(),
      expiresAt,
    };
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

    const tokenHash = await sha256Hex(input.token);
    if (!constantTimeEqual(tokenHash, claim.token_hash)) {
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
    ).bind(claimId, installationId).first<OnboardingCompletionRow>();
    if (!claim) {
      throw new Error("installation onboarding claim is unavailable");
    }

    await this.accounts.completeInstallationOnboarding(
      claim.operation_id,
      claim.principal_id,
      claimId,
    );
    return { state: "complete", installationId };
  }
}

function installationIdentity(row: OnboardingClaimRow): ManagedInstallationIdentity {
  return {
    installationId: row.installation_id,
    handle: row.handle,
    canonicalOrigin: row.canonical_origin,
  };
}
