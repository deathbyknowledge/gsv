import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
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
