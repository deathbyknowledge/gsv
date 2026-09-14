import { WorkerEntrypoint } from "cloudflare:workers";
import { installationDeletionRequestSchema, type InstallationDeletionRequest, type InstallationDeletionService } from "@humansandmachines/gsv/services/lifecycle";
import {
  installationDeletionInspectionSchema,
  type InstallationDeletionDiscoveryService, type InstallationDeletionInspection,
  type InstallationDeletionInspectionResult, type InstallationResourceObservation,
} from "@humansandmachines/gsv/services/lifecycle-discovery";
import type { MailEnv } from "./env";

/** The deployment binds this entrypoint only to Accounts' verified deletion coordinator. */
export class MailLifecycleEntrypoint extends WorkerEntrypoint<MailEnv, { authority?: string }> implements InstallationDeletionService, Pick<InstallationDeletionDiscoveryService, "inspectInstallationDeletion"> {
  async quiesceInstallation(value: InstallationDeletionRequest) { const input = await this.authorize(value); return await this.owner(input.installationId).quiesceInstallation(input); }
  async eraseInstallation(value: InstallationDeletionRequest) { const input = await this.authorize(value); return await this.owner(input.installationId).eraseInstallation(input); }
  async installationDeletionStatus(value: InstallationDeletionRequest) { const input = await this.authorize(value); return await this.owner(input.installationId).installationDeletionStatus(input); }

  async inspectInstallationDeletion(value: InstallationDeletionInspection): Promise<InstallationDeletionInspectionResult> {
    this.authority();
    const input = installationDeletionInspectionSchema.parse(value);
    await this.requireRetired(input.installationId);
    const candidates = new Set([input.installationId]);
    for (const id of input.candidateInstallationIds ?? []) {
      const result = await this.env.ACCOUNTS.resolveInstallation(id);
      if (result.found && result.installationId === id) candidates.add(id);
    }
    const observations: InstallationResourceObservation[] = [];
    for (const resource of input.resources) {
      if (resource.kind !== "mail") throw new Error("Mail discovery resource kind is invalid");
      const observation: InstallationResourceObservation = { ...resource, outcome: "unidentified" };
      const name = [...candidates].find((id) => this.env.MAIL_INSTALLATIONS.idFromName(id).toString() === resource.objectId);
      if (!name || resource.name && resource.name !== name) { observations.push(observation); continue; }
      const inspected = await this.owner(name).inspectInstallationResource();
      if (inspected.installationId !== name) throw new Error("Mail physical identity mismatch");
      if (inspected.understood) {
        observation.name = name; observation.installationId = name; observation.outcome = "identified";
      }
      observations.push(observation);
    }
    return { installationId: input.installationId, observations };
  }

  private owner(installationId: string) { return this.env.MAIL_INSTALLATIONS.getByName(installationId); }
  private authority(): void { if (this.ctx.props?.authority !== "installation-deletion") throw new Error("Mail deletion binding authority is required"); }
  private async authorize(value: InstallationDeletionRequest): Promise<InstallationDeletionRequest> {
    this.authority();
    const input = installationDeletionRequestSchema.parse(value);
    await this.requireRetired(input.installationId);
    return input;
  }
  private async requireRetired(installationId: string): Promise<void> {
    const identity = await this.env.ACCOUNTS.resolveInstallation(installationId);
    if (!identity.found || identity.installationId !== installationId || !["retained", "deleting", "deleted"].includes(identity.state)) throw new Error("Mail deletion requires a retired installation");
  }
}
