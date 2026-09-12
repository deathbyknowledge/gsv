import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, type Unstable_RawConfig } from "wrangler";
import { standaloneInferenceWranglerConfig } from "../src/standalone-wrangler.ts";

const root = resolve(import.meta.dirname, "../..");
const configured = standaloneInferenceWranglerConfig("https://legacy.example.com");
function inference(name: string, authority: string): Unstable_RawConfig {
  return { ...configured, name, main: resolve(root, "workers/inference/src/test-support/standalone.ts"), ai: undefined,
    compatibility_flags: [...configured.compatibility_flags ?? [], "enable_abortsignal_rpc"],
    services: configured.services?.map((binding) => ({ ...binding, service: name,
      props: { ...binding.props, authority } })),
  };
}

describe("fully bound standalone inference", () => {
  const harness = createTestHarness({ root: resolve(root, "workers/inference"), workers: [
    { config: inference("standalone-inference", "standalone-inference") },
    { config: inference("standalone-invalid", "wrong-authority") },
    { config: { name: "standalone-client", main: resolve(root, "workers/gateway/src/inference/test-support/standalone-client.ts"),
      compatibility_date: configured.compatibility_date,
      compatibility_flags: [...configured.compatibility_flags ?? [], "enable_abortsignal_rpc"],
      durable_objects: { bindings: [{ name: "EXECUTORS", class_name: "InferenceExecutor", script_name: "standalone-inference" }] },
      services: [{ binding: "COUNTS", service: "standalone-inference", entrypoint: "NativeCalls" }, { binding: "INFERENCE", service: "standalone-inference" }, { binding: "INVALID", service: "standalone-invalid" }],
    } },
  ] });
  beforeAll(async () => { await harness.listen(); }, 30_000);
  afterAll(async () => { await harness.close(); });
  async function invoke(path: string) {
    return (await harness.getWorker("standalone-client").fetch(`https://fixture.invalid/${path}`)).json();
  }

  it("uses the real singleton directory for both service and executor admission", async () => {
    const first = await invoke("execute/singleton");
    expect({ result: first, calls: await invoke("calls") }).toMatchObject({ result: { kind: "transcription", result: { text: "fixture transcription" } }, calls: { calls: 1 } });
    expect(await invoke("direct/singleton")).toMatchObject({ kind: "transcription", result: { text: "fixture transcription" } });
    expect(await invoke("text/singleton")).toMatchObject({
      result: { content: [{ type: "text", text: "fixture reply" }], stopReason: "stop" } });
    const before = await invoke("calls");
    expect(before).toEqual({ calls: 3, dispatch: {
      url: "https://workers-binding.ai/ai-gateway/gateways/default/compat/chat/completions",
      model: "workers-ai/@cf/zai-org/glm-5.3-flash",
    } });
    expect(await invoke("execute/foreign-space")).toEqual({ error: "Installation is not active" });
    expect(await invoke("direct/foreign-space")).toEqual({ error: "Installation is not active" });
    expect(await invoke("invalid/singleton")).toEqual({ error: "Standalone inference directory requires deployment authority" });
    expect(await invoke("calls")).toEqual(before);
    expect((await harness.getWorker("standalone-inference").fetch("https://fixture.invalid/")).status).toBe(404);
  });
});
