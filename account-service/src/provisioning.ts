import type {
  ManagedGatewayProvisioningInterface,
  ProvisionInstallationInput,
  ProvisionInstallationResult,
} from "@humansandmachines/gsv/protocol";
import { parseOpaqueId } from "./domain";
import { AccountStore, type InstallationReservation } from "./store";

export type ProvisionReservedInstallationInput = {
  operationId: string;
  principalId: string;
  username: string;
  agentName?: string;
  timezone?: string;
};

export async function provisionReservedInstallation(
  store: AccountStore,
  gateway: ManagedGatewayProvisioningInterface,
  input: ProvisionReservedInstallationInput,
): Promise<InstallationReservation> {
  const operationId = parseOpaqueId(input.operationId, "operationId");
  const principalId = parseOpaqueId(input.principalId, "principalId");
  const reservation = await store.beginProvisioning(operationId, principalId);
  if (reservation.operationState === "complete") {
    return reservation;
  }

  const request: ProvisionInstallationInput = {
    operationId,
    installation: {
      installationId: reservation.installationId,
      handle: reservation.handle,
      canonicalOrigin: reservation.canonicalOrigin,
    },
    owner: {
      principalId,
      username: input.username,
      ...(input.agentName ? { agentName: input.agentName } : {}),
      ...(input.timezone ? { timezone: input.timezone } : {}),
    },
    provisionVersion: reservation.provisionVersion,
  };

  try {
    const result: ProvisionInstallationResult = await gateway.provisionInstallation(request);
    return await store.completeProvisioning(
      operationId,
      principalId,
      input.username,
      result,
    );
  } catch (error) {
    await store.failProvisioning(operationId, provisionErrorCategory(error));
    throw error;
  }
}

function provisionErrorCategory(error: unknown): string {
  if (!(error instanceof Error)) return "gateway_error";
  if (error.message.includes("mismatch")) return "gateway_mismatch";
  if (error.message.includes("initialized")) return "kernel_conflict";
  if (error.message.includes("unavailable")) return "gateway_unavailable";
  return "gateway_error";
}
