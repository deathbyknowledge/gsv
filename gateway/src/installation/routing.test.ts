import { describe, expect, it } from "vitest";
import {
  conversationDurableObjectName,
  parseConversationDurableObjectName,
  parseProcessDurableObjectName,
  processDurableObjectName,
  resolveInstallationRoute,
} from "./routing";

describe("installation routing", () => {

  it("round-trips installation-scoped Process names", () => {
    expect(processDurableObjectName("singleton", "proc:one")).toBe("proc:one");
    expect(parseProcessDurableObjectName("proc:one"))
      .toEqual({ installationId: "singleton", pid: "proc:one" });
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
    expect(() => parseProcessDurableObjectName("process:singleton:proc%3Aone"))
      .toThrow("name is invalid");
    expect(() => processDurableObjectName("singleton", "process:inst:pid"))
      .toThrow("conflicts with managed Process addressing");
  });

  it("round-trips installation-scoped Conversation names", () => {
    expect(conversationDurableObjectName("singleton", "conv:home")).toBe("conv:home");
    expect(parseConversationDurableObjectName("conv:home"))
      .toEqual({ installationId: "singleton", conversationId: "conv:home" });
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
    expect(() => parseConversationDurableObjectName("conversation:singleton:conv%3Ahome"))
      .toThrow("name is invalid");
    expect(() => conversationDurableObjectName("singleton", "conversation:inst:conv"))
      .toThrow("conflicts with managed Conversation addressing");
  });

  it("routes standalone requests to the fixed compatibility identity", async () => {
    await expect(
      resolveInstallationRoute(new Request("http://localhost:8787/ws")),
    ).resolves.toEqual({
      identity: {
        installationId: "singleton",
        canonicalOrigin: "http://localhost:8787",
      },
    });
  });
});
