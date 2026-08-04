import type { ManagedGatewayExportInterface } from "@humansandmachines/gsv/protocol";
import type { PlatformAuthService } from "../auth/service";
import { parseOpaqueId } from "../domain";
import type { AccountStore, InstallationReservation } from "../store";
import type { InstallationLifecycleStore } from "../lifecycle/store";

export class InstallationExportUnavailableError extends Error {}
export class InstallationExportConflictError extends Error {}

export type InstallationExportResult = {
  installation: InstallationReservation;
  exportedAt: number;
  response: Response;
};

export class InstallationExportService {
  constructor(
    private readonly accounts: Pick<
      AccountStore,
      "getOwnedInstallation" | "recordInstallationExportRequested"
    >,
    private readonly lifecycle: Pick<
      InstallationLifecycleStore,
      "getActiveForInstallation"
    >,
    private readonly auth: Pick<PlatformAuthService, "requireRecentPasskeySession">,
    private readonly gateway: ManagedGatewayExportInterface,
  ) {}

  async create(input: {
    sessionToken: string;
    installationId: string;
    now?: number;
  }): Promise<InstallationExportResult> {
    const session = await this.auth.requireRecentPasskeySession(input.sessionToken);
    const installationId = parseOpaqueId(input.installationId, "installationId");
    const installation = await this.accounts.getOwnedInstallation(
      installationId,
      session.principal.id,
    );
    if (
      !installation
      || installation.operationState !== "complete"
      || installation.state === "reserved"
      || installation.state === "provisioning"
    ) {
      throw new Error("installation is unavailable");
    }
    const deletion = await this.lifecycle.getActiveForInstallation(installationId);
    if (deletion?.state === "deleting") {
      throw new InstallationExportConflictError(
        "installation teardown has already started",
      );
    }
    const exportedAt = timestamp(input.now ?? Date.now());
    await this.accounts.recordInstallationExportRequested({
      principalId: session.principal.id,
      installationId,
      now: exportedAt,
    });

    let response: Response;
    try {
      response = await this.gateway.exportManagedInstallation({
        installationId,
        requestedAt: exportedAt,
      });
    } catch {
      throw new InstallationExportUnavailableError(
        "installation export is temporarily unavailable",
      );
    }
    if (
      !response.ok
      || !response.body
      || response.headers.get("content-type")?.split(";", 1)[0] !== "application/x-tar"
      || response.headers.get("x-gsv-export-format") !== "1"
    ) {
      await response.body?.cancel("managed export response is invalid")
        .catch(() => undefined);
      throw new InstallationExportUnavailableError(
        "installation export is temporarily unavailable",
      );
    }
    return { installation, exportedAt, response };
  }
}

function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("export timestamp is invalid");
  }
  return value;
}
