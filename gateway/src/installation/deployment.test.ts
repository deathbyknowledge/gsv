import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type {
  InstallationDirectoryService,
  InstallationOnboardingService,
} from "@humansandmachines/gsv/protocol";
import {
  getGatewayDeployment,
  isManagedGatewayDeployment,
} from "./deployment";

describe("Gateway deployment configuration", () => {
  it("preserves the standalone compatibility defaults", () => {
    expect(getGatewayDeployment({ ...env })).toEqual({
      kind: "standalone",
      installationId: "singleton",
      handle: "gsv",
    });
  });

  it("parses configured standalone identity", () => {
    expect(getGatewayDeployment({
      ...env,
      GSV_INSTALLATION_ID: "inst_local",
      GSV_INSTALLATION_HANDLE: "local",
      GSV_CANONICAL_ORIGIN: "https://local.example.com",
    })).toEqual({
      kind: "standalone",
      installationId: "inst_local",
      handle: "local",
      canonicalOrigin: "https://local.example.com",
    });
  });

  it("uses the installation directory as the managed deployment discriminator", () => {
    const directory: InstallationDirectoryService & InstallationOnboardingService = {
      resolveHostname: vi.fn(async () => ({ found: false })),
      verifyLoginHandoff: vi.fn(async () => ({ ok: false })),
      authorizeInstallationOnboarding: vi.fn(async () => ({ ok: false })),
      completeInstallationOnboarding: vi.fn(async (input) => ({
        state: "complete",
        installationId: input.installationId,
      })),
    };
    const deployment = getGatewayDeployment({
      ...env,
      INSTALLATION_DIRECTORY: directory,
      GSV_INSTALLATION_ID: "not valid in a standalone deployment",
    });

    expect(deployment).toEqual({ kind: "managed", directory });
    expect(isManagedGatewayDeployment({ ...env, INSTALLATION_DIRECTORY: directory })).toBe(true);
  });

  it("does not infer managed mode from other managed bindings", () => {
    expect(isManagedGatewayDeployment({ ...env, MANAGED_INFERENCE: {} })).toBe(false);
    expect(isManagedGatewayDeployment(undefined)).toBe(false);
  });

  it("rejects invalid standalone deployment values at the boundary", () => {
    expect(() => getGatewayDeployment({
      ...env,
      GSV_INSTALLATION_HANDLE: "Not A Handle",
    })).toThrow("installation handle is invalid");
    expect(() => getGatewayDeployment({
      ...env,
      GSV_CANONICAL_ORIGIN: "",
    })).toThrow("canonicalOrigin must be an absolute URL origin");
  });
});
