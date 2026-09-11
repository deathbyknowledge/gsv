import { WorkerEntrypoint } from "cloudflare:workers";
import { authorizeInferenceDeletion, type InferenceServiceEnvironment } from "@humansandmachines/gsv-inference/executor";
import type { InstallationDeletionRequest, InstallationDeletionService } from "@humansandmachines/gsv/services/lifecycle";

/** This entrypoint is bound only to Accounts, with explicit deletion authority. */
export class InferenceLifecycleEntrypoint extends WorkerEntrypoint<InferenceServiceEnvironment, { authority?: string }> implements InstallationDeletionService {
  async quiesceInstallation(input: InstallationDeletionRequest) { return (await this.owner(input)).quiesceInstallation(input); }
  async eraseInstallation(input: InstallationDeletionRequest) { return (await this.owner(input)).eraseInstallation(input); }
  async installationDeletionStatus(input: InstallationDeletionRequest) { return (await this.owner(input)).installationDeletionStatus(input); }
  private async owner(value: InstallationDeletionRequest): Promise<InstallationDeletionService> {
    const input = await authorizeInferenceDeletion(this.env.INSTALLATION_DIRECTORY, this.ctx.props, value);
    const owner: unknown = this.env.INFERENCE_EXECUTORS.getByName(input.installationId);
    // SAFETY: The exported DO implements the lifecycle contract; namespace access stays behind this authority check.
    return owner as InstallationDeletionService;
  }
}
