import type {
  InstallationDirectoryResult,
} from "@humansandmachines/gsv/protocol";
import type { InstallationDirectoryService, InstallationState } from "@humansandmachines/gsv/services/directory";
import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import { parseInstallationId } from "./identity";

export const MANAGED_LIFECYCLE_RECHECK_MS = 60_000;

/** Where a Kernel keeps the state Accounts last reported for its installation. */
export const MANAGED_INSTALLATION_STATE_KEY = "managed_installation_state";

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
  installation: Pick<ResolvedManagedInstallation, "ownerSetupRecovery">,
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
  const installation = await lookupManagedInstallation(bindings, installationId);
  return "allowed" in installation ? installation : workGate(bindings, installation);
}

/** How long a confirmed-active answer stands before Accounts is asked again. */
const ACTIVE_CONFIRMATION_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 2_000;

export const UNAVAILABLE: ManagedInstallationWorkGate = {
  allowed: false,
  code: 503,
  message: "Managed installation is unavailable",
};
export const UNREACHABLE: ManagedInstallationWorkGate = {
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

  /** `ask` answers for the installation without throwing; a failure is a refusal. */
  constructor(private readonly ask: () => Promise<ManagedInstallationWorkGate>) {}

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
    const gate = await this.ask();
    this.confirmedAt = gate.allowed ? Date.now() : undefined;
    return gate;
  }
}

type RecordedInstallationState = { state: InstallationState; revision: number };

/** A Kernel being set up keeps asking Accounts, whose answer carries setup details that change without a change of state. */
const UNRECORDED_STATES: ReadonlySet<InstallationState> = new Set(["reserved", "provisioning"]);

/**
 * A Kernel's record of its installation's state in Accounts. Accounts tells
 * the Kernel of every change of state and gives each a higher revision, so
 * the Kernel answers from its record and replaces it only with a higher
 * revision: a late notice never undoes a newer one.
 * A Kernel without a record asks Accounts through its gate and keeps the
 * answer. An answer without a revision comes from an Accounts that doesn't
 * tell Kernels of changes, so the Kernel keeps none and only the gate's
 * minute applies.
 */
export class RecordedInstallationGate {
  private readonly gate: ManagedInstallationGate;

  constructor(
    private readonly bindings: ManagedInstallationLifecycleBindings,
    private readonly installationId: () => string,
    private readonly kv: SyncKvStorage,
  ) {
    this.gate = new ManagedInstallationGate(() => this.askAccounts());
  }

  /** `fresh` asks Accounts even with a record, for calls that grant new authority. */
  async check(options: { fresh?: boolean } = {}): Promise<ManagedInstallationWorkGate> {
    const recorded = options.fresh ? undefined : this.recorded();
    return recorded ? workGate(this.bindings, recorded) : await this.gate.check(options);
  }

  /** Keeps a directory answer newer than the record, and returns the revision the Kernel then holds. */
  follow(installation: ResolvedManagedInstallation): number | undefined {
    const recorded = this.recorded();
    const revision = installation.stateRevision;
    if (revision === undefined) {
      // Accounts no longer reports revisions, so it won't tell the Kernel of the next change.
      if (recorded) this.kv.delete(MANAGED_INSTALLATION_STATE_KEY);
      return undefined;
    }
    if (recorded && recorded.revision >= revision) return recorded.revision;
    if (UNRECORDED_STATES.has(installation.state)) {
      if (recorded) this.kv.delete(MANAGED_INSTALLATION_STATE_KEY);
    } else {
      this.kv.put(MANAGED_INSTALLATION_STATE_KEY, { state: installation.state, revision });
    }
    return revision;
  }

  /** Forgets the gate's last confirmation; a record stands until Accounts reports a newer one. */
  invalidate(): void {
    this.gate.invalidate();
  }

  private recorded(): RecordedInstallationState | undefined {
    return this.kv.get<RecordedInstallationState>(MANAGED_INSTALLATION_STATE_KEY);
  }

  private async askAccounts(): Promise<ManagedInstallationWorkGate> {
    const installation = await lookupManagedInstallation(this.bindings, this.installationId());
    if ("allowed" in installation) return installation;
    const held = this.follow(installation);
    // A notice that arrived while Accounts answered may already hold a newer state.
    const newer = held !== undefined && installation.stateRevision !== undefined && held > installation.stateRevision
      ? this.recorded()
      : undefined;
    return workGate(this.bindings, newer ?? installation);
  }
}

/** Accounts' entry for the installation, or the refusal that stands in for one. */
async function lookupManagedInstallation(
  bindings: ManagedInstallationLifecycleBindings,
  installationIdValue: string,
): Promise<ResolvedManagedInstallation | ManagedInstallationWorkGate> {
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
  return result;
}

function workGate(
  bindings: ManagedInstallationLifecycleBindings,
  installation: Pick<ResolvedManagedInstallation, "state" | "ownerSetupRecovery">,
): ManagedInstallationWorkGate {
  if (installation.state === "active") return { allowed: true };
  if (installation.state === "provisioning") {
    return { allowed: false, code: 503, message: "Finish setting up your Ship", details: setupRecoveryDetails(bindings, installation) };
  }
  return installation.state === "restricted"
    ? { allowed: false, code: 423, message: "Managed installation is suspended" }
    : UNAVAILABLE;
}
