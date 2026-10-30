import type {
  InstallationDirectoryResult,
  InstallationDirectoryService,
  InstallationState,
} from "@humansandmachines/gsv/services/directory";

/** Accounts as the host sees it: each installation's state, canonical hostname and preferred-domain alias. */
export class FakeAccounts implements InstallationDirectoryService {
  private readonly installations = new Map<string, { state: InstallationState; label: string }>();

  /** Adds an installation and returns its id and the hostname a Ship presents as its address. */
  add(state: InstallationState = "active") {
    const installationId = `inst_${crypto.randomUUID()}`;
    const label = installationId.slice("inst_".length);
    this.installations.set(installationId, { state, label });
    return { installationId, handle: `${label}.ship.test`, canonical: `${label}.gsv.test` };
  }

  setState(installationId: string, state: InstallationState): void {
    const installation = this.installations.get(installationId);
    if (!installation) throw new Error(`Unknown installation ${installationId}`);
    installation.state = state;
  }

  async resolveHostname(hostname: string): Promise<InstallationDirectoryResult> {
    for (const [installationId, { label }] of this.installations) {
      if (hostname === `${label}.gsv.test` || hostname === `${label}.ship.test`) return this.resolveInstallation(installationId);
    }
    return { found: false };
  }

  async resolveInstallation(installationId: string): Promise<InstallationDirectoryResult> {
    const installation = this.installations.get(installationId);
    if (!installation) return { found: false };
    return {
      found: true,
      installationId,
      state: installation.state,
      handle: installation.label,
      canonicalOrigin: `https://${installation.label}.gsv.test`,
    };
  }
}
