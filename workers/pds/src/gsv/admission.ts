import type { InstallationDirectoryService, InstallationState } from "@humansandmachines/gsv/services/directory";
import type { HostedRepo } from "../host/repo";
import { XrpcError, type Admission } from "../host/xrpc";

/** States in which Accounts is retiring an installation and its data. */
const RETIRED: ReadonlySet<InstallationState> = new Set(["retained", "deleting", "deleted"]);
/** How many changes an installation's account follows in one call before it leaves the rest to a later one. */
const FOLLOW_ATTEMPTS = 3;

/**
 * Whether Accounts admits public reads of an installation's repository, by the
 * name of the object that holds it. Only an active installation is served; a
 * retired one reads as deleted and any other state as suspended.
 */
export async function admitInstallation(directory: InstallationDirectoryService, name: string): Promise<Admission> {
  let route: Awaited<ReturnType<InstallationDirectoryService["resolveInstallation"]>>;
  try {
    route = await directory.resolveInstallation(name);
  } catch (error) {
    console.error("Installation lookup failed", error);
    throw new XrpcError("UpstreamFailure", "Could not check the repository's installation", 502);
  }
  if (!route.found || route.installationId !== name || RETIRED.has(route.state)) return "deleted";
  return route.state === "active" ? "active" : "suspended";
}

/**
 * Has an installation's account follow Accounts' state for it: suspended
 * while the installation is restricted, and active once it is reactivated.
 * Accounts may change the state again meanwhile, so the account follows each
 * read until a second read agrees. Deletion owns a retired installation's account.
 */
export async function followAdmission(
  directory: InstallationDirectoryService,
  installationId: string,
  repo: DurableObjectStub<HostedRepo>,
): Promise<void> {
  let admission = await admitInstallation(directory, installationId);
  for (let attempt = 0; attempt < FOLLOW_ATTEMPTS; attempt++) {
    // A retired installation's account reads as deleted from then on.
    if (admission === "deleted") return await repo.close();
    await repo.setSuspended(admission !== "active");
    const current = await admitInstallation(directory, installationId);
    if (current === admission) return;
    admission = current;
  }
  throw new Error("The installation's state kept changing while its account followed it");
}
