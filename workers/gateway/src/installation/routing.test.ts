import { env } from "cloudflare:workers";
import type { InstallationDirectoryResult } from "@humansandmachines/gsv/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import gateway from "../index";
import {
  conversationDurableObjectName,
  getKernelByInstallationId,
  parseConversationDurableObjectName,
  parseProcessDurableObjectName,
  processDurableObjectName,
  resolveInstallationRoute,
} from "./routing";

describe("installation routing", () => {

  it("round-trips installation-scoped Process names", () => {
    expect(processDurableObjectName("inst_first", "proc:one")).toBe(
      "process:inst_first:proc%3Aone",
    );
    expect(parseProcessDurableObjectName(
      processDurableObjectName("inst:first", "proc:one"),
    )).toEqual({ installationId: "inst:first", pid: "proc:one" });
    expect(processDurableObjectName("inst_second", "proc:one"))
      .not.toBe(processDurableObjectName("inst_first", "proc:one"));
    expect(processDurableObjectName("inst:first", "proc:one"))
      .not.toBe(processDurableObjectName("inst", "first:proc:one"));
  });

  it("rejects unnamed and malformed Process identities", () => {
    expect(() => parseProcessDurableObjectName(undefined))
      .toThrow("must be accessed by name");
    expect(() => parseProcessDurableObjectName("process:one"))
      .toThrow("name is invalid");
    expect(() => parseProcessDurableObjectName("process:inst_first:"))
      .toThrow("name is invalid");
    expect(() => parseProcessDurableObjectName("proc:one"))
      .toThrow("name is invalid");
  });

  it("round-trips installation-scoped Conversation names", () => {
    expect(conversationDurableObjectName("inst_first", "conv:home")).toBe(
      "conversation:inst_first:conv%3Ahome",
    );
    expect(parseConversationDurableObjectName(
      conversationDurableObjectName("inst:first", "conv:home"),
    )).toEqual({ installationId: "inst:first", conversationId: "conv:home" });
    expect(conversationDurableObjectName("inst_second", "conv:home"))
      .not.toBe(conversationDurableObjectName("inst_first", "conv:home"));
  });

  it("rejects unnamed and malformed Conversation identities", () => {
    expect(() => parseConversationDurableObjectName(undefined))
      .toThrow("must be accessed by name");
    expect(() => parseConversationDurableObjectName("conversation:one"))
      .toThrow("name is invalid");
    expect(() => parseConversationDurableObjectName("conversation:inst_first:"))
      .toThrow("name is invalid");
    expect(() => parseConversationDurableObjectName("conv:home"))
      .toThrow("name is invalid");
  });

  it.each([
    { state: "active", path: "/ws" },
    { state: "provisioning", path: "/ws" },
    { state: "active", path: "/public/retained.txt" },
    { state: "active", path: "/@person" },
    { state: "provisioning", path: "/@person" },
    { state: "active", path: "/_gsv/federation/v2/subjects/subject%3Aone" },
  ])("rejects the historical Kernel identity on $state $path before namespace or asset access", async ({ state, path }) => {
    let installationId = "singleton";
    const resolveHostname = vi.fn(async () => ({
      found: true, state, installationId, handle: "accepted", canonicalOrigin: "https://accepted.example",
    }));
    const ensureInstallationIdentity = vi.fn(async () => {});
    const fetch = vi.fn(async () => new Response("Scoped Kernel"));
    // SAFETY: HTTP routing uses only identity initialization and fetch on this selected stub.
    const getByName = vi.spyOn(env.KERNEL, "getByName").mockReturnValue({ ensureInstallationIdentity, fetch } as never);
    const getAsset = vi.spyOn(env.STORAGE, "get").mockResolvedValue(null);
    const headAsset = vi.spyOn(env.STORAGE, "head").mockResolvedValue(null);
    const previous = Object.getOwnPropertyDescriptor(env, "INSTALLATION_DIRECTORY");
    Object.defineProperty(env, "INSTALLATION_DIRECTORY", { configurable: true, value: { resolveHostname } });
    try {
      const request = new Request(`https://accepted.example${path}`, {
        headers: path === "/ws" ? { upgrade: "websocket" } : {},
      });
      const denied = await gateway.fetch(request, env);
      expect(denied.status).toBe(404);
      await denied.arrayBuffer();
      expect(resolveHostname).toHaveBeenCalledExactlyOnceWith("accepted.example");
      expect(getByName).not.toHaveBeenCalled();
      expect(ensureInstallationIdentity).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(getAsset).not.toHaveBeenCalled();
      expect(headAsset).not.toHaveBeenCalled();

      installationId = "inst_current";
      const control = await gateway.fetch(new Request("https://accepted.example/ws", {
        headers: { upgrade: "websocket" },
      }), env);
      expect(control.status).toBe(200);
      await control.arrayBuffer();
      expect(getByName).toHaveBeenCalledExactlyOnceWith("inst_current");
      expect(ensureInstallationIdentity).toHaveBeenCalledExactlyOnceWith({
        installationId: "inst_current", handle: "accepted", canonicalOrigin: "https://accepted.example",
      });
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      if (previous) Object.defineProperty(env, "INSTALLATION_DIRECTORY", previous);
      else Reflect.deleteProperty(env, "INSTALLATION_DIRECTORY");
      getByName.mockRestore();
      getAsset.mockRestore();
      headAsset.mockRestore();
    }
  });

  it("fences the historical name for every live Kernel helper caller", async () => {
    const getByName = vi.spyOn(env.KERNEL, "getByName");
    try {
      await expect(getKernelByInstallationId(env.KERNEL, "singleton"))
        .rejects.toThrow("Historical singleton Kernel");
      expect(getByName).not.toHaveBeenCalled();
      await getKernelByInstallationId(env.KERNEL, "inst_current");
      expect(getByName).toHaveBeenCalledExactlyOnceWith("inst_current");
    } finally {
      getByName.mockRestore();
    }
  });

  it("fails closed without a directory instead of deriving identity from the request", async () => {
    const getByName = vi.spyOn(env.KERNEL, "getByName");
    const previous = Object.getOwnPropertyDescriptor(env, "INSTALLATION_DIRECTORY");
    Object.defineProperty(env, "INSTALLATION_DIRECTORY", { configurable: true, value: undefined });
    try {
      await expect(resolveInstallationRoute(new Request("http://localhost:8787/ws")))
        .rejects.toThrow("Installation directory is not configured");
      expect(getByName).not.toHaveBeenCalled();
    } finally {
      if (previous) Object.defineProperty(env, "INSTALLATION_DIRECTORY", previous);
      else Reflect.deleteProperty(env, "INSTALLATION_DIRECTORY");
      getByName.mockRestore();
    }
  });
});

