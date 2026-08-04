import { describe, expect, it, vi } from "vitest";
import type { ManagedGatewayExportInterface } from "@humansandmachines/gsv/protocol";
import type { PlatformAuthService } from "../auth/service";
import type { InstallationLifecycleStore } from "../lifecycle/store";
import type { AccountStore, InstallationReservation } from "../store";
import {
  InstallationExportConflictError,
  InstallationExportService,
  InstallationExportUnavailableError,
} from "./service";

describe("installation export service", () => {
  it("exports a restricted installation after recent passkey authentication", async () => {
    const fixture = exportFixture();
    const result = await fixture.service.create({
      sessionToken: "recent-passkey-session",
      installationId: "inst_export",
      now: 1_800_000_000_000,
    });

    expect(new TextDecoder().decode(await result.response.arrayBuffer())).toBe("archive");
    expect(fixture.auth.requireRecentPasskeySession).toHaveBeenCalledWith(
      "recent-passkey-session",
    );
    expect(fixture.accounts.getOwnedInstallation).toHaveBeenCalledWith(
      "inst_export",
      "principal_owner",
    );
    expect(fixture.accounts.recordInstallationExportRequested).toHaveBeenCalledWith({
      principalId: "principal_owner",
      installationId: "inst_export",
      now: 1_800_000_000_000,
    });
    expect(fixture.gateway.exportManagedInstallation).toHaveBeenCalledWith({
      installationId: "inst_export",
      requestedAt: 1_800_000_000_000,
    });
  });

  it("allows recoverable deletion but rejects export after teardown starts", async () => {
    const recoverable = exportFixture();
    recoverable.lifecycle.getActiveForInstallation.mockResolvedValueOnce({
      state: "recoverable",
    });
    await expect(recoverable.service.create({
      sessionToken: "session",
      installationId: "inst_export",
    })).resolves.toMatchObject({ installation: { state: "restricted" } });

    const deleting = exportFixture();
    deleting.lifecycle.getActiveForInstallation.mockResolvedValueOnce({
      state: "deleting",
    });
    await expect(deleting.service.create({
      sessionToken: "session",
      installationId: "inst_export",
    })).rejects.toBeInstanceOf(InstallationExportConflictError);
    expect(deleting.gateway.exportManagedInstallation).not.toHaveBeenCalled();
  });

  it("fails closed and cancels an invalid Gateway stream", async () => {
    const fixture = exportFixture();
    const cancel = vi.fn();
    fixture.gateway.exportManagedInstallation.mockResolvedValueOnce(new Response(
      new ReadableStream({ cancel }),
      { headers: { "content-type": "text/plain" } },
    ));

    await expect(fixture.service.create({
      sessionToken: "session",
      installationId: "inst_export",
    })).rejects.toBeInstanceOf(InstallationExportUnavailableError);
    expect(cancel).toHaveBeenCalledWith("managed export response is invalid");
  });
});

function exportFixture() {
  const installation: InstallationReservation = {
    installationId: "inst_export",
    handle: "private",
    canonicalOrigin: "https://private.gsv.space",
    ownerPrincipalId: "principal_owner",
    state: "restricted",
    provisionVersion: 1,
    reservationExpiresAt: null,
    operationId: "provision_export",
    operationState: "complete",
    ownerUsername: "owner",
    agentName: "companion",
    timezone: "UTC",
  };
  const auth = {
    requireRecentPasskeySession: vi.fn(async () => ({
      principal: { id: "principal_owner" },
    })),
  };
  const accounts = {
    getOwnedInstallation: vi.fn(async () => installation),
    recordInstallationExportRequested: vi.fn(async () => undefined),
  };
  const lifecycle = {
    getActiveForInstallation: vi.fn(async (): Promise<{ state: string } | null> => null),
  };
  const gateway = {
    exportManagedInstallation: vi.fn(async () => new Response("archive", {
      headers: {
        "content-type": "application/x-tar",
        "x-gsv-export-format": "1",
      },
    })),
  };
  return {
    auth,
    accounts,
    lifecycle,
    gateway,
    service: new InstallationExportService(
      accounts as unknown as AccountStore,
      lifecycle as unknown as InstallationLifecycleStore,
      auth as unknown as PlatformAuthService,
      gateway as unknown as ManagedGatewayExportInterface,
    ),
  };
}
