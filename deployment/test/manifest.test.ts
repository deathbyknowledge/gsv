import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  adapterSourceManifestSchema,
  gsvDeploymentManifestSchema,
  resolveAdapterDeploymentManifest,
} from "../src/manifest.ts";

const manifest = {
  version: 2 as const,
  runtime: {
    gatewayBundle: "gateway.js",
    webAssets: "assets",
    ripgitBundle: "ripgit.js",
    installationsBundle: "installations.js",
    installationsMigrations: "migrations",
    inferenceBundle: "inference.js",
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
  it.each(["telegram", "slack", "discord"])("inventories every %s deployment namespace under its cleanup owner", (id) => {
    const source = adapterSourceManifestSchema.parse(JSON.parse(readFileSync(new URL(`../../workers/adapters/${id}/adapter.json`, import.meta.url), "utf8")));
    const deployment = source.managed!;
    expect(deployment.lifecycle?.entrypoint).toBe(`${id[0].toUpperCase()}${id.slice(1)}LifecycleEntrypoint`);
    expect(deployment.lifecycle?.namespaces.map((item) => item.binding).sort())
      .toEqual(deployment.durableObjects.map((item) => item.binding).sort());
    expect(deployment.lifecycle?.namespaces).toContainEqual({ binding: `${id.toUpperCase()}_INSTALLATIONS`, kind: "adapter-installation" });
  });
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
