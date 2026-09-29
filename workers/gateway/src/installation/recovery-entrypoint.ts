import { WorkerEntrypoint } from "cloudflare:workers";
import type { AuthorizeRootRecoveryInput, InstallationRecoveryGatewayService } from "@humansandmachines/gsv/services/ownership";
import type { GatewayEnv } from "../runtime-env";
import { getKernelByInstallationId } from "./routing";

/** Only an Accounts binding with deployment-owned props grants incoming recovery authority. */
export class GatewayRecoveryEntrypoint extends WorkerEntrypoint<GatewayEnv, { authority: "installation-owner-recovery" }>
  implements InstallationRecoveryGatewayService {
  async authorizeRootRecovery(input: AuthorizeRootRecoveryInput): Promise<{ authorized: true }> {
    const kernel = await this.kernel(input.installationId);
    return kernel.authorizeRootRecovery(input);
  }

  async confirmOwnerLinkAuthorization(input: { installationId: string; attemptId: string }): Promise<{ authorized: true }> {
    const kernel = await this.kernel(input.installationId);
    return kernel.confirmOwnerLinkAuthorization(input.attemptId);
  }

  private async kernel(installationId: string) {
    if (this.ctx.props?.authority !== "installation-owner-recovery") throw new Error("Recovery binding authority is required");
    if (!this.env.INSTALLATION_DIRECTORY) throw new Error("Installation directory is required");
    const result = await this.env.INSTALLATION_DIRECTORY.resolveInstallation(installationId);
    if (!result.found || result.installationId !== installationId || result.state !== "active") throw new Error("The space is unavailable");
    return getKernelByInstallationId(this.env.KERNEL, installationId);
  }
}
