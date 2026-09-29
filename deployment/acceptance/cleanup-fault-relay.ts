import { WorkerEntrypoint } from "cloudflare:workers";
import { installationDeletionReceiptSchema, installationDeletionRequestSchema,
  type InstallationDeletionRequest, type InstallationDeletionService } from "@humansandmachines/gsv/services/lifecycle";
import { installationDeletionInspectionSchema, installationDeletionInventoryImportSchema,
  type InstallationDeletionDiscoveryService, type InstallationDeletionInspection,
  type InstallationDeletionInventoryImport } from "@humansandmachines/gsv/services/lifecycle-discovery";

type Environment = {
  GATEWAY_REAL: InstallationDeletionService & InstallationDeletionDiscoveryService;
  FAULT_INSTALLATION_ID: string;
  FAULT_OPERATION_ID: string;
};

/** Temporary acceptance binding only. Restoring Accounts' real Gateway binding ends the fault. */
export class GatewayFaultRelay extends WorkerEntrypoint<Environment, { authority: "installation-deletion" }>
  implements InstallationDeletionService, InstallationDeletionDiscoveryService {
  async fetch(): Promise<Response> { return new Response("Not Found", { status: 404 }); }

  private authorize(): void {
    if (this.ctx.props?.authority !== "installation-deletion") throw new Error("Installation deletion binding authority is required");
  }

  async inspectInstallationDeletion(input: InstallationDeletionInspection) {
    this.authorize();
    return this.env.GATEWAY_REAL.inspectInstallationDeletion(installationDeletionInspectionSchema.parse(input));
  }

  async importInstallationDeletionInventory(input: InstallationDeletionInventoryImport) {
    this.authorize();
    return this.env.GATEWAY_REAL.importInstallationDeletionInventory(installationDeletionInventoryImportSchema.parse(input));
  }

  async quiesceInstallation(input: InstallationDeletionRequest) {
    this.authorize();
    return this.env.GATEWAY_REAL.quiesceInstallation(installationDeletionRequestSchema.parse(input));
  }

  async installationDeletionStatus(input: InstallationDeletionRequest) {
    this.authorize();
    return this.env.GATEWAY_REAL.installationDeletionStatus(installationDeletionRequestSchema.parse(input));
  }

  async eraseInstallation(input: InstallationDeletionRequest) {
    this.authorize();
    const request = installationDeletionRequestSchema.parse(input);
    const fault = installationDeletionRequestSchema.parse({ version: 1,
      installationId: this.env.FAULT_INSTALLATION_ID, operationId: this.env.FAULT_OPERATION_ID });
    const receipt = installationDeletionReceiptSchema.parse(await this.env.GATEWAY_REAL.eraseInstallation(request));
    if (receipt.installationId !== request.installationId || receipt.operationId !== request.operationId) {
      throw new Error("Gateway erase receipt does not match the requested operation");
    }
    if (request.installationId === fault.installationId && request.operationId === fault.operationId) {
      throw new Error("Acceptance relay lost the committed Gateway erase reply");
    }
    return receipt;
  }
}

export default GatewayFaultRelay;
