import { WorkerEntrypoint } from "cloudflare:workers";
import type { InstallationDirectoryResult, InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";

/** Only the legacy inference Worker binds this compatibility entrypoint, until W7. */
export class StandaloneInferenceDirectoryEntrypoint extends WorkerEntrypoint<unknown, {
  authority?: string; canonicalOrigin?: string;
}> implements InstallationDirectoryService {
  async fetch(): Promise<Response> { return new Response("Not Found", { status: 404 }); }

  private origin(): string {
    const props = this.ctx.props;
    if (props.authority !== "standalone-inference" || !props.canonicalOrigin) {
      throw new Error("Standalone inference directory requires deployment authority");
    }
    const origin = new URL(props.canonicalOrigin);
    if (!["https:", "http:"].includes(origin.protocol) || origin.origin !== props.canonicalOrigin) {
      throw new Error("Standalone inference directory requires the Gateway origin");
    }
    return origin.origin;
  }

  async resolveHostname(_hostname: string): Promise<InstallationDirectoryResult> {
    this.origin();
    return { found: false };
  }

  async resolveInstallation(installationId: string): Promise<InstallationDirectoryResult> {
    const canonicalOrigin = this.origin();
    return installationId === "singleton"
      ? { found: true, installationId: "singleton", state: "active", handle: "singleton", canonicalOrigin }
      : { found: false };
  }
}
