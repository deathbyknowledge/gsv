import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adapterSourceManifestSchema,
  gsvDeploymentManifestSchema,
  gsvRuntimeManifestSchema,
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
  it("generates the declared runtime and all adapter deployment paths", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const temporary = mkdtempSync(join(tmpdir(), "gsv-deployment-manifest-"));
    try {
      const output = join(temporary, "generated", "manifest.json");
      execFileSync(process.execPath, [join(root, "scripts/build-deployment-manifest.mjs"), output], { cwd: temporary });
      const generated = gsvDeploymentManifestSchema.parse(JSON.parse(readFileSync(output, "utf8")));
      const runtime = gsvRuntimeManifestSchema.parse(JSON.parse(readFileSync(join(root, "deployment/runtime.json"), "utf8")));
      expect(generated.runtime).toEqual(runtime.runtime);
      for (const value of Object.values(generated.runtime)) {
        const artifact = relative(join(root, "dist/cloudflare"), resolve(root, value));
        expect(isAbsolute(artifact) || artifact.startsWith("..")).toBe(false);
      }
      const adaptersRoot = join(root, "workers/adapters");
      const sources = readdirSync(adaptersRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(adaptersRoot, entry.name, "adapter.json")))
        .map((entry) => adapterSourceManifestSchema.parse(JSON.parse(readFileSync(join(adaptersRoot, entry.name, "adapter.json"), "utf8"))))
        .sort((left, right) => left.deployOrder - right.deployOrder || left.id.localeCompare(right.id));
      expect(sources.length).toBeGreaterThan(0);
      expect(generated.adapters).toEqual(sources.map((source) => ({
        ...resolveAdapterDeploymentManifest(source),
        deployment: { ...source.deployment, main: `dist/cloudflare/channel-${source.id}/worker/index.js`, bundle: false },
      })));
      for (const adapter of generated.adapters) {
        expect(resolve(root, adapter.deployment.main)).toBe(join(root, "dist/cloudflare", `channel-${adapter.id}`, "worker/index.js"));
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

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
