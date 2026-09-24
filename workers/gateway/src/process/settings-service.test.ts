import type { AiConfigResult } from "@humansandmachines/gsv/protocol";
import { describe, expect, it, vi } from "vitest";
import { createProcessAiConfig } from "./ai-config";
import { initProcess, ROOT_IDENTITY, runInProcess, processTestConfig } from "./do-test-harness";

describe("Process model selection recovery", () => {
  it("persists removal of a missing model preference while retaining reasoning", async () => {
    const stub = await initProcess("model-recovery", ROOT_IDENTITY, { register: false });
    await runInProcess(stub, async (process) => {
      process.store.state.setAiConfig(createProcessAiConfig({ modelId: "deleted", reasoning: "high" }));
      const resolved: AiConfigResult = { ...processTestConfig(process.pid), missingModelId: "deleted" };
      const rpc = vi.spyOn(process.kernel, "kernelRpc").mockResolvedValue(resolved);
      const changed = vi.spyOn(process.signals, "changed").mockResolvedValue(undefined);
      try {
        expect(await process.settings.resolveAiConfig()).toEqual(resolved);
        expect(rpc).toHaveBeenCalledWith("ai.config", {
          modelId: "deleted", reasoning: "high", inheritIfModelMissing: true,
        }, undefined);
        expect(process.store.state.getAiConfig()).toMatchObject({ reasoning: "high" });
        expect(process.store.state.getAiConfig()).not.toHaveProperty("modelId");
        expect(changed).toHaveBeenCalledWith(["ai.config"], { aiConfig: expect.objectContaining({ reasoning: "high" }) });
      } finally { rpc.mockRestore(); changed.mockRestore(); }
    });
  });

  it.each(["changed", "same-id-new-choice", "aborted", "failed", "valid"])(
    "preserves the saved selection when resolution is %s",
    async (scenario) => {
      const stub = await initProcess(`model-recovery-${scenario}`, ROOT_IDENTITY, { register: false });
      await runInProcess(stub, async (process) => {
        const original = createProcessAiConfig({ modelId: "deleted", reasoning: "high" }, 100);
        process.store.state.setAiConfig(original);
        const controller = new AbortController();
        const resolved: AiConfigResult = { ...processTestConfig(process.pid), ...(scenario === "valid" ? {} : { missingModelId: "deleted" }) };
        const rpc = vi.spyOn(process.kernel, "kernelRpc").mockImplementation(async () => {
          if (scenario === "changed" || scenario === "same-id-new-choice") {
            process.store.state.setAiConfig(createProcessAiConfig({
              modelId: scenario === "changed" ? "replacement" : "deleted", reasoning: "low",
            }, 101));
          }
          if (scenario === "aborted") controller.abort(new Error("cancelled"));
          if (scenario === "failed") throw new Error("OAuth refresh failed");
          return resolved;
        });
        const changed = vi.spyOn(process.signals, "changed").mockResolvedValue(undefined);
        try {
          const pending = process.settings.resolveAiConfig(controller.signal);
          if (scenario === "failed" || scenario === "aborted") await expect(pending).rejects.toThrow();
          else await pending;
          const current = process.store.state.getAiConfig();
          expect(current?.modelId).toBe(scenario === "changed" ? "replacement" : "deleted");
          expect(changed).not.toHaveBeenCalled();
        } finally { rpc.mockRestore(); changed.mockRestore(); }
      });
    },
  );
});
