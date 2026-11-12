import { normalizeUsernamePolicy } from "./username-policy";
import { AccountStore } from "./store";
import { InstallationOnboardingStore } from "./onboarding";
import { parseOpaqueId } from "./domain";
import { OwnerAuthError } from "./owner-auth-store";
import { queueProductEmail, type ProductEmailChoice } from "./product-email";
import {
  emitTelemetry, exceptionDiagnostics, installationAttributedProperties, type SignupAttribution, type TelemetryEnvironment,
} from "@humansandmachines/gsv/telemetry";

export type PendingSetup = { operationId: string; handle: string; origin: string };
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

  async prepare(operationIdValue: string, principalIdValue: string, handle: string, attribution?: SignupAttribution, inviter?: string, productEmails?: ProductEmailChoice, ip?: string) {
    const operationId = parseOpaqueId(operationIdValue, "operationId");
    const principalId = parseOpaqueId(principalIdValue, "principalId");
    const principal = await this.accounts.getPrincipal(principalId);
    if (!principal || principal.state !== "active" || principal.emailVerifiedAt === null) throw new Error("Verified owner is required");
    const existing = await this.accounts.getReservationByOperation(operationId);
    if (!existing && !this.enabled) throw new Error("Registration is currently closed.");
    if (!existing && !this.allowsEmail(principal.email)) throw new OwnerAuthError("email_restricted");
    // The inviter is resolved before the reservation commits: a lookup that fails here fails the request
    // before anything is reserved, so the retry still creates the reservation and reports it.
    const inviterInstallationId = !existing && inviter ? await this.inviterInstallation(inviter, principalId) : undefined;
    const space = await this.accounts.reserveInstallation({ principalId, operationId, handle, ownerSetup: true });
    // Where the signup came from is reported once, by the request that created the reservation; a retry
    // or resumed signup replays the reservation and reports nothing. Nothing is stored: the records are
    // the only copy. An inviting Ship learns of the signup under its own pseudonym and the new Ship's
    // record says only that it was invited, so neither record names the other.
    if (space.created) {
      if (inviterInstallationId) emitTelemetry(this.telemetry, { component: "accounts", installationId: inviterInstallationId,
        event: { stream: "product", name: "contact.invite.signup", properties: {} } });
      emitTelemetry(this.telemetry, { component: "accounts", installationId: space.installationId,
        event: { stream: "product", name: "installation.attributed",
          properties: installationAttributedProperties(attribution, inviterInstallationId !== undefined) } });
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
      if (productEmails) await queueProductEmail(this.db, principal, productEmails, ip);
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

  /**
   * The inviter is the signup's own claim: an unknown address is dropped silently here, and the
   * reservation keeps the Ship only if it is still active and owned by someone else when it is written.
   */
  /**
   * The Ship a contact invitation named, only while it is an active installation someone else owns.
   * The hostname is a claim from the link, not proof of who sent it, so anything else is dropped without error.
   */
  private async inviterInstallation(hostname: string, principalId: string): Promise<string | undefined> {
    const inviter = await this.accounts.resolveHostname(hostname);
    if (!inviter.found) return undefined;
    const other = await this.db.prepare("SELECT 1 FROM installations WHERE id = ? AND state = 'active' AND owner_principal_id != ?")
      .bind(inviter.installationId, principalId).first();
    return other ? inviter.installationId : undefined;
  }
}
