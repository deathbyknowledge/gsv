import { WorkerEntrypoint } from "cloudflare:workers";
import { instanceChangeSchema, type InstancesGatewayService } from "@humansandmachines/gsv/services/instances";
import type { GatewayEnv } from "../runtime-env";
import { getKernelByInstallationId } from "./routing";

/** Only the deployment's instance service can invalidate its owners' browser inventories. */
export class InstancesGatewayEntrypoint extends WorkerEntrypoint<GatewayEnv, { authority: "instance-notifications" }>
  implements InstancesGatewayService {
  async instancesChanged(raw: Parameters<InstancesGatewayService["instancesChanged"]>[0]): Promise<void> {
    if (this.ctx.props?.authority !== "instance-notifications") throw new Error("Instance notification binding authority is required");
    const change = instanceChangeSchema.parse(raw);
    const route = await this.env.INSTALLATION_DIRECTORY.resolveInstallation(change.installationId);
    if (!route.found || route.installationId !== change.installationId || route.state !== "active") return;
    const kernel = await getKernelByInstallationId(this.env.KERNEL, change.installationId);
    await kernel.instancesChanged(change.ownerUid);
  }
}
