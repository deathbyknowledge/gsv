import { WorkerEntrypoint } from "cloudflare:workers";
import {
  operatorShipSnapshotRequestSchema,
  operatorShipSnapshotSchema,
  type OperatorGatewayService,
  type OperatorShipSnapshotRequest,
  type OperatorShipSnapshotResult,
} from "@humansandmachines/gsv/services/operator";
import type { GatewayEnv } from "../runtime-env";
import { parseInstallationId } from "./identity";
import { getKernelByInstallationId } from "./routing";

/**
 * Only an Accounts binding with deployment-owned props reaches this. It reads
 * metadata for the operator Ship page and never wakes a Kernel the directory
 * does not hold as active or suspended.
 */
export class OperatorGatewayEntrypoint extends WorkerEntrypoint<GatewayEnv, { authority: "installation-operator" }>
  implements OperatorGatewayService {
  async operatorShipSnapshot(input: OperatorShipSnapshotRequest): Promise<OperatorShipSnapshotResult> {
    if (this.ctx.props?.authority !== "installation-operator") throw new Error("Operator binding authority is required");
    const request = operatorShipSnapshotRequestSchema.parse(input);
    const installationId = parseInstallationId(request.installationId);
    const directory = this.env.INSTALLATION_DIRECTORY;
    if (!directory) throw new Error("Installation directory is required");
    const result = await directory.resolveInstallation(installationId);
    if (!result.found || result.installationId !== installationId || (result.state !== "active" && result.state !== "restricted")) {
      return { found: false };
    }
    const kernel = await getKernelByInstallationId(this.env.KERNEL, installationId);
    const snapshot = operatorShipSnapshotSchema.parse(await kernel.operatorShipSnapshot(request.runLimit));
    if (snapshot.installationId !== installationId) throw new Error("Operator snapshot belongs to another installation");
    return { found: true, snapshot };
  }
}
