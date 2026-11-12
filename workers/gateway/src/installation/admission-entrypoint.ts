import { WorkerEntrypoint } from "cloudflare:workers";
import {
  installationStateChangedRequestSchema,
  type InstallationAdmissionService,
  type InstallationStateChangedRequest,
  type InstallationStateChangedResult,
} from "@humansandmachines/gsv/services/lifecycle";
import type { InstallationState } from "@humansandmachines/gsv/services/directory";
import type { GatewayEnv } from "../runtime-env";
import { parseInstallationId } from "./identity";
import { getKernelByInstallationId } from "./routing";

/** States whose Kernel keeps no record of them, or whose Kernel is gone. */
const UNTOLD_STATES: ReadonlySet<InstallationState> = new Set(["reserved", "provisioning", "deleted"]);

/**
 * Only an Accounts binding with deployment-owned props reaches this. Accounts
 * calls it after each change of an installation's state; the Gateway reads
 * the installation back from the directory and has its Kernel keep that
 * state. It never wakes a Kernel for an identity the directory doesn't hold,
 * or in a state no Kernel keeps.
 */
export class GatewayAdmissionEntrypoint extends WorkerEntrypoint<GatewayEnv, { authority: "installation-admission" }>
  implements InstallationAdmissionService {
  async installationStateChanged(input: InstallationStateChangedRequest): Promise<InstallationStateChangedResult> {
    if (this.ctx.props?.authority !== "installation-admission") throw new Error("Admission binding authority is required");
    const installationId = parseInstallationId(installationStateChangedRequestSchema.parse(input).installationId);
    const directory = this.env.INSTALLATION_DIRECTORY;
    if (!directory) throw new Error("Installation directory is required");
    const installation = await directory.resolveInstallation(installationId);
    if (!installation.found || installation.installationId !== installationId) return { found: false };
    if (UNTOLD_STATES.has(installation.state)) return { found: true, stateRevision: installation.stateRevision ?? 0 };
    if (installation.stateRevision === undefined) throw new Error("The installation directory reports no state revision");
    const kernel = await getKernelByInstallationId(this.env.KERNEL, installationId);
    return { found: true, stateRevision: await kernel.installationStateChanged(installation) ?? installation.stateRevision };
  }
}
