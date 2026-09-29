import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, unstable_readConfig, type Unstable_RawConfig } from "wrangler";

const root = resolve(import.meta.dirname, "../..");
const configured = unstable_readConfig({ config: resolve(root, "workers/inference/wrangler.jsonc") }, { hideWarnings: true });
function inference(name: string, authority: string): Unstable_RawConfig {
  return { name, compatibility_date: configured.compatibility_date, vars: configured.vars,
    durable_objects: configured.durable_objects, migrations: configured.migrations, main: resolve(root, "workers/inference/src/test-support/execution.ts"), ai: undefined,
    compatibility_flags: [...configured.compatibility_flags ?? [], "enable_abortsignal_rpc"],
    services: [{ binding: "INSTALLATION_DIRECTORY", service: "execution-directory", entrypoint: "Directory", props: { authority } }],
  };
}

describe("directory-bound inference", () => {
  const harness = createTestHarness({ root: resolve(root, "workers/inference"), workers: [
    { config: { name: "execution-directory", main: resolve(root, "deployment/test/fixtures/execution-directory.ts"), compatibility_date: configured.compatibility_date } },
    { config: inference("execution-inference", "inference-fixture") },
    { config: inference("execution-invalid", "wrong-authority") },
    { config: { name: "execution-client", main: resolve(root, "workers/gateway/src/inference/test-support/execution-client.ts"),
      compatibility_date: configured.compatibility_date,
      compatibility_flags: [...configured.compatibility_flags ?? [], "enable_abortsignal_rpc"],
      durable_objects: { bindings: [{ name: "EXECUTORS", class_name: "InferenceExecutor", script_name: "execution-inference" }] },
      services: [{ binding: "COUNTS", service: "execution-inference", entrypoint: "NativeCalls" }, { binding: "INFERENCE", service: "execution-inference" }, { binding: "INVALID", service: "execution-invalid" }],
    } },
  ] });
  beforeAll(async () => { await harness.listen(); }, 30_000);
  afterAll(async () => { await harness.close(); });
  async function invoke(path: string) {
    return (await harness.getWorker("execution-client").fetch(`https://fixture.invalid/${path}`)).json();
  }

  it("uses trusted directory admission for both service and executor execution", async () => {
    const first = await invoke("execute/inst_execution_fixture");
    expect({ result: first, calls: await invoke("calls") }).toMatchObject({ result: { kind: "transcription", result: { text: "fixture transcription" } }, calls: { calls: 1 } });
    expect(await invoke("direct/inst_execution_fixture")).toMatchObject({ kind: "transcription", result: { text: "fixture transcription" } });
    expect(await invoke("text/inst_execution_fixture")).toMatchObject({
      result: { content: [{ type: "text", text: "fixture reply" }], stopReason: "stop" } });
    const before = await invoke("calls");
    expect(before).toEqual({ calls: 3, dispatch: {
      url: "https://workers-binding.ai/ai-gateway/gateways/default/compat/chat/completions",
      model: "workers-ai/@cf/zai-org/glm-5.3-flash",
    } });
    expect(await invoke("execute/foreign-space")).toEqual({ error: "Installation is not active" });
    expect(await invoke("direct/foreign-space")).toEqual({ error: "Installation is not active" });
    expect(await invoke("invalid/inst_execution_fixture")).toEqual({ error: "Fixture directory requires deployment authority" });
    expect(await invoke("calls")).toEqual(before);
    expect((await harness.getWorker("execution-inference").fetch("https://fixture.invalid/")).status).toBe(404);
  });
});
