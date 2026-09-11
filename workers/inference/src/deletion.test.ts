import { env, exports } from "cloudflare:workers";
import { listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstallationDeletionRequest, InstallationDeletionService } from "@humansandmachines/gsv/services/lifecycle";
import type { InferenceExecutionService, InferenceExecutionRequest } from "@humansandmachines/gsv/services/inference-execution";
import { InferenceExecutor, type ExecutorEnvironment } from "@humansandmachines/gsv-inference/executor";

const serviceBinding: unknown = exports.default;
const lifecycleBinding: unknown = exports.InferenceLifecycleEntrypoint({ props: { authority: "installation-deletion" } });
const directoryBinding: unknown = env.INSTALLATION_DIRECTORY;
// SAFETY: The configured default entrypoint implements execution RPC.
const service = serviceBinding as InferenceExecutionService;
// SAFETY: The named entrypoint implements deletion RPC with the supplied binding authority.
const lifecycle = lifecycleBinding as InstallationDeletionService;
// SAFETY: The test directory adds setState to its ordinary directory interface.
const directory = directoryBinding as ExecutorEnvironment["INSTALLATION_DIRECTORY"] & { setState(id: string, state: string): Promise<void> };
function operation(installationId = `space_${crypto.randomUUID()}`): InstallationDeletionRequest { return { version: 1, installationId, operationId: crypto.randomUUID() }; }
function request(input: InstallationDeletionRequest): InferenceExecutionRequest {
  return { version: 1, installationId: input.installationId, logicalRequestId: crypto.randomUUID(), actor: { localUid: 1000 }, connection: { provider: "workers-ai", model: "@cf/zai-org/glm-5.3-flash", apiKey: "", maxTokens: 32, contextWindowTokens: null }, messages: [], timeoutMs: 10_000, deadlineAt: Date.now() + 10_000 };
}
afterEach(() => vi.unstubAllGlobals());

describe("inference application deletion", () => {
  it("requires deletion authority and retired directory state before allocation", async () => {
    const input = operation();
    const count = (await listDurableObjectIds(env.INFERENCE_EXECUTORS)).length;
    const unauthorized = exports.InferenceLifecycleEntrypoint({ props: {} });
    await expect(Promise.resolve(unauthorized.quiesceInstallation(input))).rejects.toThrow("authority");
    await expect(Promise.resolve(lifecycle.quiesceInstallation(input))).rejects.toThrow("retired");
    await directory.setState(input.installationId, "restricted");
    await expect(Promise.resolve(lifecycle.eraseInstallation(input))).rejects.toThrow("retired");
    expect(await listDurableObjectIds(env.INFERENCE_EXECUTORS)).toHaveLength(count);
  });

  it("does not grant deletion authority through an execution target", async () => {
    const input = operation();
    const target: unknown = await service.getExecutor(input.installationId);
    // SAFETY: Deliberately exercise an unauthorized RPC outside the public execution interface.
    const unauthorized = target as InstallationDeletionService;
    await expect(Promise.resolve(unauthorized.quiesceInstallation(input))).rejects.toThrow();
    await runInDurableObject(env.INFERENCE_EXECUTORS.getByName(input.installationId), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT * FROM inference_retirement").toArray()).toEqual([]);
    });
  });

  it("cancels an active body and fences late results, aborts, and restart writes", async () => {
    const input = operation();
    let bodyCancelled = false;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n')); },
      cancel() { bodyCancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } })));
    const executor = await service.getExecutor(input.installationId);
    const output = await executor.generateStream(request(input));
    const reader = output.getReader();
    await reader.read();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await directory.setState(input.installationId, "retained");
    expect(await lifecycle.quiesceInstallation(input)).toMatchObject({ phase: "quiesced" });
    await vi.waitFor(() => expect(bodyCancelled).toBe(true));
    await reader.cancel();
    expect(await lifecycle.eraseInstallation(input)).toMatchObject({ phase: "erased", outcome: "complete", pendingResources: 0 });
    await executor.abort("late-abort");
    await expect(Promise.resolve(executor.generate(request(input)))).rejects.toThrow("retired");
    await expect(Promise.resolve(lifecycle.eraseInstallation({ ...input, operationId: "different" }))).rejects.toThrow("immutable");
    await runInDurableObject(env.INFERENCE_EXECUTORS.getByName(input.installationId), async (_instance, state) => {
      const restarted = new InferenceExecutor(state, { INSTALLATION_DIRECTORY: directory });
      await restarted.abort("after-restart");
      await restarted.alarm();
      expect(state.storage.sql.exec("SELECT * FROM executor_requests").toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT * FROM executor_usage").toArray()).toEqual([]);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("resumes bounded erasure and preserves another installation", async () => {
    const input = operation();
    const other = operation();
    await service.getExecutor(input.installationId);
    const otherExecutor = await service.getExecutor(other.installationId);
    await otherExecutor.abort("other-request");
    await runInDurableObject(env.INFERENCE_EXECUTORS.getByName(input.installationId), (_instance, state) => {
      for (let index = 0; index < 405; index++) state.storage.sql.exec("INSERT INTO executor_requests (request_id,state,accepted_at,deadline_at,expires_at) VALUES (?,'completed',1,1,1)", `request_${index}`);
    });
    await directory.setState(input.installationId, "deleting");
    await expect(Promise.resolve(lifecycle.eraseInstallation(input))).rejects.toThrow("quiesce");
    await lifecycle.quiesceInstallation(input);
    expect(await lifecycle.eraseInstallation(input)).toMatchObject({ phase: "erasing", pendingResources: 205 });
    await lifecycle.eraseInstallation(input);
    const complete = await lifecycle.eraseInstallation(input);
    expect(complete).toMatchObject({ phase: "erased", pendingResources: 0 });
    expect(await lifecycle.eraseInstallation(input)).toEqual(complete);
    await runInDurableObject(env.INFERENCE_EXECUTORS.getByName(other.installationId), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT request_id FROM executor_requests").toArray()).toEqual([{ request_id: "other-request" }]);
    });
  });
});
