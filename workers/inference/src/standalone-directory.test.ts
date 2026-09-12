import { env, exports } from "cloudflare:workers";
import { listDurableObjectIds } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";
import { getInferenceExecutor, type InferenceServiceEnvironment } from "@humansandmachines/gsv-inference/executor";

const canonicalOrigin = "https://legacy.example.com";
function directory(props: { authority?: string; canonicalOrigin?: string } = { authority: "standalone-inference", canonicalOrigin }) {
  const binding: unknown = exports.StandaloneInferenceDirectoryEntrypoint({ props });
  // SAFETY: The real Worker entrypoint implements the public directory RPC contract.
  return binding as InstallationDirectoryService;
}
function executionEnvironment(authority: InstallationDirectoryService): InferenceServiceEnvironment {
  return { ...env, INSTALLATION_DIRECTORY: authority };
}

describe("standalone inference compatibility admission", () => {
  it("resolves only the fixed legacy identity and never routes public hostnames", async () => {
    const legacy = directory();
    expect(await legacy.resolveInstallation("singleton")).toEqual({ found: true, installationId: "singleton", state: "active",
      handle: "singleton", canonicalOrigin });
    for (const id of ["space_a", "Singleton", "singleton/other", ""]) {
      expect(await legacy.resolveInstallation(id)).toEqual({ found: false });
    }
    expect(await legacy.resolveHostname("legacy.example.com")).toEqual({ found: false });
    expect(await legacy.resolveHostname("random.example.com")).toEqual({ found: false });
    expect((await exports.StandaloneInferenceDirectoryEntrypoint.fetch("https://legacy.example.com/")).status).toBe(404);
  });

  it("requires deployment authority before directory admission or executor allocation", async () => {
    const before = await listDurableObjectIds(env.INFERENCE_EXECUTORS);
    for (const props of [{}, { authority: "installation-deletion", canonicalOrigin }, { authority: "standalone-inference" }]) {
      const denied = directory(props);
      await expect(Promise.resolve(denied.resolveInstallation("singleton"))).rejects.toThrow("deployment authority");
      await expect(Promise.resolve(denied.resolveHostname("legacy.example.com"))).rejects.toThrow("deployment authority");
      await expect(getInferenceExecutor(executionEnvironment(denied), "singleton")).rejects.toThrow("deployment authority");
    }
    expect(await listDurableObjectIds(env.INFERENCE_EXECUTORS)).toHaveLength(before.length);
  });

  it("rejects foreign allocation and forged requests while the legacy executor remains usable", async () => {
    const configured = executionEnvironment(directory());
    const before = await listDurableObjectIds(env.INFERENCE_EXECUTORS);
    await expect(getInferenceExecutor(configured, "foreign-space")).rejects.toThrow("not active");
    expect(await listDurableObjectIds(env.INFERENCE_EXECUTORS)).toHaveLength(before.length);
    const executor = await getInferenceExecutor(configured, "singleton");
    const request = { version: 1 as const, installationId: "singleton", logicalRequestId: crypto.randomUUID(),
      actor: { localUid: 1000 }, timeoutMs: 10_000, deadlineAt: Date.now() + 10_000, kind: "transcription" as const,
      input: { provider: "workers-ai" as const, model: "@cf/openai/whisper-large-v3-turbo", maxInputBytes: 4 } };
    await expect(Promise.resolve(executor.media({ ...request, installationId: "foreign-space" }))).rejects.toThrow("scope mismatch");
    expect(await executor.media(request, new Response(new Uint8Array([1, 2])).body!))
      .toMatchObject({ kind: "transcription", result: { text: "transcribed" } });
  });
});
