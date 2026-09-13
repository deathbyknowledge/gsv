import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  adapterSourceManifestSchema,
  gsvDeploymentManifestSchema,
  resolveAdapterDeploymentManifest,
} from "../src/manifest.ts";

const manifest = {
  version: 3 as const,
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
    deployment: {
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
    const deployment = source.deployment;
    expect(deployment.lifecycle?.entrypoint).toBe(`${id[0].toUpperCase()}${id.slice(1)}LifecycleEntrypoint`);
    expect(deployment.lifecycle?.namespaces.map((item) => item.className).sort())
      .toEqual(deployment.durableObjects.map((item) => item.className).sort());
    expect(deployment.lifecycle?.namespaces).toContainEqual({ className: `${id[0].toUpperCase()}${id.slice(1)}Installation`, kind: "adapter-installation" });
  });
  it("accepts the checked-in deployment topology", () => {
    expect(gsvDeploymentManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it("rejects the old variant manifest instead of choosing a runtime implicitly", () => {
    expect(() => gsvDeploymentManifestSchema.parse({ ...manifest, version: 2 })).toThrow();
    const { deployment, ...adapter } = manifest.adapters[0];
    expect(() => gsvDeploymentManifestSchema.parse({ ...manifest,
      adapters: [{ ...adapter, standalone: deployment, managed: deployment }],
    })).toThrow();
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
      version: 2,
      id: "matrix-room",
      displayName: "Matrix",
      description: "Matrix messaging",
      deployOrder: 1,
      wranglerConfig: "wrangler.jsonc",
      devStateDirectories: [],
      deployment: manifest.adapters[0].deployment,
    })).toMatchObject({
      id: "matrix-room",
      gatewayBinding: "CHANNEL_MATRIX_ROOM",
    });
  });
});
