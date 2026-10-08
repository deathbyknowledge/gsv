import { WorkerEntrypoint } from "cloudflare:workers";
import type { InstancesGatewayService } from "@humansandmachines/gsv/services/instances";
export { default, InstanceCoordinator, InstanceLifecycleEntrypoint } from "../src/index";

type Change = Parameters<InstancesGatewayService["instancesChanged"]>[0];
const changes = new Map<string, Change[]>();

/** A test-only RPC sink; each test installation gets an independent notification history. */
export class TestInstanceEvents extends WorkerEntrypoint implements InstancesGatewayService {
  async instancesChanged(change: Change): Promise<void> {
    const history = changes.get(change.installationId) ?? [];
    history.push(change);
    changes.set(change.installationId, history);
  }
  async take(installationId: string): Promise<Change[]> {
    const history = changes.get(installationId) ?? [];
    changes.delete(installationId);
    return history;
  }
}
