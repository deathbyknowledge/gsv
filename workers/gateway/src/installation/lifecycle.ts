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
};

export function setupRecoveryDetails(
  bindings: Pick<ManagedInstallationLifecycleBindings, "GSV_OWNER_SIGNUP_URL">,
  installation: ResolvedManagedInstallation,
): SetupRecoveryDetails {
  const details: SetupRecoveryDetails = { setupRecovery: true, setupFeatures: ["language"] };
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
  return (await lookupManagedWorkGate(bindings, installationId)).gate;
}

/** How long a confirmed-active answer stands before Accounts is asked again. */
const ACTIVE_CONFIRMATION_MS = 60_000;
/** How long a confirmed-active installation keeps working while Accounts lookups fail. */
const LOOKUP_OUTAGE_GRACE_MS = 10 * 60_000;
const LOOKUP_TIMEOUT_MS = 2_000;
/** While Accounts is failing, a grace answer stands this long so requests do not each wait on a lookup. */
const LOOKUP_RETRY_MS = 10_000;

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
 * answer for a minute, shares one lookup among concurrent callers, and keeps a
 * recently active installation working through a failed lookup. A refusal from
 * Accounts is never remembered.
 */
export class ManagedInstallationGate {
  private confirmedAt?: number;
  private graceUntil = 0;
  private lookup?: Promise<ManagedInstallationWorkGate>;

  constructor(
    private readonly bindings: ManagedInstallationLifecycleBindings,
    private readonly installationId: () => string,
  ) {}

  async check(): Promise<ManagedInstallationWorkGate> {
    if (this.confirmedAt !== undefined && Date.now() - this.confirmedAt < ACTIVE_CONFIRMATION_MS) {
      return { allowed: true };
    }
    if (Date.now() < this.graceUntil) return { allowed: true };
    this.lookup ??= this.refresh().finally(() => { this.lookup = undefined; });
    return await this.lookup;
  }

  private async refresh(): Promise<ManagedInstallationWorkGate> {
    const { gate, lookupFailed } = await lookupManagedWorkGate(this.bindings, this.installationId());
    if (gate.allowed) this.confirmedAt = Date.now();
    else if (!lookupFailed) this.confirmedAt = undefined;
    else if (this.confirmedAt !== undefined && Date.now() - this.confirmedAt < LOOKUP_OUTAGE_GRACE_MS) {
      this.graceUntil = Date.now() + LOOKUP_RETRY_MS;
      return { allowed: true };
    }
    return gate;
  }
}

async function lookupManagedWorkGate(
  bindings: ManagedInstallationLifecycleBindings,
  installationIdValue: string,
): Promise<{ gate: ManagedInstallationWorkGate; lookupFailed: boolean }> {
  const directory = bindings.INSTALLATION_DIRECTORY;
  if (!directory) return { gate: UNAVAILABLE, lookupFailed: false };
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
    return { gate: UNREACHABLE, lookupFailed: true };
  } finally {
    clearTimeout(timer);
  }
  if (!result.found || result.installationId !== installationId) {
    return { gate: UNAVAILABLE, lookupFailed: false };
  }
  if (result.state === "active") return { gate: { allowed: true }, lookupFailed: false };
  if (result.state === "provisioning") {
    return {
      gate: { allowed: false, code: 503, message: "Finish setting up your Ship", details: setupRecoveryDetails(bindings, result) },
      lookupFailed: false,
    };
  }
  return {
    gate: result.state === "restricted"
      ? { allowed: false, code: 423, message: "Managed installation is suspended" }
      : UNAVAILABLE,
    lookupFailed: false,
  };
}
