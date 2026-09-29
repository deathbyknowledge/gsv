import { WorkerEntrypoint } from "cloudflare:workers";
import type { InstallationDirectoryResult } from "@humansandmachines/gsv/protocol";
import { parseInstallationId } from "../installation/identity";

/** Unit-test admission for explicitly named fixture objects; never deployed. */
export class TestInstallationDirectory extends WorkerEntrypoint {
  resolveInstallation(installationId: string): InstallationDirectoryResult {
    return {
      found: true,
      installationId: parseInstallationId(installationId),
      handle: "test",
      canonicalOrigin: "http://localhost",
      state: "active",
    };
  }

  resolveHostname(hostname: string): InstallationDirectoryResult {
    return hostname === "localhost"
      ? this.resolveInstallation("inst_test")
      : { found: false };
  }
}
