import { describe, expect, it } from "vitest";
import { gsvDeploymentManifestSchema } from "../src/manifest.ts";

const manifest = {
  version: 1 as const,
  runtime: {
    gatewayBundle: "gateway.js",
    webAssets: "assets",
    ripgitBundle: "ripgit.js",
  },
  adapters: [{
    id: "matrix",
    displayName: "Matrix",
    gatewayBinding: "CHANNEL_MATRIX",
    standalone: {
      main: "matrix.js",
      bundle: false,
      gatewayEntrypoint: "MatrixChannel",
      adapterEntrypoint: "MatrixChannel",
      durableObjects: [],
      requiredSecrets: [],
    },
  }],
};

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
