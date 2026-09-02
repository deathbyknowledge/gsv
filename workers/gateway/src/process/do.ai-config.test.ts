import { describe, expect, it } from "vitest";
import { okProcessResponse, ROOT_IDENTITY, initProcess, makeReq } from "./do-test-harness";

describe("proc.ai.config", () => {
  it("stores snapshots, redacts reads by default, patches fields, and clears", async () => {
    const pid = "mech-ai-config";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const setResponse = await okProcessResponse(
      stub,
      makeReq("proc.ai.config.set", {
        values: {
          "config/ai/provider": "openai",
          "config/ai/model": "gpt-4.1-mini",
          "config/ai/api_key": "sk-process",
          "config/ai/max_tokens": "",
          "config/ai/max_context_bytes": "   ",
        },
        profile: {
          id: "fast",
          name: "Fast",
        },
        // SAFETY: test fixture is constructed with the asserted domain shape.
      }),
    );
    expect(setResponse.ok).toBe(true);
    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect((setResponse.data as any).config).toMatchObject({
      profile: { id: "fast", name: "Fast" },
      values: {
        "config/ai/provider": "openai",
        "config/ai/model": "gpt-4.1-mini",
        "config/ai/api_key": "redacted",
      },
    });

    const redactedGet = await okProcessResponse(stub, makeReq("proc.ai.config.get", {}));
    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect((redactedGet.data as any).config.values["config/ai/api_key"]).toBe("redacted");

    const rawGet = await okProcessResponse(
      stub,
      makeReq("proc.ai.config.get", { redacted: false }),
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect((rawGet.data as any).config.values["config/ai/api_key"]).toBe("sk-process");
    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect((rawGet.data as any).config.values).not.toHaveProperty("config/ai/max_tokens");
    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect((rawGet.data as any).config.values).not.toHaveProperty("config/ai/max_context_bytes");

    const patchResponse = await okProcessResponse(
      stub,
      makeReq("proc.ai.config.set", {
        key: "config/ai/model",
        value: "gpt-4.2",
        // SAFETY: test fixture is constructed with the asserted domain shape.
      }),
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect((patchResponse.data as any).config.profile).toMatchObject({
      id: "fast",
      name: "Fast",
    });
    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect((patchResponse.data as any).config.values["config/ai/model"]).toBe("gpt-4.2");

    const clearResponse = await okProcessResponse(
      stub,
      makeReq("proc.ai.config.set", { clear: true }),
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect((clearResponse.data as any).config).toBeNull();
    const afterClear = await okProcessResponse(stub, makeReq("proc.ai.config.get", {}));
    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect((afterClear.data as any).config).toBeNull();
  });

  it("keeps profile-only snapshots for server-side secret resolution", async () => {
    const pid = "mech-ai-config-profile-only";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const setResponse = await okProcessResponse(
      stub,
      makeReq("proc.ai.config.set", {
        values: {},
        profile: {
          id: "fast",
          name: "Fast",
        },
        // SAFETY: test fixture is constructed with the asserted domain shape.
      }),
    );

    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect((setResponse.data as any).config).toMatchObject({
      profile: { id: "fast", name: "Fast" },
      values: {},
    });

    const getResponse = await okProcessResponse(
      stub,
      makeReq("proc.ai.config.get", { redacted: false }),
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect((getResponse.data as any).config).toMatchObject({
      profile: { id: "fast", name: "Fast" },
      values: {},
    });

    const patchResponse = await okProcessResponse(
      stub,
      makeReq("proc.ai.config.set", {
        key: "config/ai/reasoning",
        value: "high",
        // SAFETY: test fixture is constructed with the asserted domain shape.
      }),
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect((patchResponse.data as any).config).toMatchObject({
      profile: { id: "fast", name: "Fast" },
      values: {
        "config/ai/reasoning": "high",
      },
    });

    const clearFieldResponse = await okProcessResponse(
      stub,
      makeReq("proc.ai.config.set", {
        key: "config/ai/reasoning",
        value: "",
        // SAFETY: test fixture is constructed with the asserted domain shape.
      }),
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect((clearFieldResponse.data as any).config).toMatchObject({
      profile: { id: "fast", name: "Fast" },
      values: {},
    });
  });
});
