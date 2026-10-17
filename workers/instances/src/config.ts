import { z } from "zod";
import { EntitlementCache } from "@humansandmachines/gsv/services/entitlements";
import type { EntitlementsService } from "@humansandmachines/gsv/services/entitlements";
import type { InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";
import type { InstanceTemplate } from "@humansandmachines/gsv/protocol";
import type { InstancesGatewayService } from "@humansandmachines/gsv/services/instances";
import { DEFAULT_PROFILE_BYTES, MAX_PROFILE_BYTES } from "./browser-storage";

export type Environment = Omit<Env, "INSTALLATION_DIRECTORY" | "INSTANCE_EVENTS"> & {
  INSTALLATION_DIRECTORY: InstallationDirectoryService;
  INSTANCE_EVENTS: InstancesGatewayService;
  ENTITLEMENTS?: EntitlementsService;
};
export const limitsSchema = z.strictObject({
  enabled: z.boolean(),
  concurrentInstances: z.number().int().min(0).max(100),
  periodSeconds: z.number().int().nonnegative(),
  maxInstanceSeconds: z.number().int().min(60).max(86400),
  savedProfiles: z.number().int().min(0).max(1000),
  profileStorageBytes: z.number().int().positive().max(MAX_PROFILE_BYTES),
});
export type BrowserLimits = z.infer<typeof limitsSchema>;
export const computerLimitsSchema = limitsSchema.omit({ savedProfiles: true, profileStorageBytes: true });
export type ComputerLimits = z.infer<typeof computerLimitsSchema>;
export const IMPLEMENTATIONS = ["shell.exec", "fs.read", "fs.write", "fs.edit", "fs.delete", "fs.search", "fs.copy", "fs.transfer.stat", "fs.transfer.send", "fs.transfer.receive"] as const;
export const COMPUTER_IMPLEMENTATIONS = [...IMPLEMENTATIONS, "shell.cancel", "net.fetch"] as const;
export function computerTemplate(limits: ComputerLimits): InstanceTemplate {
  return {
    templateId: "computer", revision: "1", kind: "linux", label: "Cloud computer",
    description: "An ephemeral Linux computer with Node.js, Python, Git, and build tools. Save source and outputs before stopping it.",
    implements: [...COMPUTER_IMPLEMENTATIONS], defaultLifetimeSeconds: Math.min(1800, limits.maxInstanceSeconds),
    maxLifetimeSeconds: limits.maxInstanceSeconds, capacityUnits: 1,
  };
}
/** `savedLogins` is whether the requesting account can use or create its automatic saved-login profile right now. */
export function browserTemplate(limits: BrowserLimits, savedLogins = limits.savedProfiles > 0): InstanceTemplate {
  return {
    templateId: "browser", revision: "1", kind: "browser", label: "Cloud browser",
    description: savedLogins
      ? "A browser with tabs, page interaction, screenshots, and temporary files. Ordinary starts remember and restore this account's website logins across instances; the lifetime caps one instance, not the saved logins. --new starts a separate temporary browser that does not share them."
      : "A browser with tabs, page interaction, screenshots, and temporary files. An ordinary start cannot use or create this account's automatic saved-login profile and would fail; start with --new for a temporary browser, or with --profile and an existing saved profile from `browser profile list`.",
    implements: [...IMPLEMENTATIONS], defaultLifetimeSeconds: Math.min(1800, limits.maxInstanceSeconds),
    maxLifetimeSeconds: limits.maxInstanceSeconds, capacityUnits: 1,
  };
}
export class InstancePolicy {
  private readonly cache: EntitlementCache | undefined;
  constructor(private readonly env: Environment, private readonly installationId: string) {
    this.cache = env.ENTITLEMENTS ? new EntitlementCache(env.ENTITLEMENTS, installationId) : undefined;
  }
  async limits(): Promise<BrowserLimits> {
    if (!this.cache) return limitsSchema.parse(this.env.BROWSER_LIMITS);
    const { values } = await this.cache.get();
    return limitsSchema.parse({
      enabled: values["browser.enabled"] === true,
      concurrentInstances: values["browser.concurrent_instances"] ?? 0,
      periodSeconds: values["browser.period_seconds"] ?? 0,
      maxInstanceSeconds: values["browser.max_instance_seconds"] ?? 1800,
      savedProfiles: values["browser.saved_profiles"] ?? 0,
      profileStorageBytes: values["browser.profile_storage_bytes"] ?? DEFAULT_PROFILE_BYTES,
    });
  }
  async computerLimits(): Promise<ComputerLimits> {
    const disabled = { enabled: false, concurrentInstances: 0, periodSeconds: 0, maxInstanceSeconds: 1800 };
    if (!this.env.COMPUTERS) return disabled;
    if (!this.cache) return computerLimitsSchema.parse(this.env.COMPUTER_LIMITS ?? disabled);
    const { values } = await this.cache.get();
    return computerLimitsSchema.parse({
      enabled: values["computer.enabled"] === true,
      concurrentInstances: values["computer.concurrent_instances"] ?? 0,
      periodSeconds: values["computer.period_seconds"] ?? 0,
      maxInstanceSeconds: values["computer.max_instance_seconds"] ?? 1800,
    });
  }
  async requireActive(): Promise<void> {
    const route = await this.env.INSTALLATION_DIRECTORY.resolveInstallation(this.installationId);
    if (!route.found || route.state !== "active") throw new Error("Space is not active");
  }
}
