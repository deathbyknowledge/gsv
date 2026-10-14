import { WorkerEntrypoint } from "cloudflare:workers";
import { installationDeletionRequestSchema, type InstallationDeletionRequest, type InstallationDeletionService } from "@humansandmachines/gsv/services/lifecycle";
import { installationDeletionInspectionSchema, type InstallationDeletionInspection, type InstallationResourceObservation } from "@humansandmachines/gsv/services/lifecycle-discovery";
import type { Environment } from "./config";

/** Bound only to Accounts. Ordinary instance capabilities never expose erasure. */
export class InstanceLifecycleEntrypoint extends WorkerEntrypoint<Environment, { authority?: string }> implements InstallationDeletionService {
  private authority(): void {
    if (this.ctx.props.authority !== "installation-deletion") throw new Error("Browser deletion authority is required");
  }
  private async owner(raw: InstallationDeletionRequest): Promise<InstallationDeletionService> {
    this.authority();
    const input = installationDeletionRequestSchema.parse(raw);
    const identity = await this.env.INSTALLATION_DIRECTORY.resolveInstallation(input.installationId);
    if (!identity.found || identity.installationId !== input.installationId || !["retained", "deleting", "deleted"].includes(identity.state)) throw new Error("Browser deletion requires a retired installation");
    return this.env.INSTANCES.getByName(input.installationId);
  }
  async quiesceInstallation(input: InstallationDeletionRequest) { return (await this.owner(input)).quiesceInstallation(input); }
  async eraseInstallation(input: InstallationDeletionRequest) { return (await this.owner(input)).eraseInstallation(input); }
  async installationDeletionStatus(input: InstallationDeletionRequest) { return (await this.owner(input)).installationDeletionStatus(input); }

  async inspectInstallationDeletion(raw: InstallationDeletionInspection) {
    this.authority();
    const input = installationDeletionInspectionSchema.parse(raw);
    const target = await this.env.INSTALLATION_DIRECTORY.resolveInstallation(input.installationId);
    if (!target.found || target.installationId !== input.installationId) throw new Error("Browser discovery requires a known installation");
    const candidates = new Set([input.installationId, ...(input.candidateInstallationIds ?? [])]);
    const observations: InstallationResourceObservation[] = [];
    for (const resource of input.resources) {
      if (resource.kind !== "instance-installation") throw new Error("Resource kind is not owned by instances");
      const name = [...candidates].find(candidate => this.env.INSTANCES.idFromName(candidate).toString() === resource.objectId);
      const identity = name ? await this.env.INSTALLATION_DIRECTORY.resolveInstallation(name) : null;
      observations.push(name && identity?.found && identity.installationId === name && (!resource.name || resource.name === name)
        ? { ...resource, name, installationId: name, outcome: "identified" }
        : { ...resource, outcome: "unidentified" });
    }
    return { installationId: input.installationId, observations };
  }
}
