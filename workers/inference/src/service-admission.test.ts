import { env, exports } from "cloudflare:workers";
import { listDurableObjectIds } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";
import { getInferenceExecutor, type InferenceServiceEnvironment } from "@humansandmachines/gsv-inference/executor";

describe("inference directory admission", () => {
  it("denies missing, failed and mismatched directory authority before allocating state", async () => {
    const before = await listDurableObjectIds(env.INFERENCE_EXECUTORS);
    const denied: InstallationDirectoryService[] = [
      { resolveHostname: async () => ({ found: false }), resolveInstallation: async () => { throw new Error("Directory unavailable"); } },
      { resolveHostname: async () => ({ found: false }), resolveInstallation: async () => ({
        found: true, installationId: "another_space", state: "active", handle: "another", canonicalOrigin: "https://another.example.invalid",
      }) },
    ];
    for (const directory of denied) {
      await expect(getInferenceExecutor({ ...env, INSTALLATION_DIRECTORY: directory }, "space_admission_denied")).rejects.toThrow();
    }
    const missing: InferenceServiceEnvironment = { ...env };
    Reflect.deleteProperty(missing, "INSTALLATION_DIRECTORY");
    await expect(getInferenceExecutor(missing, "space_admission_denied")).rejects.toThrow();
    expect(await listDurableObjectIds(env.INFERENCE_EXECUTORS)).toHaveLength(before.length);
  });

  it("keeps public HTTP closed while execution is exposed through service bindings", async () => {
    expect((await exports.default.fetch("https://inference.example.invalid/")).status).toBe(404);
    expect((await exports.InferenceService.fetch("https://inference.example.invalid/")).status).toBe(404);
  });
});
