import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unstable_readConfig } from "wrangler";
import { runStandaloneWrangler, standaloneInferenceWranglerConfig } from "../src/standalone-wrangler.ts";

const root = resolve(import.meta.dirname, "../..");

describe("direct Gateway inference wiring", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("binds each Gateway config to its corresponding execution service without a native AI bypass", () => {
    const standalone = unstable_readConfig({ config: resolve(root, "workers/gateway/wrangler.jsonc") }, { hideWarnings: true });
    const managed = unstable_readConfig({ config: resolve(root, "workers/gateway/wrangler.managed.jsonc") }, { hideWarnings: true });
    const managedDev = unstable_readConfig({ config: resolve(root, "workers/gateway/wrangler.managed.dev.jsonc") }, { hideWarnings: true });
    const publicDev = unstable_readConfig({ config: resolve(root, "workers/gateway/wrangler.dev.jsonc") }, { hideWarnings: true });
    const inference = standaloneInferenceWranglerConfig("https://legacy.example.com");
    expect(standalone.services).toContainEqual({ binding: "INFERENCE_EXECUTION", service: inference.name });
    expect(managed.services).toContainEqual({ binding: "INFERENCE_EXECUTION", service: "gsv-inference", entrypoint: "InferenceService" });
    expect(managedDev.services).toContainEqual({ binding: "INFERENCE_EXECUTION", service: "gsv-inference-dev", entrypoint: "InferenceService" });
    expect(publicDev.services).toContainEqual({ binding: "INFERENCE_EXECUTION", service: "gsv-inference-public-dev" });
    expect(standalone.ai).toBeUndefined();
    expect(managed.ai).toBeUndefined();
    expect(managedDev.ai).toBeUndefined();
    expect(publicDev.ai).toBeUndefined();
    expect(inference.services).toEqual([{ binding: "INSTALLATION_DIRECTORY", service: inference.name,
      entrypoint: "StandaloneInferenceDirectoryEntrypoint", props: {
        authority: "standalone-inference", canonicalOrigin: "https://legacy.example.com",
      } }]);
    expect(inference.workers_dev).toBe(false);
    expect(inference.preview_urls).toBe(false);
  });

  it.each(["", "https://legacy.example.com/path", "https://legacy.example.com/", "ftp://legacy.example.com"])(
    "rejects a noncanonical directory origin: %s", (origin) => {
      expect(() => standaloneInferenceWranglerConfig(origin)).toThrow();
    });

  it("refuses deployment before dispatch without an explicit HTTPS Gateway origin", async () => {
    vi.stubEnv("GSV_GATEWAY_ORIGIN", undefined);
    await expect(runStandaloneWrangler("deploy", [])).rejects.toThrow("Set GSV_GATEWAY_ORIGIN");
    vi.stubEnv("GSV_GATEWAY_ORIGIN", "http://localhost:8787");
    await expect(runStandaloneWrangler("deploy", [])).rejects.toThrow("HTTPS Gateway origin");
  });

  it.each(["--config=other.jsonc", "--env", "--name=other", "--outdir"])(
    "refuses identity/output overrides that would desynchronize the two Workers: %s", async (arg) => {
      await expect(runStandaloneWrangler("deploy", [arg])).rejects.toThrow("fixed resource names");
    });
});
