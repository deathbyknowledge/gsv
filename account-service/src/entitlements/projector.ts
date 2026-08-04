import type { ManagedGatewayLifecycleInterface } from "@humansandmachines/gsv/protocol";
import {
  EntitlementStore,
  type EntitlementProjection,
} from "./store";

export interface EntitlementProjector {
  project(input: EntitlementProjection): Promise<EntitlementProjection>;
}

export class GatewayEntitlementProjector implements EntitlementProjector {
  constructor(
    private readonly store: EntitlementStore,
    private readonly gateway: ManagedGatewayLifecycleInterface,
  ) {}

  async project(input: EntitlementProjection): Promise<EntitlementProjection> {
    const stored = await this.store.project(input);
    return await this.gateway.applyManagedEntitlement(stored);
  }
}
