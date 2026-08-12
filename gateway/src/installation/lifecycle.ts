import type {
  InstallationDirectoryResult,
  InstallationDirectoryService,
} from "@humansandmachines/gsv/protocol";
import { parseManagedInstallationId } from "./identity";

export const MANAGED_LIFECYCLE_RECHECK_MS = 60_000;

export type ManagedInstallationWorkGate =
  | { allowed: true }
  | { allowed: false; code: 423 | 503; message: string };

type ResolvedManagedInstallation = Extract<
  InstallationDirectoryResult,
  { found: true }
>;

export type ManagedInstallationLifecycleBindings = {
  INSTALLATION_DIRECTORY?: InstallationDirectoryService;
};

export async function resolveManagedInstallationById(
  bindings: ManagedInstallationLifecycleBindings,
  installationIdValue: string,
): Promise<ResolvedManagedInstallation | null> {
  const directory = bindings.INSTALLATION_DIRECTORY;
  if (!directory) return null;

  const installationId = parseManagedInstallationId(installationIdValue);
  const result = await directory.resolveInstallation(installationId);
  if (!result.found || result.installationId !== installationId) {
    throw new Error("Managed installation is unavailable");
  }
  return result;
}

export async function managedInstallationWorkGate(
  bindings: ManagedInstallationLifecycleBindings,
  installationId: string,
): Promise<ManagedInstallationWorkGate> {
  try {
    const result = await resolveManagedInstallationById(
      bindings,
      installationId,
    );
    if (!result || result.state === "active") {
      return { allowed: true };
    }
    return result.state === "restricted"
      ? {
          allowed: false,
          code: 423,
          message: "Managed installation is suspended",
        }
      : {
          allowed: false,
          code: 503,
          message: "Managed installation is unavailable",
        };
  } catch {
    return {
      allowed: false,
      code: 503,
      message: "Managed installation is unavailable",
    };
  }
}
