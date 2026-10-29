import { normalizeUsernamePolicy } from "./username-policy";
import { AccountStore } from "./store";
import { InstallationOnboardingStore } from "./onboarding";
import { parseOpaqueId } from "./domain";
import { OwnerAuthError } from "./owner-auth-store";
import { emitTelemetry, exceptionDiagnostics, type TelemetryEnvironment } from "@humansandmachines/gsv/telemetry";

export type PendingSetup = { operationId: string; handle: string; origin: string };
/** Where the signup click came from, as the website's own closed slugs; never a visitor identity. */
export type SignupAttribution = { placement: string; example?: string };
export type SignupPolicy = {
  allowsEmail?(email: string): boolean;
  prepare(input: { operationId: string; installationId: string }): Promise<void>;
};

/** Verified owners resume the same provisioning operation after a lost response or restart. */
export class InstallationSignup {
  constructor(private readonly db: D1Database, private readonly accounts: AccountStore,
    private readonly onboarding: InstallationOnboardingStore, readonly enabled: boolean, private readonly policy?: SignupPolicy,
    private readonly telemetry?: TelemetryEnvironment) {}

  allowsEmail(email: string): boolean { return this.policy?.allowsEmail?.(email) ?? true; }

  async pending(principalId: string): Promise<PendingSetup[]> {
    const rows = await this.db.prepare(`SELECT p.operation_id AS operationId, i.handle, i.canonical_origin AS origin
      FROM installations i JOIN provisioning_operations p ON p.installation_id = i.id AND p.kind = 'create'
      WHERE i.owner_setup = 1 AND i.owner_principal_id = ? AND p.principal_id = i.owner_principal_id
        AND i.state IN ('reserved', 'provisioning') ORDER BY i.created_at`).bind(principalId).all<PendingSetup>();
    return rows.results;
  }

  async available(value: string): Promise<boolean> {
    let handle: string;
    try { handle = this.accounts.validateHandle(value); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith("handle is reserved")) return false;
      throw error;
    }
    return !await this.db.prepare(`SELECT 1 FROM installations WHERE handle = ?
      UNION ALL SELECT 1 FROM username_policy WHERE normalized_handle = ? LIMIT 1`).bind(handle, normalizeUsernamePolicy(handle)).first();
  }

  async prepare(operationIdValue: string, principalIdValue: string, handle: string, attribution?: SignupAttribution) {
    const operationId = parseOpaqueId(operationIdValue, "operationId");
    const principalId = parseOpaqueId(principalIdValue, "principalId");
    const principal = await this.accounts.getPrincipal(principalId);
    if (!principal || principal.state !== "active" || principal.emailVerifiedAt === null) throw new Error("Verified owner is required");
    const existing = await this.accounts.getReservationByOperation(operationId);
    if (!existing && !this.enabled) throw new Error("Registration is currently closed.");
    if (!existing && !this.allowsEmail(principal.email)) throw new OwnerAuthError("email_restricted");
    const space = await this.accounts.reserveInstallation({ principalId, operationId, handle, ownerSetup: true });
    // The first request's origin stands; a resumed signup never rewrites it.
    if (attribution) {
      await this.db.prepare("UPDATE provisioning_operations SET attribution_json = ? WHERE operation_id = ? AND attribution_json IS NULL")
        .bind(JSON.stringify(attribution), operationId).run();
    }
    const owned = await this.db.prepare("SELECT 1 FROM installations WHERE id = ? AND owner_setup = 1 AND owner_principal_id = ?")
      .bind(space.installationId, principalId).first();
    if (!owned) throw new Error("Ship activation is unavailable.");
    if (space.state === "active") return { origin: space.canonicalOrigin, handle: space.handle, onboardingToken: null, expiresAt: null };
    if (!["reserved", "provisioning"].includes(space.state)) throw new Error("Ship activation is unavailable.");
    const startedAt = Date.now();
    try {
      await this.policy?.prepare({ operationId, installationId: space.installationId });
      const issued = await this.onboarding.begin(space.installationId, Date.now(), "resume");
      await this.db.prepare("UPDATE provisioning_operations SET last_error = NULL WHERE operation_id = ?").bind(operationId).run();
      return { origin: space.canonicalOrigin, handle: space.handle,
        onboardingToken: new URL(issued.onboardingUrl).hash.slice(1), expiresAt: issued.expiresAt };
    } catch (cause) {
      const diagnosticId = crypto.randomUUID();
      await this.db.prepare("UPDATE provisioning_operations SET last_error = ?, updated_at = ? WHERE operation_id = ?")
        .bind(JSON.stringify({ diagnosticId, ...exceptionDiagnostics(cause) }), Date.now(), operationId).run();
      emitTelemetry(this.telemetry, { component: "accounts", installationId: space.installationId,
        event: { stream: "operational", name: "installation.setup.failed", properties: {
          diagnosticId, outcome: "failed", stage: "activation", errorType: "unknown", durationMs: Date.now() - startedAt,
        } } });
      throw new Error(`Ship activation failed. Try again. Reference: ${diagnosticId}`, { cause });
    }
  }
}
