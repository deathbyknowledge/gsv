import { describe, expect, it } from "vitest";
import {
  resolveModelContextWindowFromRegistry,
  resolveModelMetadata,
} from "./model-registry";

describe("model registry metadata", () => {
  it("maps Workers AI aliases to the pi-ai Cloudflare Workers AI provider", () => {
    const model = resolveModelMetadata("workers-ai", "@cf/nvidia/nemotron-3-120b-a12b");

    expect(model?.provider).toBe("cloudflare-workers-ai");
    expect(model?.id).toBe("@cf/nvidia/nemotron-3-120b-a12b");
  });

  it("resolves Workers AI context windows from pi-ai metadata", () => {
    expect(resolveModelContextWindowFromRegistry("workers-ai", "@cf/nvidia/nemotron-3-120b-a12b")).toBe(256000);
  });

  it("returns null for unknown providers and models", () => {
    expect(resolveModelMetadata("custom-provider", "custom-model")).toBeNull();
    expect(resolveModelContextWindowFromRegistry("workers-ai", "@cf/example/missing")).toBeNull();
  });
});
