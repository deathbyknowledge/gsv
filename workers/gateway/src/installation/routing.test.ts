import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  conversationDurableObjectName,
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
