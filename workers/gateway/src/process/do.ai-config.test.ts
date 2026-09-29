import { describe, expect, it } from "vitest";
import { okProcessResponse, ROOT_IDENTITY, initProcess, makeReq } from "./do-test-harness";

describe("proc.ai.config", () => {
  it("stores stable model and reasoning preferences, patches them, and clears", async () => {
    const pid = "mech-ai-config";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const setResponse = await okProcessResponse(
      stub,
      makeReq("proc.ai.config.set", {
        modelId: "fast",
        reasoning: "low",
      }),
    );
    expect(setResponse.ok).toBe(true);
    // SAFETY: the successful response carries the proc.ai.config.set result under test.
    expect((setResponse.data as any).config).toMatchObject({
      version: 2,
      modelId: "fast",
      reasoning: "low",
    });

    const getResponse = await okProcessResponse(stub, makeReq("proc.ai.config.get", {}));
    // SAFETY: the successful response carries the proc.ai.config.get result under test.
    expect((getResponse.data as any).config).toMatchObject({
      modelId: "fast",
      reasoning: "low",
    });

    const patchResponse = await okProcessResponse(
      stub,
      makeReq("proc.ai.config.set", { reasoning: "high" }),
    );
    // SAFETY: the successful response carries the proc.ai.config.set result under test.
    expect((patchResponse.data as any).config).toMatchObject({
      modelId: "fast",
      reasoning: "high",
    });

    const clearResponse = await okProcessResponse(
      stub,
      makeReq("proc.ai.config.set", { clear: true }),
    );
    // SAFETY: the successful response carries the proc.ai.config.set result under test.
    expect((clearResponse.data as any).config).toBeNull();
    const afterClear = await okProcessResponse(stub, makeReq("proc.ai.config.get", {}));
    // SAFETY: the successful response carries the proc.ai.config.get result under test.
    expect((afterClear.data as any).config).toBeNull();
  });

  it("rejects invalid preferences without replacing the existing config", async () => {
    const pid = "mech-ai-config-invalid";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const setResponse = await okProcessResponse(
      stub,
      makeReq("proc.ai.config.set", { modelId: "fast" }),
    );
    // SAFETY: the successful response carries the proc.ai.config.set result under test.
    expect((setResponse.data as any).config).toMatchObject({ modelId: "fast" });

    const invalid = await okProcessResponse(
      stub,
      makeReq("proc.ai.config.set", { reasoning: "impossibly-deep" }),
    );
    // SAFETY: the successful transport response carries the rejected domain result under test.
    expect(invalid.data).toMatchObject({ ok: false });

    const getResponse = await okProcessResponse(stub, makeReq("proc.ai.config.get", {}));
    // SAFETY: the successful response carries the proc.ai.config.get result under test.
    expect((getResponse.data as any).config).toMatchObject({ modelId: "fast" });
  });
});