describe("remembered hostname routes", () => {
  const ACTIVE: InstallationDirectoryResult = {
    found: true, state: "active", installationId: "inst_routes", handle: "routes", canonicalOrigin: "https://routes.example",
  };
  let restoreDirectory: (() => void) | undefined;

  afterEach(() => {
    restoreDirectory?.();
    restoreDirectory = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Installs a directory that answers every hostname with what `answer` returns at the time it is asked. */
  function directory(answer: (hostname: string) => Promise<InstallationDirectoryResult>) {
    const resolveHostname = vi.fn(answer);
    const previous = Object.getOwnPropertyDescriptor(env, "INSTALLATION_DIRECTORY");
    Object.defineProperty(env, "INSTALLATION_DIRECTORY", { configurable: true, value: { resolveHostname } });
    restoreDirectory = () => {
      if (previous) Object.defineProperty(env, "INSTALLATION_DIRECTORY", previous);
      else Reflect.deleteProperty(env, "INSTALLATION_DIRECTORY");
    };
    return resolveHostname;
  }

  /** A public read answered before any Kernel is addressed. */
  async function metadata(hostname = "routes.example"): Promise<number> {
    const response = await gateway.fetch(new Request(`https://${hostname}/.well-known/oauth-client/gsv.json`), env);
    await response.arrayBuffer();
    return response.status;
  }

  async function connect(): Promise<number> {
    const response = await gateway.fetch(new Request("https://routes.example/ws", { headers: { upgrade: "websocket" } }), env);
    await response.arrayBuffer();
    return response.status;
  }

  it("answers public reads from an active route for a minute, then asks Accounts again", async () => {
    vi.useFakeTimers();
    const resolveHostname = directory(async () => ACTIVE);
    expect(await metadata()).toBe(200);
    expect(await metadata()).toBe(200);
    expect(resolveHostname).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(59_999);
    expect(await metadata()).toBe(200);
    expect(resolveHostname).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(await metadata()).toBe(200);
    expect(resolveHostname).toHaveBeenCalledTimes(2);
  });

  it("shares one lookup among concurrent public reads of a hostname", async () => {
    const answers: Array<(result: InstallationDirectoryResult) => void> = [];
    const resolveHostname = directory(() => new Promise((resolve) => { answers.push(resolve); }));
    const reads = Promise.all([metadata(), metadata(), metadata()]);
    await vi.waitFor(() => expect(resolveHostname).toHaveBeenCalled());
    for (const answer of answers) answer(ACTIVE);
    expect(await reads).toEqual([200, 200, 200]);
    expect(resolveHostname).toHaveBeenCalledOnce();
  });

  it.each<[string, InstallationDirectoryResult]>([
    ["an unknown", { found: false }],
    ["a provisioning", { ...ACTIVE, state: "provisioning" }],
    ["a suspended", { ...ACTIVE, state: "restricted" }],
    ["the historical", { ...ACTIVE, installationId: "singleton" }],
  ])("never remembers %s installation's hostname", async (_label, result) => {
    const resolveHostname = directory(async () => result);
    expect(await metadata()).toBe(404);
    expect(await metadata()).toBe(404);
    expect(resolveHostname).toHaveBeenCalledTimes(2);
  });

  it("asks Accounts for every connection, and forgets a route Accounts no longer gives", async () => {
    let answer = ACTIVE;
    const resolveHostname = directory(async () => answer);
    const fetch = vi.fn(async () => new Response("Scoped Kernel"));
    // SAFETY: HTTP routing uses only identity initialization and fetch on this selected stub.
    vi.spyOn(env.KERNEL, "getByName").mockReturnValue({ ensureInstallationIdentity: vi.fn(async () => {}), fetch } as never);
    expect(await metadata()).toBe(200);
    expect(await connect()).toBe(200);
    expect(await connect()).toBe(200);
    expect(resolveHostname).toHaveBeenCalledTimes(3);

    answer = { ...ACTIVE, state: "restricted" };
    expect(await connect()).toBe(404);
    expect(await metadata()).toBe(404);
    expect(resolveHostname).toHaveBeenCalledTimes(5);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("forgets a remembered route once the Kernel it names refuses the request", async () => {
    const resolveHostname = directory(async () => ACTIVE);
    const ensureInstallationIdentity = vi.fn(async () => {}).mockRejectedValueOnce(new Error("Installation is retired"));
    // SAFETY: HTTP routing uses only identity initialization on this selected stub before serving the web app.
    vi.spyOn(env.KERNEL, "getByName").mockReturnValue({ ensureInstallationIdentity } as never);
    vi.spyOn(env.ASSETS, "fetch").mockImplementation(async () => new Response("app"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = async () => {
      const response = await gateway.fetch(new Request("https://routes.example/settings"), env);
      await response.arrayBuffer();
      return response.status;
    };
    expect(await metadata()).toBe(200);
    expect(await app()).toBe(503);
    expect(await app()).toBe(200);
    expect(resolveHostname).toHaveBeenCalledTimes(2);
  });

  it("remembers a bounded number of hostnames, the oldest giving way first", async () => {
    const resolveHostname = directory(async (hostname) => ({ ...ACTIVE, canonicalOrigin: `https://${hostname}` }));
    for (let index = 0; index <= 1_024; index++) expect(await metadata(`ship-${index}.example`)).toBe(200);
    expect(resolveHostname).toHaveBeenCalledTimes(1_025);
    expect(await metadata("ship-1024.example")).toBe(200);
    expect(await metadata("ship-1.example")).toBe(200);
    expect(resolveHostname).toHaveBeenCalledTimes(1_025);
    expect(await metadata("ship-0.example")).toBe(200);
    expect(resolveHostname).toHaveBeenCalledTimes(1_026);
  });

  it("answers that the Ship is briefly unreachable when Accounts cannot route its hostname in time", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    directory(() => new Promise(() => {}));
    const stalled = gateway.fetch(new Request("https://routes.example/.well-known/oauth-client/gsv.json"), env);
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await stalled;
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.text()).toBe("Ship is briefly unreachable; try again in a moment");
    expect(warn).toHaveBeenCalledWith("[Gateway] Accounts route lookup failed:", expect.objectContaining({ exceptionMessage: "Accounts lookup timed out" }));
  }, 2_000);

  it("answers that the Ship is briefly unreachable when Accounts fails, without remembering the failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const resolveHostname = directory(async () => ACTIVE).mockRejectedValueOnce(new Error("Accounts unavailable"));
    const failed = await gateway.fetch(new Request("https://routes.example/.well-known/oauth-client/gsv.json"), env);
    expect(failed.status).toBe(503);
    expect(await failed.text()).toBe("Ship is briefly unreachable; try again in a moment");
    expect(await metadata()).toBe(200);
    expect(resolveHostname).toHaveBeenCalledTimes(2);
  });
});
