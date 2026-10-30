import { WorkerEntrypoint } from "cloudflare:workers";
import { phoneChangeSchema, type PhoneGatewayService } from "@humansandmachines/gsv/services/phone";
import type { GatewayEnv } from "../runtime-env";
import { getKernelByInstallationId } from "./routing";

/** Only the deployment's calls service can report changes to its owners' calls. */
export class PhoneGatewayEntrypoint extends WorkerEntrypoint<GatewayEnv, { authority: "phone-notifications" }>
  implements PhoneGatewayService {
  async phoneChanged(raw: Parameters<PhoneGatewayService["phoneChanged"]>[0]): Promise<void> {
    if (this.ctx.props?.authority !== "phone-notifications") throw new Error("Phone notification binding authority is required");
    const change = phoneChangeSchema.parse(raw);
    const route = await this.env.INSTALLATION_DIRECTORY.resolveInstallation(change.installationId);
    if (!route.found || route.installationId !== change.installationId || route.state !== "active") return;
    const kernel = await getKernelByInstallationId(this.env.KERNEL, change.installationId);
    await kernel.phoneChanged(change);
  }
}
