import type { OperatorGatewayService } from "@humansandmachines/gsv/services/operator";

/** The deployment-owned binding the operator Ship page reads health metadata through. */
export type OperatorSnapshotEnvironment = {
  OPERATOR_GATEWAY?: OperatorGatewayService;
};
