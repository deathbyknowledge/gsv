import { z } from "zod";
import {
  emitTelemetry, entitlementSchemaCodeSchema, type EntitlementSchemaCode, type TelemetryComponent, type TelemetryEnvironment,
} from "../telemetry.js";

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

/** Why an answer was refused: closed reasons and bounded shape metadata, never the answer's values. */
type EntitlementRejection =
  | { rejection: "schema"; schemaPath: string; schemaCode: EntitlementSchemaCode }
  | { rejection: "installation-mismatch" };

class EntitlementRejectedError extends Error {
  constructor(reason: EntitlementRejection) {
    super(`Invalid entitlement snapshot: ${Object.entries(reason).map(([key, value]) => `${key}=${value}`).join(" ")}`);
    this.name = "EntitlementRejectedError";
  }
}

const pathSegmentSchema = z.union([z.number().int().nonnegative(), z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/)]);

function schemaRejection(error: z.ZodError): EntitlementRejection {
  const [issue] = error.issues;
  // Keys come from the schema or the plan's entitlement names; anything else is masked.
  const path = issue.path.map((key) => {
    const segment = pathSegmentSchema.safeParse(key);
    return segment.success ? String(segment.data) : "*";
  }).join(".");
  const code = entitlementSchemaCodeSchema.safeParse(issue.code);
  return { rejection: "schema", schemaPath: path || "(root)", schemaCode: code.success ? code.data : "other" };
}

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
      } catch (cause) {
        if (!snapshot || snapshot.expiresAt <= Math.max(now, Date.now())) throw new Error("Space allowance is temporarily unavailable", { cause });
      }
    }
    if (snapshot.expiresAt <= Math.max(now, Date.now())) throw new Error("Space allowance has expired; try again");
    return snapshot;
  }

  private async refresh(now: number): Promise<EntitlementSnapshot> {
    const startedAt = Date.now();
    let outcome: "refreshed" | "unavailable" | "invalid" = "unavailable";
    let rejection: EntitlementRejection | undefined;
    try {
      const value = await this.service.getEntitlements({ version: 1, installationId: this.installationId });
      const parsed = snapshotSchema.safeParse(value);
      if (!parsed.success) rejection = schemaRejection(parsed.error);
      else if (parsed.data.installationId !== this.installationId) rejection = { rejection: "installation-mismatch" };
      else {
        const result = parsed.data;
        // The issuer stamps its answer with its own clock, which can run ahead of or behind this one.
        // Its lifetime counts from this request instead, so the two clocks are never compared.
        const snapshot = { ...result, issuedAt: now, refreshAfter: now + result.refreshAfter - result.issuedAt,
          expiresAt: now + result.expiresAt - result.issuedAt };
        this.cached = snapshot;
        outcome = "refreshed";
        return snapshot;
      }
      outcome = "invalid";
      throw new EntitlementRejectedError(rejection);
    } finally {
      if (this.telemetry) emitTelemetry(this.telemetry.env, {
        installationId: this.installationId, component: this.telemetry.component,
        event: { stream: "operational", name: "entitlements.refresh.finished",
          properties: { outcome, ...rejection, durationMs: Math.max(0, Date.now() - startedAt) } },
      });
    }
  }
}
