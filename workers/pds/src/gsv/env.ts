import type { InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";
import type { HostEnv } from "../host/env";

/** A host deployed for GSV: Accounts decides which installations it publishes for and serves. */
export interface PdsEnv extends HostEnv {
  INSTALLATION_DIRECTORY: InstallationDirectoryService;
}
