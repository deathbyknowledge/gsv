import { WorkerEntrypoint } from "cloudflare:workers";
import type { InstallationDirectoryResult, InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";

/** The native provider is synthetic; directory admission crosses an actual service binding. */
export class Directory extends WorkerEntrypoint<unknown, { authority?: string }> implements InstallationDirectoryService {
  async resolveHostname(hostname: string): Promise<InstallationDirectoryResult> {
    return this.resolveInstallation(hostname === "fixture.example.com" ? "inst_execution_fixture" : "unknown");
  }
  async resolveInstallation(installationId: string): Promise<InstallationDirectoryResult> {
    if (this.ctx.props.authority !== "inference-fixture") throw new Error("Fixture directory requires deployment authority");
    return installationId === "inst_execution_fixture"
      ? { found: true, installationId, handle: "fixture", canonicalOrigin: "https://fixture.example.com", state: "active" }
      : { found: false };
  }
}
export default { fetch: () => new Response("Not Found", { status: 404 }) };
