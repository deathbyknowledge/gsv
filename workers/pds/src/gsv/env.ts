import type { InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";
import type { HostEnv } from "../host/env";

/** A host deployed for GSV: Accounts decides which installations it publishes for and serves. */
export interface PdsEnv extends HostEnv {
  INSTALLATION_DIRECTORY: InstallationDirectoryService;
  /** The handle of the account that publishes Ship's lexicons, such as lexicons.ship.space; without one, the host publishes none. */
  PDS_LEXICON_HANDLE?: string;
}
