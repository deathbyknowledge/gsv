import type { InstallationDirectoryService, InstallationState } from "@humansandmachines/gsv/services/directory";
import { XrpcError, type Admission } from "../host/xrpc";
import { LEXICON_REPOSITORY } from "./lexicons";

/** States in which Accounts is retiring an installation and its data. */
const RETIRED: ReadonlySet<InstallationState> = new Set(["retained", "deleting", "deleted"]);

/**
 * Whether the deployment serves a repository's public reads, by the name of
 * the object that holds it. The lexicon account belongs to the deployment
 * rather than an installation, so Accounts isn't asked about it.
 */
export async function admitRepository(directory: InstallationDirectoryService, name: string): Promise<Admission> {
  return name === LEXICON_REPOSITORY ? "active" : admitInstallation(directory, name);
}

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
