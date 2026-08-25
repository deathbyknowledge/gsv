import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { Kernel } from "./do";

describe("Kernel Durable Object RPC surface", () => {
  it("exposes only intentional Kernel RPC methods", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID()) as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;

    await runInDurableObject(kernel, (instance: Kernel) => {
      expect(Object.prototype.hasOwnProperty.call(instance, "applyUserKernelProjection")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(instance, "setState")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(instance, "sql")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(instance, "prepareRegisteredAppRunners"))
        .toBe(false);
      expect(Object.prototype.hasOwnProperty.call(
        instance,
        "consumeAppRunnerRuntimeFenceAuthorization",
      )).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(instance, "listPublicPackages")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(instance, "issueAppPlacementCertificate"))
        .toBe(false);
    });

    await expect(kernel.listPublicPackages()).resolves.toMatchObject({
      packages: expect.any(Array),
    });
    await expect(kernel.authorizeAppSessionRoute(
      "4f57c735-a614-4e0f-a36a-e5c60b94db15",
    )).resolves.toBe(false);
  }, 30_000);
});
