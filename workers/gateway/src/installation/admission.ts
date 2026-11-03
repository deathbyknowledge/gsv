import type { AdapterInstallationContext } from "@humansandmachines/gsv/protocol";
import type { InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";
import type { Kernel } from "../kernel/do";
import type { GatewayEnv } from "../runtime-env";
import { parseInstallationId } from "./identity";
import { ManagedInstallationGate, type ManagedInstallationWorkGate } from "./lifecycle";
import { getKernelByInstallationId } from "./routing";

/** Installations one isolate remembers admissions for; the oldest gives way first. */
const REMEMBERED_INSTALLATIONS = 1_024;

/**
 * Each isolate's admission gates, per directory binding. A gate remembers an
 * active answer for a minute and shares one lookup among concurrent callers;
 * a refusal or a failed lookup is never remembered. Accounts tells no Gateway
 * or Kernel about a suspension, so one reaches this admission within a minute.
 */
const workGates = new WeakMap<InstallationDirectoryService, Map<string, ManagedInstallationGate>>();

export type WorkAdmission =
  | { allowed: true; kernel: DurableObjectStub<Kernel> }
  | Extract<ManagedInstallationWorkGate, { allowed: false }>;

/** Admits new work a service brings for an installation, addressing its Kernel only while Accounts reports it active. */
export async function kernelForWork(
  env: GatewayEnv,
  installation: AdapterInstallationContext,
): Promise<WorkAdmission> {
  const installationId = parseInstallationId(installation?.installationId);
  const gate = await workGateFor(env, installationId).check();
  if (!gate.allowed) return gate;
  return { allowed: true, kernel: await getKernelByInstallationId(env.KERNEL, installationId) };
}

/**
 * Finds the Kernel that settles work it already admitted, in any lifecycle
 * state. An installation Accounts no longer has settles nothing; a directory
 * answer naming another installation is a fault, never a reason to settle.
 */
export async function kernelForSettlement(
  env: GatewayEnv,
  installation: AdapterInstallationContext,
): Promise<DurableObjectStub<Kernel> | null> {
  const installationId = parseInstallationId(installation?.installationId);
  const result = await env.INSTALLATION_DIRECTORY.resolveInstallation(installationId);
  if (!result.found) return null;
  if (result.installationId !== installationId) {
    throw new Error("Managed installation identity does not match directory state");
  }
  return await getKernelByInstallationId(env.KERNEL, installationId);
}

function workGateFor(env: GatewayEnv, installationId: string): ManagedInstallationGate {
  let gates = workGates.get(env.INSTALLATION_DIRECTORY);
  if (!gates) {
    gates = new Map();
    workGates.set(env.INSTALLATION_DIRECTORY, gates);
  }
  let gate = gates.get(installationId);
  if (!gate) {
    gate = new ManagedInstallationGate(env, () => installationId);
    gates.set(installationId, gate);
    for (const oldest of gates.keys()) {
      if (gates.size <= REMEMBERED_INSTALLATIONS) break;
      gates.delete(oldest);
    }
  }
  return gate;
}
