import { WorkerEntrypoint } from "cloudflare:workers";
import {
  operatorShipSnapshotRequestSchema,
  operatorShipSnapshotSchema,
  operatorTakedownsChangedRequestSchema,
  profileCopyChangeSchema,
  type OperatorGatewayService,
  type OperatorShipSnapshotRequest,
  type OperatorShipSnapshotResult,
  type OperatorTakedownsChangedRequest,
  type OperatorTakedownsChangedResult,
} from "@humansandmachines/gsv/services/operator";
import type { Kernel } from "../kernel/do";
import type { GatewayEnv } from "../runtime-env";
import { parseInstallationId } from "./identity";
import { getKernelByInstallationId } from "./routing";

/**
 * Only an Accounts binding with deployment-owned props reaches this. It reads
 * metadata for the operator Ship page and never wakes a Kernel the directory
 * does not hold as active or suspended. It also tells a Ship when the
 * operator's takedowns of it change.
 */
export class OperatorGatewayEntrypoint extends WorkerEntrypoint<GatewayEnv, { authority: "installation-operator" }>
  implements OperatorGatewayService {
  async operatorShipSnapshot(input: OperatorShipSnapshotRequest): Promise<OperatorShipSnapshotResult> {
    this.requireOperator();
    const request = operatorShipSnapshotRequestSchema.parse(input);
    const installationId = parseInstallationId(request.installationId);
    const kernel = await this.kernelOf(installationId);
    if (!kernel) return { found: false };
    const snapshot = operatorShipSnapshotSchema.parse(await kernel.operatorShipSnapshot(request.runLimit));
    if (snapshot.installationId !== installationId) throw new Error("Operator snapshot belongs to another installation");
    return { found: true, snapshot };
  }

  async operatorTakedownsChanged(input: OperatorTakedownsChangedRequest): Promise<OperatorTakedownsChangedResult> {
    this.requireOperator();
    const request = operatorTakedownsChangedRequestSchema.parse(input);
    const kernel = await this.kernelOf(parseInstallationId(request.installationId));
    if (!kernel) return { found: false };
    return { found: true, copy: profileCopyChangeSchema.parse(await kernel.operatorTakedownsChanged()) };
  }

  private requireOperator(): void {
    if (this.ctx.props?.authority !== "installation-operator") throw new Error("Operator binding authority is required");
  }

  /** The Kernel of a Ship the directory holds as active or suspended; null for any other. */
  private async kernelOf(installationId: string): Promise<DurableObjectStub<Kernel> | null> {
    const directory = this.env.INSTALLATION_DIRECTORY;
    if (!directory) throw new Error("Installation directory is required");
    const result = await directory.resolveInstallation(installationId);
    if (!result.found || result.installationId !== installationId || (result.state !== "active" && result.state !== "restricted")) {
      return null;
    }
    return await getKernelByInstallationId(this.env.KERNEL, installationId);
  }
}
