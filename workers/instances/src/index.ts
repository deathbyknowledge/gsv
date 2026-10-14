import { WorkerEntrypoint } from "cloudflare:workers";
import type { InstallationInstances, InstancesService } from "@humansandmachines/gsv/services/instances";
import type { Environment } from "./config";
export { InstanceCoordinator } from "./coordinator";
export { InstanceLifecycleEntrypoint } from "./lifecycle";

export default class InstanceService extends WorkerEntrypoint<Environment> implements InstancesService {
  async fetch(): Promise<Response> { return new Response("Not Found", { status: 404 }); }
  async getInstallation(installationId: string): Promise<InstallationInstances> {
    if (!installationId || installationId.length > 160) throw new Error("Invalid installation identity");
    const route = await this.env.INSTALLATION_DIRECTORY.resolveInstallation(installationId);
    if (!route.found) throw new Error("Unknown installation");
    // Restricted spaces retain authority to stop resources and erase saved profiles.
    return this.env.INSTANCES.getByName(installationId).getTarget();
  }
}
