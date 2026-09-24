import { z } from "zod";
import { emitTelemetry, type TelemetryComponent, type TelemetryEnvironment } from "../telemetry.js";

export type EntitlementValue = boolean | number | string;

export type EntitlementSnapshot = {
  version: 1;
  installationId: string;
  revision: string;
  values: Record<string, EntitlementValue>;
  issuedAt: number;
  refreshAfter: number;
  expiresAt: number;
};

export type GetEntitlementsInput = {
  version: 1;
  installationId: string;
};

/** Read-only policy contract consumed by managed services. */
export interface EntitlementsService {
  getEntitlements(input: GetEntitlementsInput): Promise<EntitlementSnapshot>;
}

export const ENTITLEMENT_CACHE_MAX_AGE_MS = 300_000;

const snapshotSchema = z.strictObject({
  version: z.literal(1), installationId: z.string(), revision: z.string().min(1),
  values: z.record(z.string(), z.union([z.boolean(), z.number().finite(), z.string()])),
  issuedAt: z.number().int().nonnegative(), refreshAfter: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
}).refine((value) => value.issuedAt <= value.refreshAfter && value.refreshAfter <= value.expiresAt
  && value.expiresAt - value.issuedAt <= ENTITLEMENT_CACHE_MAX_AGE_MS);

/** Owned by one installation. Only plan values are cached; admission and usage stay live. */
export class EntitlementCache {
  private cached: EntitlementSnapshot | undefined;
  private pending: Promise<EntitlementSnapshot> | undefined;

  constructor(
    private readonly service: EntitlementsService,
    private readonly installationId: string,
    private readonly telemetry?: { env: TelemetryEnvironment; component: TelemetryComponent },
  ) {}

  async get(now = Date.now()): Promise<EntitlementSnapshot> {
    let snapshot = this.cached;
    if (!snapshot || snapshot.refreshAfter <= now) {
      try {
        this.pending ??= this.refresh(now).finally(() => { this.pending = undefined; });
        snapshot = await this.pending;
      } catch {
        if (!snapshot || snapshot.expiresAt <= Math.max(now, Date.now())) throw new Error("Space allowance is temporarily unavailable");
      }
    }
    if (snapshot.expiresAt <= Math.max(now, Date.now())) throw new Error("Space allowance has expired; try again");
    return snapshot;
  }

  private async refresh(now: number): Promise<EntitlementSnapshot> {
    const startedAt = Date.now();
    let outcome: "refreshed" | "unavailable" | "invalid" = "unavailable";
    try {
      const value = await this.service.getEntitlements({ version: 1, installationId: this.installationId });
      outcome = "invalid";
      const result = snapshotSchema.parse(value);
      const receivedAt = Math.max(now, Date.now());
      if (result.installationId !== this.installationId || result.issuedAt > receivedAt || result.expiresAt <= receivedAt) {
        throw new Error("Invalid entitlement snapshot");
      }
      this.cached = result;
      outcome = "refreshed";
      return result;
    } finally {
      if (this.telemetry) emitTelemetry(this.telemetry.env, {
        installationId: this.installationId, component: this.telemetry.component,
        event: { stream: "operational", name: "entitlements.refresh.finished",
          properties: { outcome, durationMs: Math.max(0, Date.now() - startedAt) } },
      });
    }
  }
}
