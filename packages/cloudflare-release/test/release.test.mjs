import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  assertGsvCloudflareRelease,
  createGsvCloudflareRelease,
  verifyGsvCloudflareRelease,
} from "../dist/index.js";

const fixtureUrl = new URL("./fixtures/gsv-cloudflare-release-v1.json", import.meta.url);
const schemaUrl = new URL("../schema/gsv-cloudflare-release-v1.schema.json", import.meta.url);

async function fixture() {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
}

test("accepts and verifies the v1 golden descriptor", async () => {
  const value = await fixture();
  assertGsvCloudflareRelease(value);
  assert.equal(await verifyGsvCloudflareRelease(value), value);
});

test("derives the golden descriptor from Wrangler configuration without provider names", async () => {
  const generated = await createGsvCloudflareRelease({
    releaseVersion: "v1.2.3",
    sourceCommitSha: "0123456789abcdef0123456789abcdef01234567",
    managedObjectDescriptorSchemaVersion: 1,
    dataFrameStreamVersion: 1,
    portableArchiveFormatVersion: 1,
    portableFeatures: [
      "gsv-r2-logical-snapshot-v1",
      "gsv-do-logical-snapshot-v1",
    ],
    components: [
      {
        id: "gateway",
        bundleRoot: "gateway",
        bundleManifest: "manifest.json",
        wranglerConfig: "wrangler.jsonc",
        entrypoint: "worker/index.js",
        assetsDirectory: "assets",
        required: true,
        deployOrder: 20,
        dependsOn: ["store"],
        artifact: {
          file: "gsv-cloudflare-gateway.tar.gz",
          sha256: "b".repeat(64),
          size: 200,
        },
        config: {
          name: "private-concrete-gateway-name",
          compatibility_date: "2026-06-02",
          compatibility_flags: ["nodejs_compat"],
          r2_buckets: [{ binding: "STORAGE", bucket_name: "private-concrete-bucket-name" }],
          services: [{
            binding: "STORE",
            service: "private-concrete-store-name",
            entrypoint: "StoreEntrypoint",
          }],
          worker_loaders: [],
          ai: { binding: "AI" },
          assets: {
            binding: "ASSETS",
            not_found_handling: "single-page-application",
            run_worker_first: ["/ws", "/apps/*"],
          },
        },
      },
      {
        id: "store",
        bundleRoot: "store",
        bundleManifest: "manifest.json",
        wranglerConfig: "wrangler.toml",
        entrypoint: "worker/index.js",
        required: true,
        deployOrder: 10,
        dependsOn: [],
        artifact: {
          file: "gsv-cloudflare-store.tar.gz",
          sha256: "a".repeat(64),
          size: 100,
        },
        config: {
          name: "private-concrete-store-name",
          compatibility_date: "2026-06-01",
          migrations: [{ tag: "v1", new_sqlite_classes: ["Store"] }],
          durable_objects: {
            bindings: [{ name: "STORE", class_name: "Store" }],
          },
        },
      },
    ],
  });
  assert.deepEqual(generated, await fixture());
  const serialized = JSON.stringify(generated);
  assert.doesNotMatch(serialized, /private-concrete/u);
});

test("rejects unknown fields and cross-reference mistakes", async () => {
  const unknown = await fixture();
  unknown.managedSecurityEpoch = 1;
  assert.throws(() => assertGsvCloudflareRelease(unknown), /unknown field/u);

  const missingResource = await fixture();
  missingResource.components[0].worker.bindings[0].resource = "store.do.missing";
  assert.throws(() => assertGsvCloudflareRelease(missingResource), /unknown resource/u);

  const lateDependency = await fixture();
  lateDependency.components[1].deployOrder = 5;
  assert.throws(() => assertGsvCloudflareRelease(lateDependency), /sorted by unique deployOrder/u);
});

test("detects an inline migration digest mismatch", async () => {
  const value = await fixture();
  value.components[0].worker.durableObjectMigrations.steps[0].newSqliteClasses = ["Other"];
  await assert.rejects(() => verifyGsvCloudflareRelease(value), /digest does not match/u);
});

test("ships a matching closed JSON Schema", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  const validate = new Ajv2020({ allErrors: true, strict: true, validateFormats: false })
    .compile(schema);
  assert.equal(validate(await fixture()), true, JSON.stringify(validate.errors));
  assert.equal(schema.$id, "https://gsv.space/schemas/gsv-cloudflare-release-v1.schema.json");
  assert.equal(schema.properties.format.const, "gsv-cloudflare-release");
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(
    [...schema.required].sort(),
    [
      "$schema",
      "components",
      "format",
      "portable",
      "releaseVersion",
      "resources",
      "runtime",
      "schemaVersion",
      "source",
    ],
  );
});
