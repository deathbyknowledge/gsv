import { describe, expect, it, vi } from "vitest";
import { GatewayEntrypoint } from "./index";

describe("managed mail Gateway routing", () => {
  it("checks the installation directory before addressing a Kernel and cancels the body", async () => {
    const resolveInstallation = vi.fn(async () => ({ found: false as const }));
    const idFromName = vi.fn(() => {
      throw new Error("Kernel must not be addressed");
    });
    const gateway = Object.create(GatewayEntrypoint.prototype) as GatewayEntrypoint;
    Object.defineProperty(gateway, "env", {
      value: {
        INSTALLATION_DIRECTORY: { resolveInstallation },
        KERNEL: { idFromName },
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
    expect(idFromName).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith("Managed mail Gateway request completed");
  });

  it("rejects malformed installation ids before directory or Kernel routing", async () => {
    const resolveInstallation = vi.fn();
    const idFromName = vi.fn();
    const gateway = Object.create(GatewayEntrypoint.prototype) as GatewayEntrypoint;
    Object.defineProperty(gateway, "env", {
      value: {
        INSTALLATION_DIRECTORY: { resolveInstallation },
        KERNEL: { idFromName },
      },
    });
    const cancel = vi.fn();

    await expect(gateway.acceptManagedInboundMail(
      { installationId: "../not-an-installation" },
      {} as never,
      { stream: new ReadableStream({ cancel }), length: 1 },
    )).rejects.toThrow();

    expect(resolveInstallation).not.toHaveBeenCalled();
    expect(idFromName).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
