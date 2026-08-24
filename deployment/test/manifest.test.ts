import { describe, expect, it } from "vitest";
import {
  gsvDeploymentManifestSchema,
  resolveAdapterDeploymentManifest,
} from "../src/manifest.ts";

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

  it("resolves deployment identity from a self-contained adapter manifest", () => {
    expect(resolveAdapterDeploymentManifest({
      version: 1,
      id: "matrix-room",
      displayName: "Matrix",
      description: "Matrix messaging",
      deployOrder: 1,
      wranglerConfig: "wrangler.jsonc",
      devStateDirectories: [],
      standalone: manifest.adapters[0].standalone,
    })).toMatchObject({
      id: "matrix-room",
      gatewayBinding: "CHANNEL_MATRIX_ROOM",
    });
  });
});
