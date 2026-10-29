import { z } from "zod";
import { EntitlementCache } from "@humansandmachines/gsv/services/entitlements";
import type { EntitlementsService } from "@humansandmachines/gsv/services/entitlements";
import type { InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";
import type { PhoneGatewayService, PhoneRealtimeSessions } from "@humansandmachines/gsv/services/phone";
import type { CallCoordinator } from "./coordinator";
import type { PhoneCallObject } from "./call";

export type Environment = {
  CALL_COORDINATORS: DurableObjectNamespace<CallCoordinator>;
  CALLS: DurableObjectNamespace<PhoneCallObject>;
  INSTALLATION_DIRECTORY: InstallationDirectoryService;
  PHONE_EVENTS: PhoneGatewayService;
  REALTIME_SESSIONS: PhoneRealtimeSessions;
  ENTITLEMENTS?: EntitlementsService;
  /** Origin of this Worker's public route; Twilio signs callback URLs against it. */
  PUBLIC_ORIGIN: string;
  PHONE_LIMITS: unknown;
  PHONE_ROUTES: unknown;
  PHONE_REALTIME: unknown;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_API_KEY_SID: string;
  TWILIO_API_KEY_SECRET: string;
  /** Twilio signs webhooks with the account auth token, not an API key. */
  TWILIO_AUTH_TOKEN: string;
  /** TwiML App whose voice URL is /twilio/join, used only by take-over clients. */
  TWILIO_TWIML_APP_SID: string;
};

/** Wrangler vars arrive as JSON values, while local .dev.vars overrides arrive as JSON text. */
export function jsonVar(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

export const limitsSchema = z.strictObject({
  enabled: z.boolean(),
  concurrentCalls: z.number().int().min(0).max(100),
  dailyCalls: z.number().int().min(0).max(10_000),
  maxCallSeconds: z.number().int().min(60).max(1800),
});
export type PhoneLimits = z.infer<typeof limitsSchema>;

export const routeSchema = z.strictObject({
  /** Destination prefix in E.164, for example +1 or +34. */
  prefix: z.string().regex(/^\+[1-9]\d{0,3}$/),
  /** Pool number used as caller ID for this region. */
  from: z.string().regex(/^\+[1-9]\d{6,14}$/),
  locationHint: z.enum(["wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"]).optional(),
});
export type PhoneRoute = z.infer<typeof routeSchema>;
export const routesSchema = z.array(routeSchema).max(50);

export const realtimeConfigSchema = z.strictObject({
  model: z.string().min(1).max(100),
  voice: z.string().min(1).max(40),
  transcriptionModel: z.string().min(1).max(100),
});
export type RealtimeConfig = z.infer<typeof realtimeConfigSchema>;

/** Plan values for one installation; admission and usage stay live in the coordinator. */
export class PhonePolicy {
  private readonly cache: EntitlementCache | undefined;
  constructor(private readonly env: Environment, private readonly installationId: string) {
    this.cache = env.ENTITLEMENTS ? new EntitlementCache(env.ENTITLEMENTS, installationId) : undefined;
  }
  async limits(): Promise<PhoneLimits> {
    if (!this.cache) return limitsSchema.parse(jsonVar(this.env.PHONE_LIMITS));
    const { values } = await this.cache.get();
    return limitsSchema.parse({
      enabled: values["phone.enabled"] === true,
      concurrentCalls: values["phone.concurrent_calls"] ?? 1,
      dailyCalls: values["phone.daily_calls"] ?? 10,
      maxCallSeconds: values["phone.max_call_seconds"] ?? 360,
    });
  }
  async requireActive(): Promise<void> {
    const route = await this.env.INSTALLATION_DIRECTORY.resolveInstallation(this.installationId);
    if (!route.found || route.state !== "active") throw new Error("Space is not active");
  }
}
