import { describe, expect, it, vi } from "vitest";
import {
  normalizeHostname,
  resolveInstallationRoute,
  resolveInstallationTarget,
  type InstallationDirectoryService,
} from "./routing";
import { parseInstallationIdentity } from "./identity";

describe("installation routing", () => {
  it("routes standalone requests to the fixed compatibility identity", async () => {
    const identity = parseInstallationIdentity({
      installationId: "singleton",
      handle: "gsv",
      canonicalOrigin: "http://localhost:8787",
    });

    await expect(resolveInstallationRoute(
      new Request("http://localhost:8787/ws"),
      { kind: "standalone", identity },
    )).resolves.toEqual({
      source: "standalone",
      requestedHostname: "localhost",
      identity,
    });
  });

  it("normalizes a managed hostname before resolving it", async () => {
    const resolveHostname = vi.fn<InstallationDirectoryService["resolveHostname"]>(async () => ({
      found: true,
      installationId: "inst_hank",
      handle: "hank",
      canonicalOrigin: "https://hank.gsv.space",
      state: "active",
    }));

    const route = await resolveInstallationRoute(
      new Request("https://HANK.GSV.SPACE/ws"),
      { kind: "managed", directory: { resolveHostname } },
    );

    expect(resolveHostname).toHaveBeenCalledWith("hank.gsv.space");
    expect(route?.identity.installationId).toBe("inst_hank");
  });

  it.each(["provisioning", "suspended", "deleted"])(
    "does not route a managed installation in %s state",
    async (state) => {
      const directory: InstallationDirectoryService = {
        resolveHostname: async () => ({
          found: true,
          installationId: "inst_hank",
          handle: "hank",
          canonicalOrigin: "https://hank.gsv.space",
          state,
        }),
      };
      await expect(resolveInstallationRoute(
        new Request("https://hank.gsv.space/ws"),
        { kind: "managed", directory },
      )).resolves.toBeNull();
    },
  );

  it("does not open a Kernel for an unknown managed hostname", async () => {
    const open = vi.fn(async () => ({ opened: true }));
    const result = await resolveInstallationTarget(
      new Request("https://random.gsv.space/ws"),
      {
        kind: "managed",
        directory: { resolveHostname: async () => ({ found: false }) },
      },
      open,
    );

    expect(result).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("opens exactly the installation returned by the directory", async () => {
    const open = vi.fn(async (installationId: string) => `kernel:${installationId}`);
    const result = await resolveInstallationTarget(
      new Request("https://hank.gsv.space/ws"),
      {
        kind: "managed",
        directory: {
          resolveHostname: async () => ({
            found: true,
            installationId: "inst_hank",
            handle: "hank",
            canonicalOrigin: "https://hank.gsv.space",
            state: "active",
          }),
        },
      },
      open,
    );

    expect(open).toHaveBeenCalledWith("inst_hank");
    expect(result?.target).toBe("kernel:inst_hank");
  });

  it("validates hostnames without accepting ports or URL syntax", () => {
    expect(normalizeHostname("Hank.GSV.Space.")).toBe("hank.gsv.space");
    expect(() => normalizeHostname("hank.gsv.space:443")).toThrow("hostname is invalid");
    expect(() => normalizeHostname("user@hank.gsv.space")).toThrow("hostname is invalid");
  });
});
