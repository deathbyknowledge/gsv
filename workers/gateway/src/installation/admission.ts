import type { AdapterInstallationContext } from "@humansandmachines/gsv/protocol";
import type { GatewayEnv } from "../runtime-env";
import { parseInstallationId } from "./identity";

export function resolveAdapterInstallationId(
  bindings: GatewayEnv,
  installation: AdapterInstallationContext,
): string {
  if (!bindings.INSTALLATION_DIRECTORY) throw new Error("Installation directory is not configured");
  return parseInstallationId(installation?.installationId);
}
