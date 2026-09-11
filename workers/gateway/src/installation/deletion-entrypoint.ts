import { installationDeletionInspectionSchema, installationDeletionInventoryImportSchema, type InstallationDeletionDiscoveryService, type InstallationDeletionInspection, type InstallationDeletionInventoryImport } from "@humansandmachines/gsv/services/lifecycle-discovery";
import { GatewayDeletionDiscovery } from "./deletion-discovery";
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  installationDeletionRequestSchema,
  type InstallationDeletionRequest,
  type InstallationDeletionService,
} from "@humansandmachines/gsv/services/lifecycle";
import type { GatewayEnv } from "../runtime-env";
import { parseManagedInstallationId } from "./identity";

/** Accounts closes directory admission before calling this deployment-owned binding. */
export class GatewayLifecycleEntrypoint extends WorkerEntrypoint<GatewayEnv, { authority: "installation-deletion" }>
  implements InstallationDeletionService, InstallationDeletionDiscoveryService {
  async inspectInstallationDeletion(input: InstallationDeletionInspection) {
    this.assertAuthority();
    const request = installationDeletionInspectionSchema.parse(input);
    await this.authorizeDiscovery(request.installationId, [
      ...(request.candidateInstallationIds ?? []),
      ...request.resources.flatMap((resource) => resource.kind === "kernel" && resource.name ? [resource.name] : []),
    ]);
    return new GatewayDeletionDiscovery(this.env).inspect(request);
  }

  async importInstallationDeletionInventory(input: InstallationDeletionInventoryImport) {
    this.assertAuthority();
    const request = installationDeletionInventoryImportSchema.parse(input);
    await this.authorizeDiscovery(request.installationId, request.resources.flatMap((resource) => resource.kind === "kernel" ? [resource.name] : []));
    return new GatewayDeletionDiscovery(this.env).import(request);
  }

  private assertAuthority(): void {
    if (this.ctx.props?.authority !== "installation-deletion") throw new Error("Installation deletion binding authority is required");
  }

  private async authorizeDiscovery(installationId: string, candidates: string[]): Promise<void> {
    parseManagedInstallationId(installationId);
    const directory = this.env.INSTALLATION_DIRECTORY;
    if (!directory) throw new Error("Installation directory is required");
    const result = await directory.resolveInstallation(installationId);
    if (!result.found || result.installationId !== installationId || result.state !== "retained") throw new Error("Installation must be retained before discovery");
    for (const candidate of new Set(candidates)) {
      if (candidate === installationId) continue;
      parseManagedInstallationId(candidate);
      const identity = await directory.resolveInstallation(candidate);
      if (!identity.found || identity.installationId !== candidate) throw new Error("Discovery candidate is not in the installation directory");
    }
  }

  async quiesceInstallation(input: InstallationDeletionRequest) {
    return (await this.kernel(input)).quiesceInstallation(input);
  }

  async eraseInstallation(input: InstallationDeletionRequest) {
    return (await this.kernel(input)).eraseInstallation(input);
  }

  async installationDeletionStatus(input: InstallationDeletionRequest) {
    return (await this.kernel(input)).installationDeletionStatus(input);
  }

  private async kernel(input: InstallationDeletionRequest) {
    this.assertAuthority();
    const request = installationDeletionRequestSchema.parse(input);
    parseManagedInstallationId(request.installationId);
    const directory = this.env.INSTALLATION_DIRECTORY;
    if (!directory) throw new Error("Installation directory is required");
    const installation = await directory.resolveInstallation(request.installationId);
    if (!installation.found || installation.installationId !== request.installationId || installation.state !== "retained") throw new Error("Installation must be retained before deletion");
    return this.env.KERNEL.getByName(request.installationId);
  }
}
