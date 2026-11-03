import { env } from "cloudflare:workers";
import type { InstallationDirectoryResult } from "@humansandmachines/gsv/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import gateway from "./fetch";

const ACTIVE: InstallationDirectoryResult = {
  found: true, state: "active", installationId: "inst_http", handle: "http", canonicalOrigin: "https://http.example",
};

describe("Gateway HTTP routes", () => {
  let restoreDirectory: (() => void) | undefined;

  afterEach(() => {
    restoreDirectory?.();
    restoreDirectory = undefined;
    vi.restoreAllMocks();
  });

  function directory(result: InstallationDirectoryResult) {
    const resolveHostname = vi.fn(async () => result);
    const previous = Object.getOwnPropertyDescriptor(env, "INSTALLATION_DIRECTORY");
    Object.defineProperty(env, "INSTALLATION_DIRECTORY", { configurable: true, value: { resolveHostname } });
    restoreDirectory = () => {
      if (previous) Object.defineProperty(env, "INSTALLATION_DIRECTORY", previous);
      else Reflect.deleteProperty(env, "INSTALLATION_DIRECTORY");
    };
    return resolveHostname;
  }

  function kernel() {
    const ensureInstallationIdentity = vi.fn(async () => {});
    // SAFETY: HTTP routing uses only identity initialization on this selected stub.
    return vi.spyOn(env.KERNEL, "getByName").mockReturnValue({ ensureInstallationIdentity } as never);
  }

  it.each(["active", "provisioning"] as const)("serves the web app to a %s Ship without addressing its Kernel", async (state) => {
    directory({ ...ACTIVE, state });
    const getByName = kernel();
    vi.spyOn(env.ASSETS, "fetch").mockImplementation(async () => new Response("app"));
    const response = await gateway.fetch(new Request("https://http.example/settings"), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("app");
    expect(getByName).not.toHaveBeenCalled();
  });

  it("serves the web app only on a hostname Accounts routes", async () => {
    directory({ found: false });
    const fetchAsset = vi.spyOn(env.ASSETS, "fetch");
    const response = await gateway.fetch(new Request("https://unknown.example/"), env);
    expect(response.status).toBe(404);
    await response.arrayBuffer();
    expect(fetchAsset).not.toHaveBeenCalled();
  });

  it("answers a request no route serves without asking Accounts", async () => {
    const resolveHostname = directory(ACTIVE);
    const getByName = kernel();
    const response = await gateway.fetch(new Request("https://http.example/settings", { method: "POST" }), env);
    expect(response.status).toBe(404);
    await response.arrayBuffer();
    expect(resolveHostname).not.toHaveBeenCalled();
    expect(getByName).not.toHaveBeenCalled();
  });
});
