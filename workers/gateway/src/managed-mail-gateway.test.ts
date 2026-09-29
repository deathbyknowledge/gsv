import { describe, expect, it, vi } from "vitest";
import { GatewayEntrypoint } from "./index";

describe("outbound mail reference resolution", () => {
  function fixture() {
    const resolveOutboundMailReference = vi.fn(async (_lookup: { outboundId: string }) => ({
      version: 1 as const, outboundId: "mail-outbound:lookup", fingerprint: `sha256:${"a".repeat(64)}`,
    }));
    const resolveInstallation = vi.fn(async () => ({
      found: true as const, state: "active" as const, installationId: "installation-hank",
      handle: "hank", canonicalOrigin: "https://hank.gsv.space",
    }));
    const getByName = vi.fn(() => ({ resolveOutboundMailReference }));
    // SAFETY: Only the entrypoint methods are exercised with this injected test environment.
    const gateway = Object.create(GatewayEntrypoint.prototype) as GatewayEntrypoint;
    Object.defineProperty(gateway, "env", {
      value: { INSTALLATION_DIRECTORY: { resolveInstallation }, KERNEL: { getByName } },
    });
    return { gateway, resolveInstallation, getByName, resolveOutboundMailReference };
  }

  it("uses only the exact admitted installation and forwards its immutable outbound id", async () => {
    const f = fixture();
    const lookup = Object.freeze({ outboundId: "mail-outbound:lookup" });
    const installation = Object.freeze({ installationId: "installation-hank" });
    expect(await f.gateway.resolveOutboundMailReference(installation, lookup)).toEqual({
      version: 1, outboundId: lookup.outboundId, fingerprint: `sha256:${"a".repeat(64)}`,
    });
    expect(f.resolveInstallation).toHaveBeenCalledWith(installation.installationId);
    expect(f.getByName).toHaveBeenCalledWith(installation.installationId);
    expect(f.resolveOutboundMailReference).toHaveBeenCalledWith(lookup);
  });

  it.each(["restricted", "retained", "deleting", "deleted"] as const)("rejects %s before addressing a Kernel", async (state) => {
    const f = fixture();
    // SAFETY: The directory fixture deliberately exercises each valid non-active response state.
    f.resolveInstallation.mockResolvedValue({ found: true, state, installationId: "installation-hank", handle: "hank", canonicalOrigin: "https://hank.gsv.space" } as never);
    await expect(f.gateway.resolveOutboundMailReference({ installationId: "installation-hank" }, { outboundId: "mail-outbound:lookup" })).rejects.toThrow();
    expect(f.getByName).not.toHaveBeenCalled();
  });

  it("rejects a missing or mismatched directory identity before allocating a Kernel", async () => {
    const f = fixture();
    // SAFETY: The fixture models an authoritative missing directory result.
    f.resolveInstallation.mockResolvedValueOnce({ found: false } as never);
    await expect(f.gateway.resolveOutboundMailReference({ installationId: "installation-hank" }, { outboundId: "mail-outbound:lookup" })).rejects.toThrow("unavailable");
    f.resolveInstallation.mockResolvedValueOnce({ found: true, state: "active", installationId: "installation-other", handle: "other", canonicalOrigin: "https://other.gsv.space" });
    await expect(f.gateway.resolveOutboundMailReference({ installationId: "installation-hank" }, { outboundId: "mail-outbound:lookup" })).rejects.toThrow("unavailable");
    expect(f.getByName).not.toHaveBeenCalled();
  });

  it("propagates directory failures and rejects malformed installation ids", async () => {
    const f = fixture();
    await expect(f.gateway.resolveOutboundMailReference({ installationId: "../foreign" }, { outboundId: "mail-outbound:lookup" })).rejects.toThrow();
    expect(f.resolveInstallation).not.toHaveBeenCalled();
    f.resolveInstallation.mockRejectedValueOnce(new Error("Directory unavailable"));
    await expect(f.gateway.resolveOutboundMailReference({ installationId: "installation-hank" }, { outboundId: "mail-outbound:lookup" })).rejects.toThrow("unavailable");
    expect(f.getByName).not.toHaveBeenCalled();
  });
});

describe.each([
  { accept: "acceptManagedInboundMail", complete: "completeManagedOutboundMail", claim: "claimManagedOutboundMail" },
  { accept: "acceptInboundMail", complete: "completeOutboundMail", claim: "claimOutboundMail" },
] as const)("mail Gateway routing through $accept", ({ accept, complete, claim }) => {
  it("checks the installation directory before addressing a Kernel and cancels the body", async () => {
    const resolveInstallation = vi.fn(async () => ({ found: false as const }));
    const getByName = vi.fn(() => {
      throw new Error("Kernel must not be addressed");
    });
    // SAFETY: The prototype instance is used to exercise the entrypoint methods with an injected test environment.
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

    await expect(gateway[accept](
      { installationId: "installation-unknown" },
      // SAFETY: The request metadata is unused by this boundary test.
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
    // SAFETY: The prototype instance is used to exercise the entrypoint methods with an injected test environment.
    const gateway = Object.create(GatewayEntrypoint.prototype) as GatewayEntrypoint;
    Object.defineProperty(gateway, "env", {
      value: {
        INSTALLATION_DIRECTORY: { resolveInstallation },
        KERNEL: { getByName },
      },
    });
    const cancel = vi.fn();

    await expect(gateway[accept](
      { installationId: "../not-an-installation" },
      // SAFETY: The request metadata is unused by this boundary test.
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
    // SAFETY: The prototype instance is used to exercise the entrypoint methods with an injected test environment.
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

    await expect(gateway[claim](
      { installationId: "installation-hank" },
      reference,
    )).rejects.toThrow("suspended");
    await expect(gateway[complete](
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
    // SAFETY: The prototype instance is used to exercise the entrypoint methods with an injected test environment.
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

    await expect(gateway[complete](
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
    // SAFETY: The prototype instance is used to exercise the entrypoint methods with an injected test environment.
    const gateway = Object.create(GatewayEntrypoint.prototype) as GatewayEntrypoint;
    Object.defineProperty(gateway, "env", {
      value: {
        INSTALLATION_DIRECTORY: { resolveInstallation },
        KERNEL: { getByName },
      },
    });

    await expect(gateway[complete](
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
    // SAFETY: The prototype instance is used to exercise the entrypoint methods with an injected test environment.
    const gateway = Object.create(GatewayEntrypoint.prototype) as GatewayEntrypoint;
    Object.defineProperty(gateway, "env", {
      value: {
        INSTALLATION_DIRECTORY: { resolveInstallation },
        KERNEL: { getByName },
      },
    });

    await expect(gateway[complete](
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
