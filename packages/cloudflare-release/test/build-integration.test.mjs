import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  GSV_CLOUDFLARE_COMPONENT_PLAN,
  verifyGsvCloudflareRelease,
} from "../dist/index.js";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const generator = fileURLToPath(
  new URL("../scripts/generate-release-descriptor.mjs", import.meta.url),
);
const CONFIG_PATHS = new Map([
  ["assembler", "assembler/wrangler.toml"],
  ["ripgit", "ripgit/wrangler.toml"],
  ["gateway", "gateway/wrangler.jsonc"],
  ["channel-whatsapp", "adapters/whatsapp/wrangler.jsonc"],
  ["channel-discord", "adapters/discord/wrangler.jsonc"],
  ["channel-telegram", "adapters/telegram/wrangler.jsonc"],
]);

test("release CLI derives the descriptor from the real GSV Wrangler configs", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "gsv-cloudflare-release-"));
  try {
    const dist = path.join(temporary, "dist");
    const artifacts = path.join(temporary, "artifacts");
    await mkdir(artifacts, { recursive: true });
    const checksumLines = [];

    for (const plan of GSV_CLOUDFLARE_COMPONENT_PLAN) {
      const componentDirectory = path.join(dist, plan.bundleRoot);
      const workerDirectory = path.join(componentDirectory, "worker");
      await mkdir(workerDirectory, { recursive: true });
      await writeFile(path.join(workerDirectory, "index.js"), "export default {};\n");
      const sourceConfig = CONFIG_PATHS.get(plan.id);
      assert.ok(sourceConfig, `missing test config mapping for ${plan.id}`);
      const configName = path.basename(sourceConfig);
      await copyFile(path.join(repoRoot, sourceConfig), path.join(componentDirectory, configName));
      const manifest = {
        component: plan.bundleRoot,
        worker: {
          entrypoint: "worker/index.js",
          wranglerConfig: configName,
        },
        ...(plan.id === "gateway" ? { assetsDir: "assets" } : {}),
      };
      await writeFile(
        path.join(componentDirectory, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      if (plan.id === "gateway") {
        await mkdir(path.join(componentDirectory, "assets"));
        await writeFile(path.join(componentDirectory, "assets/index.html"), "<!doctype html>\n");
      }

      const bytes = Buffer.from(`artifact:${plan.id}\n`);
      await writeFile(path.join(artifacts, plan.artifactFile), bytes);
      checksumLines.push(`${createHash("sha256").update(bytes).digest("hex")}  ${plan.artifactFile}`);
    }

    const checksums = path.join(artifacts, "cloudflare-checksums.txt");
    const output = path.join(artifacts, "gsv-cloudflare-release.json");
    await writeFile(checksums, `${checksumLines.sort().join("\n")}\n`);
    await run(process.execPath, [
      generator,
      "--release",
      "v9.8.7",
      "--source-commit",
      "abcdef0123456789abcdef0123456789abcdef01",
      "--dist",
      dist,
      "--artifacts",
      artifacts,
      "--checksums",
      checksums,
      "--output",
      output,
    ], { cwd: repoRoot });

    const descriptor = JSON.parse(await readFile(output, "utf8"));
    await verifyGsvCloudflareRelease(descriptor);
    assert.equal(descriptor.releaseVersion, "v9.8.7");
    assert.equal(descriptor.source.commitSha, "abcdef0123456789abcdef0123456789abcdef01");
    assert.deepEqual(
      descriptor.components.map((component) => component.id),
      GSV_CLOUDFLARE_COMPONENT_PLAN.map((component) => component.id),
    );
    assert.equal(descriptor.components.length, 6);
    assert.equal(descriptor.resources.some((resource) => resource.kind === "r2-bucket"), true);
    assert.equal(
      descriptor.components.find((component) => component.id === "gateway").worker.assets.directory,
      "assets",
    );
    const serialized = JSON.stringify(descriptor);
    assert.doesNotMatch(serialized, /gsv-storage/u);
    assert.doesNotMatch(serialized, /managedSecurityEpoch/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
