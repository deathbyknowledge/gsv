import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ManagedEntitlementReader,
  ManagedInferenceAbort,
  ManagedInferenceAbortResult,
  ManagedInferenceDataLifecycleInterface,
  ManagedInferenceRequest,
  ManagedInferenceService,
  PrepareManagedInstallationDeletionInput,
  RecoverManagedInstallationInput,
} from "@humansandmachines/gsv/protocol";
import { BudgetCoordinator, inferenceErrorResponse } from "./coordinator";
import {
  parseAbortInput,
  parseInferenceRequest,
} from "./domain";
import { resolveManagedProvider, type ProviderEnvironment } from "./providers/router";

export { BudgetCoordinator } from "./coordinator";

type InferenceServiceEnv = ProviderEnvironment & {
  BUDGET_COORDINATOR: DurableObjectNamespace<BudgetCoordinator>;
  ENTITLEMENTS: ManagedEntitlementReader;
  MANAGED_MAX_CONCURRENT?: string;
  MANAGED_DAILY_BUDGET_MICROUNITS?: string;
  MANAGED_MAX_ATTEMPTS?: string;
};

export class InferenceService
  extends WorkerEntrypoint<InferenceServiceEnv>
  implements ManagedInferenceService, ManagedInferenceDataLifecycleInterface
{
  async fetch(): Promise<Response> {
    return new Response("Not Found", { status: 404 });
  }

  async run(rawInput: ManagedInferenceRequest): Promise<Response> {
    try {
      const input = parseInferenceRequest(rawInput);
      // Resolve configuration before opening a Durable Object so a disabled
      // production provider cannot allocate budget state.
      resolveManagedProvider(this.env);
      const entitlement = await this.env.ENTITLEMENTS.getEntitlement(input.installationId);
      return await this.coordinator(input.installationId).run(input, entitlement);
    } catch (error) {
      return inferenceErrorResponse(error);
    }
  }

  async abort(rawInput: ManagedInferenceAbort): Promise<ManagedInferenceAbortResult> {
    const input = parseAbortInput(rawInput);
    return await this.coordinator(input.installationId).abort(input.logicalRequestId);
  }

  async suspendManagedInferenceInstallation(
    input: PrepareManagedInstallationDeletionInput,
  ): Promise<{ suspended: true }> {
    return await this.coordinator(input.installationId).suspendInstallation(input);
  }

  async recoverManagedInferenceInstallation(
    input: RecoverManagedInstallationInput,
  ): Promise<{ recovered: boolean }> {
    return await this.coordinator(input.installationId).recoverInstallation(input);
  }

  async deleteManagedInferenceInstallation(
    input: RecoverManagedInstallationInput,
  ): Promise<{ deleted: true }> {
    return await this.coordinator(input.installationId).deleteInstallation(input);
  }

  private coordinator(installationId: string): DurableObjectStub<BudgetCoordinator> {
    const id = this.env.BUDGET_COORDINATOR.idFromName(installationId);
    return this.env.BUDGET_COORDINATOR.get(id);
  }
}

export default InferenceService;
