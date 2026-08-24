import { describe, expect, it } from "vitest";
import manifest from "../manifest.json" with { type: "json" };
import { gsvDeploymentManifestSchema } from "../src/manifest.ts";

describe("deployment manifest", () => {
  it("accepts the checked-in deployment topology", () => {
    expect(gsvDeploymentManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it("rejects an unsafe adapter binding", () => {
    expect(() =>
      gsvDeploymentManifestSchema.parse({
        ...manifest,
        adapters: [{
          ...manifest.adapters[0],
          gatewayBinding: "arbitrary",
        }],
      })
    ).toThrow();
  });
});
