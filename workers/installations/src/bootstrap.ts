import { InstallationAdminService } from "./admin/service";
import { InstallationOnboardingStore } from "./onboarding";
import { AccountStore } from "./store";
import { constantTimeEqual, sha256Hex, tokenPrefix } from "./tokens";

export type OperatorAccessMode = "access" | "operator";
export function parseOperatorAccessMode(value: string): OperatorAccessMode {
  if (value === "access" || value === "operator") return value;
  throw new Error("Operator access mode is not configured");
}
type BootstrapRecord = {
  claim_id: string;
  token_hash: string;
  expires_at: number;
  access_mode: OperatorAccessMode;
  operation_id: string;
  handle: string | null;
  onboarding_token_prefix: string | null;
  onboarding_token_hash: string | null;
  operator_token_prefix: string | null;
  operator_token_hash: string | null;
  installation_id: string | null;
  started_at: number | null;
  completed_at: number | null;
};

export class InstallationBootstrapService {
  constructor(
    private readonly database: D1Database,
    private readonly accounts: AccountStore,
    private readonly onboarding: InstallationOnboardingStore,
    private readonly administration: InstallationAdminService,
    private readonly mode: OperatorAccessMode,
  ) {}

  /** The browser persists both new secrets before redemption, so lost replies are retryable. */
  async redeem(input: { claim: string; handle: string; onboardingToken: string; operatorToken?: string }, now = Date.now()) {
    const handle = this.accounts.validateHandle(input.handle);
    tokenPrefix(input.claim);
    if (!/^onboard_[A-Za-z0-9_-]{43}$/.test(input.onboardingToken)
      || (this.mode === "operator" ? !/^operator_[A-Za-z0-9_-]{43}$/.test(input.operatorToken ?? "") : input.operatorToken !== undefined)) {
      throw new Error("bootstrap credentials are invalid");
    }
    const tokenHash = await sha256Hex(input.claim);
    const onboardingHash = await sha256Hex(input.onboardingToken);
    const operatorHash = input.operatorToken ? await sha256Hex(input.operatorToken) : null;
    let claim = await this.readClaim();
    if (!claim || claim.access_mode !== this.mode || !constantTimeEqual(claim.token_hash, tokenHash)
      || (claim.started_at === null && claim.expires_at <= now)) throw new Error("bootstrap claim is unavailable");
    await this.database.batch([
      this.database.prepare(
        `UPDATE operator_bootstrap SET handle = ?, onboarding_token_prefix = ?, onboarding_token_hash = ?,
          operator_token_prefix = ?, operator_token_hash = ?, started_at = ?
         WHERE id = 1 AND token_hash = ? AND access_mode = ? AND started_at IS NULL AND expires_at > ?`,
      ).bind(handle, tokenPrefix(input.onboardingToken), onboardingHash,
        input.operatorToken ? tokenPrefix(input.operatorToken) : null, operatorHash, now, tokenHash, this.mode, now),
      this.database.prepare(
        `INSERT INTO operator_credentials (id, token_prefix, token_hash, revoked_at, created_at, updated_at)
         SELECT 1, operator_token_prefix, operator_token_hash, NULL, ?, ? FROM operator_bootstrap
         WHERE id = 1 AND token_hash = ? AND handle = ? AND onboarding_token_hash = ?
           AND operator_token_hash = ? AND access_mode = 'operator'
         ON CONFLICT (id) DO NOTHING`,
      ).bind(now, now, tokenHash, handle, onboardingHash, operatorHash),
    ]);
    claim = await this.readClaim();
    if (!claim || claim.handle !== handle || claim.onboarding_token_hash !== onboardingHash
      || claim.operator_token_hash !== operatorHash || claim.started_at === null) {
      throw new Error("bootstrap claim was redeemed by a different attempt");
    }
    const reservation = await this.administration.reserve({ operationId: claim.operation_id, handle });
    if (claim.installation_id !== null && claim.installation_id !== reservation.installationId) {
      throw new Error("bootstrap installation identity changed");
    }
    if (reservation.state === "reserved") {
      await this.accounts.beginProvisioning(reservation.operationId, reservation.ownerPrincipalId);
    }
    const available = await this.onboarding.prepare(reservation.installationId, {
      claimId: `onboarding_${claim.claim_id}`,
      tokenPrefix: tokenPrefix(input.onboardingToken), tokenHash: onboardingHash,
      expiresAt: claim.started_at + 60 * 60 * 1000,
    }, now);
    await this.database.prepare(
      `UPDATE operator_bootstrap SET installation_id = ?, completed_at = COALESCE(completed_at, ?)
       WHERE id = 1 AND operation_id = ? AND handle = ? AND onboarding_token_hash = ?`,
    ).bind(reservation.installationId, now, claim.operation_id, handle, onboardingHash).run();
    const onboardingUrl = available ? new URL("/onboarding", reservation.canonicalOrigin) : null;
    if (onboardingUrl) onboardingUrl.hash = input.onboardingToken;
    return { installationId: reservation.installationId, onboardingUrl: onboardingUrl?.toString() ?? null,
      operatorAccess: input.operatorToken ? await this.authorizeOperator(input.operatorToken) : false };
  }

  async authorizeOperator(raw: string): Promise<boolean> {
    if (this.mode !== "operator" || !/^operator_[A-Za-z0-9_-]{43}$/.test(raw)) return false;
    const row = await this.database.prepare(
      "SELECT token_hash FROM operator_credentials WHERE id = 1 AND token_prefix = ? AND revoked_at IS NULL",
    ).bind(tokenPrefix(raw)).first<{ token_hash: string }>();
    return Boolean(row && constantTimeEqual(row.token_hash, await sha256Hex(raw)));
  }

  private readClaim(): Promise<BootstrapRecord | null> {
    return this.database.prepare("SELECT * FROM operator_bootstrap WHERE id = 1").first<BootstrapRecord>();
  }
}
