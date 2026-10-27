import type {
  InstallationDirectoryResult,
} from "@humansandmachines/gsv/protocol";
import type { InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";
import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import { parseInstallationId } from "./identity";

export const MANAGED_LIFECYCLE_RECHECK_MS = 60_000;

type SetupRecoveryDetails = { setupRecovery: true; setupUrl?: string; setupFeatures: string[] };

export type ManagedInstallationWorkGate =
  | { allowed: true }
  | { allowed: false; code: 423 | 503; message: string; details?: SetupRecoveryDetails };

type ResolvedManagedInstallation = Extract<
  InstallationDirectoryResult,
  { found: true }
>;

export type ManagedInstallationLifecycleBindings = {
  INSTALLATION_DIRECTORY?: InstallationDirectoryService;
  GSV_OWNER_SIGNUP_URL?: string;
  PDS?: unknown;
};

/** The optional `sys.setup` arguments this Ship accepts: a profile choice only where an open-network host can publish it. */
export function setupFeatures(bindings: Pick<ManagedInstallationLifecycleBindings, "PDS">): string[] {
  return bindings.PDS ? ["language", "profile"] : ["language"];
}

export function setupRecoveryDetails(
  bindings: Pick<ManagedInstallationLifecycleBindings, "GSV_OWNER_SIGNUP_URL" | "PDS">,
  installation: ResolvedManagedInstallation,
): SetupRecoveryDetails {
  const details: SetupRecoveryDetails = { setupRecovery: true, setupFeatures: setupFeatures(bindings) };
  if (installation.ownerSetupRecovery && bindings.GSV_OWNER_SIGNUP_URL) {
    details.setupUrl = bindings.GSV_OWNER_SIGNUP_URL;
  }
  return details;
}

export async function resolveManagedInstallationById(
  bindings: ManagedInstallationLifecycleBindings,
  installationIdValue: string,
): Promise<ResolvedManagedInstallation> {
  const directory = bindings.INSTALLATION_DIRECTORY;
  if (!directory) throw new Error("Installation directory is not configured");

  const installationId = parseInstallationId(installationIdValue);
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
  return await lookupManagedWorkGate(bindings, installationId);
}

/** How long a confirmed-active answer stands before Accounts is asked again. */
const ACTIVE_CONFIRMATION_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 2_000;

const UNAVAILABLE: ManagedInstallationWorkGate = {
  allowed: false,
  code: 503,
  message: "Managed installation is unavailable",
};
const UNREACHABLE: ManagedInstallationWorkGate = {
  allowed: false,
  code: 503,
  message: "Ship is briefly unreachable; try again in a moment",
};

/**
 * One Durable Object's view of its Accounts admission. It remembers an active
 * answer for a minute and shares one lookup among concurrent callers. A refusal
 * or a failed lookup is never remembered, so an outage fails closed.
 */
export class ManagedInstallationGate {
  private confirmedAt?: number;
  private lookup?: Promise<ManagedInstallationWorkGate>;

  constructor(
    private readonly bindings: ManagedInstallationLifecycleBindings,
    private readonly installationId: () => string,
  ) {}

  /** `fresh` asks Accounts even after a recent confirmation, for calls that grant new authority. */
  async check(options: { fresh?: boolean } = {}): Promise<ManagedInstallationWorkGate> {
    if (!options.fresh && this.confirmedAt !== undefined && Date.now() - this.confirmedAt < ACTIVE_CONFIRMATION_MS) {
      return { allowed: true };
    }
    if (options.fresh) return await this.refresh();
    this.lookup ??= this.refresh().finally(() => { this.lookup = undefined; });
    return await this.lookup;
  }

  /** Forgets the last confirmation, so the next check asks Accounts. */
  invalidate(): void {
    this.confirmedAt = undefined;
  }

  private async refresh(): Promise<ManagedInstallationWorkGate> {
    const gate = await lookupManagedWorkGate(this.bindings, this.installationId());
    this.confirmedAt = gate.allowed ? Date.now() : undefined;
    return gate;
  }
}

async function lookupManagedWorkGate(
  bindings: ManagedInstallationLifecycleBindings,
  installationIdValue: string,
): Promise<ManagedInstallationWorkGate> {
  const directory = bindings.INSTALLATION_DIRECTORY;
  if (!directory) return UNAVAILABLE;
  const installationId = parseInstallationId(installationIdValue);
  let result: InstallationDirectoryResult;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    result = await Promise.race([
      directory.resolveInstallation(installationId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Accounts lookup timed out")), LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    console.warn("[Installation gate] Accounts lookup failed:", exceptionDiagnostics(error));
    return UNREACHABLE;
  } finally {
    clearTimeout(timer);
  }
  if (!result.found || result.installationId !== installationId) return UNAVAILABLE;
  if (result.state === "active") return { allowed: true };
  if (result.state === "provisioning") {
    return { allowed: false, code: 503, message: "Finish setting up your Ship", details: setupRecoveryDetails(bindings, result) };
  }
  return result.state === "restricted"
    ? { allowed: false, code: 423, message: "Managed installation is suspended" }
    : UNAVAILABLE;
}
