import { describe, expect, it, vi } from "vitest";
import { GatewayEntrypoint } from "./index";

describe("managed mail Gateway routing", () => {
  it("checks the installation directory before addressing a Kernel and cancels the body", async () => {
    const resolveInstallation = vi.fn(async () => ({ found: false as const }));
    const getByName = vi.fn(() => {
      throw new Error("Kernel must not be addressed");
    });
    const gateway = Object.create(GatewayEntrypoint.prototype) as GatewayEntrypoint;
    Object.defineProperty(gateway, "env", {
      value: {
        INSTALLATION_DIRECTORY: { resolveInstallation },
        KERNEL: { getByName },
      },
    });
    const cancel = vi.fn();
    const body = {
      stream: new ReadableStream({ cancel }),
      length: 1,
    };

    await expect(gateway.acceptManagedInboundMail(
      { installationId: "installation-unknown" },
      {} as never,
      body,
    )).rejects.toThrow("Managed installation is unavailable");

    expect(resolveInstallation).toHaveBeenCalledWith("installation-unknown");
    expect(getByName).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith("Managed mail Gateway request completed");
  });

  it("rejects malformed installation ids before directory or Kernel routing", async () => {
    const resolveInstallation = vi.fn();
    const getByName = vi.fn();
    const gateway = Object.create(GatewayEntrypoint.prototype) as GatewayEntrypoint;
    Object.defineProperty(gateway, "env", {
      value: {
        INSTALLATION_DIRECTORY: { resolveInstallation },
        KERNEL: { getByName },
      },
    });
    const cancel = vi.fn();

    await expect(gateway.acceptManagedInboundMail(
      { installationId: "../not-an-installation" },
      {} as never,
      { stream: new ReadableStream({ cancel }), length: 1 },
    )).rejects.toThrow();

    expect(resolveInstallation).not.toHaveBeenCalled();
    expect(getByName).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("gates outbound claims but allows trusted transport settlement after restriction", async () => {
    const completeManagedOutboundMail = vi.fn(async () => undefined);
    const claimManagedOutboundMail = vi.fn(async () => ({
      status: "ready" as const,
      draft: {},
      body: { stream: new ReadableStream(), length: 0 },
    }));
    const kernel = { completeManagedOutboundMail, claimManagedOutboundMail };
    const resolveInstallation = vi.fn(async () => ({
      found: true as const,
      state: "restricted" as const,
      installationId: "installation-hank",
      handle: "hank",
      canonicalOrigin: "https://hank.gsv.space",
    }));
    const getByName = vi.fn(() => kernel);
    const gateway = Object.create(GatewayEntrypoint.prototype) as GatewayEntrypoint;
    Object.defineProperty(gateway, "env", {
      value: {
        INSTALLATION_DIRECTORY: { resolveInstallation },
        KERNEL: { getByName },
      },
    });
    const reference = {
      version: 1 as const,
      outboundId: "mail-outbound:test",
      fingerprint: `sha256:${"a".repeat(64)}`,
    };

    await expect(gateway.claimManagedOutboundMail(
      { installationId: "installation-hank" },
      reference,
    )).rejects.toThrow("suspended");
    await expect(gateway.completeManagedOutboundMail(
      { installationId: "installation-hank" },
      { ...reference, state: "failed", errorCode: "installation_inactive" },
    )).resolves.toBeUndefined();

    expect(claimManagedOutboundMail).not.toHaveBeenCalled();
    expect(completeManagedOutboundMail).toHaveBeenCalledWith({
      ...reference,
      state: "failed",
      errorCode: "installation_inactive",
    });
  });

  it("acknowledges completion for an authoritatively missing installation without a Kernel", async () => {
    const resolveInstallation = vi.fn(async () => ({ found: false as const }));
    const getByName = vi.fn(() => {
      throw new Error("Kernel must not be addressed");
    });
    const gateway = Object.create(GatewayEntrypoint.prototype) as GatewayEntrypoint;
    Object.defineProperty(gateway, "env", {
      value: {
        INSTALLATION_DIRECTORY: { resolveInstallation },
        KERNEL: { getByName },
      },
    });
    const completion = {
      version: 1 as const,
      outboundId: "mail-outbound:missing",
      fingerprint: `sha256:${"b".repeat(64)}`,
      state: "failed" as const,
      errorCode: "installation_inactive",
    };

    await expect(gateway.completeManagedOutboundMail(
      { installationId: "installation-missing" },
      completion,
    )).resolves.toBeUndefined();

    expect(resolveInstallation).toHaveBeenCalledWith("installation-missing");
    expect(getByName).not.toHaveBeenCalled();
  });

  it("rejects directory identity mismatch without allocating a Kernel", async () => {
    const resolveInstallation = vi.fn(async () => ({
      found: true as const,
      state: "active" as const,
      installationId: "installation-other",
      handle: "other",
      canonicalOrigin: "https://other.gsv.space",
    }));
    const getByName = vi.fn();
    const gateway = Object.create(GatewayEntrypoint.prototype) as GatewayEntrypoint;
    Object.defineProperty(gateway, "env", {
      value: {
        INSTALLATION_DIRECTORY: { resolveInstallation },
        KERNEL: { getByName },
      },
    });

    await expect(gateway.completeManagedOutboundMail(
      { installationId: "installation-missing" },
      {
        version: 1,
        outboundId: "mail-outbound:mismatch",
        fingerprint: `sha256:${"c".repeat(64)}`,
        state: "failed",
        errorCode: "installation_inactive",
      },
    )).rejects.toThrow("does not match");

    expect(getByName).not.toHaveBeenCalled();
  });

  it("propagates directory transport errors without allocating a Kernel", async () => {
    const resolveInstallation = vi.fn(async () => {
      throw new Error("directory unavailable");
    });
    const getByName = vi.fn();
    const gateway = Object.create(GatewayEntrypoint.prototype) as GatewayEntrypoint;
    Object.defineProperty(gateway, "env", {
      value: {
        INSTALLATION_DIRECTORY: { resolveInstallation },
        KERNEL: { getByName },
      },
    });

    await expect(gateway.completeManagedOutboundMail(
      { installationId: "installation-missing" },
      {
        version: 1,
        outboundId: "mail-outbound:transport",
        fingerprint: `sha256:${"d".repeat(64)}`,
        state: "failed",
        errorCode: "installation_inactive",
      },
    )).rejects.toThrow("directory unavailable");

    expect(getByName).not.toHaveBeenCalled();
  });
});
