import { z } from "zod";
import { EntitlementCache } from "@humansandmachines/gsv/services/entitlements";
import type { EntitlementsService } from "@humansandmachines/gsv/services/entitlements";
import type { InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";
import type { InstanceTemplate } from "@humansandmachines/gsv/protocol";

export type Environment = Omit<Env, "INSTALLATION_DIRECTORY"> & {
  INSTALLATION_DIRECTORY: InstallationDirectoryService;
  ENTITLEMENTS?: EntitlementsService;
};
export const limitsSchema = z.strictObject({
  enabled: z.boolean(),
  concurrentInstances: z.number().int().min(0).max(100),
  periodSeconds: z.number().int().nonnegative(),
  maxInstanceSeconds: z.number().int().min(60).max(86400),
  savedProfiles: z.number().int().min(0).max(1000),
  profileStorageBytes: z.number().int().positive().max(100 * 1024 * 1024),
});
export type BrowserLimits = z.infer<typeof limitsSchema>;
export const IMPLEMENTATIONS = ["shell.exec", "fs.read", "fs.write", "fs.edit", "fs.delete", "fs.search", "fs.copy", "fs.transfer.stat", "fs.transfer.send", "fs.transfer.receive"];
export function browserTemplate(limits: BrowserLimits): InstanceTemplate {
  return {
    templateId: "browser", revision: "1", kind: "browser", label: "Cloud browser",
    description: "A browser with tabs, page interaction, screenshots, and temporary files.",
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
      profileStorageBytes: values["browser.profile_storage_bytes"] ?? 5242880,
    });
  }
  async requireActive(): Promise<void> {
    const route = await this.env.INSTALLATION_DIRECTORY.resolveInstallation(this.installationId);
    if (!route.found || route.state !== "active") throw new Error("Space is not active");
  }
}
