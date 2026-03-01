import { describe, expect, it } from "vitest";
import { buildRpcRegistry, isMethodAllowedForMode } from "./rpc-registry";
import { buildRpcHandlers } from "./rpc-handlers/";

describe("rpc registry", () => {
  it("marks connect as disconnected-safe", () => {
    const registry = buildRpcRegistry(buildRpcHandlers());
    expect(registry.connect?.allowDisconnected).toBe(true);
  });

  it("defaults all methods to connected-only dispatch", () => {
    const registry = buildRpcRegistry(buildRpcHandlers());

    for (const method of Object.keys(registry)) {
      if (!registry[method]) {
        continue;
      }
      if (method === "connect") {
        continue;
      }
      expect(registry[method]?.allowDisconnected).toBe(false);
    }
  });

  it("allows mode checks when no allowedModes configured", () => {
    const registry = buildRpcRegistry(buildRpcHandlers());

    for (const descriptor of Object.values(registry)) {
      if (!descriptor) {
        continue;
      }
      if (descriptor.allowedModes && descriptor.allowedModes.length > 0) {
        continue;
      }
      expect(isMethodAllowedForMode(descriptor, "client")).toBe(true);
      expect(isMethodAllowedForMode(descriptor, "node")).toBe(true);
      expect(isMethodAllowedForMode(descriptor, "channel")).toBe(true);
      expect(isMethodAllowedForMode(descriptor, undefined)).toBe(true);
    }
  });

  it("enforces configured mode restrictions", () => {
    const registry = buildRpcRegistry(buildRpcHandlers());

    expect(isMethodAllowedForMode(registry["tool.result"], "node")).toBe(true);
    expect(isMethodAllowedForMode(registry["tool.result"], "client")).toBe(false);
    expect(isMethodAllowedForMode(registry["logs.result"], "node")).toBe(true);
    expect(isMethodAllowedForMode(registry["logs.result"], "channel")).toBe(false);
    expect(isMethodAllowedForMode(registry["node.exec.event"], "node")).toBe(true);
    expect(isMethodAllowedForMode(registry["tool.invoke"], "node")).toBe(false);
    expect(isMethodAllowedForMode(registry["tool.request"], "client")).toBe(true);
    expect(isMethodAllowedForMode(registry["node.forget"], "client")).toBe(true);
    expect(isMethodAllowedForMode(registry["node.forget"], "node")).toBe(false);
    expect(isMethodAllowedForMode(registry["logs.get"], "client")).toBe(true);
  });
});
