import { WorkerEntrypoint } from "cloudflare:workers";
import {
  operatorIdentityMoveRequestSchema,
  operatorIdentityMoveSchema,
  operatorIdentitySurveyRequestSchema,
  operatorIdentitySurveySchema,
  operatorShipSnapshotRequestSchema,
  operatorShipSnapshotSchema,
  type OperatorGatewayService,
  type OperatorIdentityMoveRequest,
  type OperatorIdentityMoveResult,
  type OperatorIdentitySurveyRequest,
  type OperatorIdentitySurveyResult,
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
    this.assertOperator();
    const request = operatorShipSnapshotRequestSchema.parse(input);
    const ship = await this.ship(request.installationId);
    if (!ship) return { found: false };
    const snapshot = operatorShipSnapshotSchema.parse(await ship.kernel.operatorShipSnapshot(request.runLimit));
    if (snapshot.installationId !== ship.installationId) throw new Error("Operator snapshot belongs to another installation");
    return { found: true, snapshot };
  }

  async operatorIdentitySurvey(input: OperatorIdentitySurveyRequest): Promise<OperatorIdentitySurveyResult> {
    this.assertOperator();
    const request = operatorIdentitySurveyRequestSchema.parse(input);
    const ship = await this.ship(request.installationId);
    if (!ship) return { found: false };
    const survey = operatorIdentitySurveySchema.parse(await ship.kernel.operatorIdentitySurvey(ship.active));
    if (survey.installationId !== ship.installationId) throw new Error("Identity survey belongs to another installation");
    return { found: true, survey };
  }

  async operatorIdentityMove(input: OperatorIdentityMoveRequest): Promise<OperatorIdentityMoveResult> {
    this.assertOperator();
    const request = operatorIdentityMoveRequestSchema.parse(input);
    const ship = await this.ship(request.installationId);
    if (!ship) return { found: false };
    const move = operatorIdentityMoveSchema.parse(await ship.kernel.operatorIdentityMove(request.people));
    if (move.installationId !== ship.installationId) throw new Error("Identity move belongs to another installation");
    return { found: true, move };
  }

  private assertOperator(): void {
    if (this.ctx.props?.authority !== "installation-operator") throw new Error("Operator binding authority is required");
  }

  /** The Kernel of a Ship the directory holds as active or restricted; null for any other, which stays asleep. */
  private async ship(requested: string) {
    const installationId = parseInstallationId(requested);
    const directory = this.env.INSTALLATION_DIRECTORY;
    if (!directory) throw new Error("Installation directory is required");
    const result = await directory.resolveInstallation(installationId);
    if (!result.found || result.installationId !== installationId || (result.state !== "active" && result.state !== "restricted")) {
      return null;
    }
    return { installationId, active: result.state === "active", kernel: await getKernelByInstallationId(this.env.KERNEL, installationId) };
  }
}
