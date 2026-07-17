#!/usr/bin/env node

import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";

import {
  createGsvCloudflareRelease,
  GSV_CLOUDFLARE_COMPONENT_PLAN,
  GSV_CLOUDFLARE_PORTABLE_FEATURES,
  serializeGsvCloudflareRelease,
  verifyCloudflareReleaseChecksumManifest,
  verifyGsvCloudflareRelease,
} from "../dist/index.js";

const args = parseArguments(process.argv.slice(2));
const checksumBytes = new Uint8Array(await readFile(args.checksums));
const { checksums } = await verifyCloudflareReleaseChecksumManifest(checksumBytes);
const components = [];

for (const plan of GSV_CLOUDFLARE_COMPONENT_PLAN) {
  const componentDirectory = path.join(args.dist, plan.bundleRoot);
  const bundleManifestPath = path.join(componentDirectory, "manifest.json");
  const manifest = parseBundleManifest(
    JSON.parse(await readFile(bundleManifestPath, "utf8")),
    plan.bundleRoot,
  );
  const wranglerPath = path.join(componentDirectory, manifest.worker.wranglerConfig);
  const config = parseWranglerConfig(
    manifest.worker.wranglerConfig,
    await readFile(wranglerPath, "utf8"),
  );
  const artifactPath = path.join(args.artifacts, plan.artifactFile);
  const artifactStat = await stat(artifactPath);
  if (!artifactStat.isFile() || artifactStat.size < 1) {
    throw new Error(`Release artifact ${plan.artifactFile} is missing or empty`);
  }
  const sha256 = checksums.get(plan.artifactFile);
  if (!sha256) throw new Error(`Checksum manifest is missing ${plan.artifactFile}`);
  await requireFile(path.join(componentDirectory, manifest.worker.entrypoint), "Worker entrypoint");
  if (manifest.assetsDir !== undefined) {
    const assetsStat = await stat(path.join(componentDirectory, manifest.assetsDir));
    if (!assetsStat.isDirectory()) {
      throw new Error(`Bundle ${plan.id} assets path is not a directory`);
    }
  }
  components.push({
    id: plan.id,
    bundleRoot: plan.bundleRoot,
    bundleManifest: "manifest.json",
    wranglerConfig: manifest.worker.wranglerConfig,
    entrypoint: manifest.worker.entrypoint,
    ...(manifest.assetsDir === undefined ? {} : { assetsDirectory: manifest.assetsDir }),
    required: plan.required,
    deployOrder: plan.deployOrder,
    dependsOn: plan.dependsOn,
    artifact: {
      file: plan.artifactFile,
      sha256,
      size: artifactStat.size,
    },
    config,
  });
}

const expectedArtifacts = new Set(GSV_CLOUDFLARE_COMPONENT_PLAN.map((plan) => plan.artifactFile));
for (const file of checksums.keys()) {
  if (!expectedArtifacts.has(file)) {
    throw new Error(`Checksum manifest contains unknown artifact ${file}`);
  }
}

const descriptor = await createGsvCloudflareRelease({
  releaseVersion: args.release,
  sourceCommitSha: args.sourceCommit,
  managedObjectDescriptorSchemaVersion: 1,
  dataFrameStreamVersion: 1,
  portableArchiveFormatVersion: 1,
  portableFeatures: GSV_CLOUDFLARE_PORTABLE_FEATURES,
  components,
});
await verifyGsvCloudflareRelease(descriptor);
await writeFile(args.output, serializeGsvCloudflareRelease(descriptor), { flag: "w" });
console.log(`GSV Cloudflare release descriptor: ${args.output}`);

function parseArguments(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || value === undefined) usage();
    if (parsed.has(name)) throw new Error(`Duplicate argument ${name}`);
    parsed.set(name, value);
  }
  const allowed = new Set([
    "--release",
    "--source-commit",
    "--dist",
    "--artifacts",
    "--checksums",
    "--output",
  ]);
  for (const name of parsed.keys()) {
    if (!allowed.has(name)) throw new Error(`Unknown argument ${name}`);
  }
  for (const name of allowed) {
    if (!parsed.has(name)) usage();
  }
  return {
    release: parsed.get("--release"),
    sourceCommit: parsed.get("--source-commit"),
    dist: path.resolve(parsed.get("--dist")),
    artifacts: path.resolve(parsed.get("--artifacts")),
    checksums: path.resolve(parsed.get("--checksums")),
    output: path.resolve(parsed.get("--output")),
  };
}

function usage() {
  throw new Error(
    "Usage: gsv-cloudflare-release --release <tag> --source-commit <sha> --dist <bundle-dir> "
      + "--artifacts <artifact-dir> --checksums <file> --output <file>",
  );
}

function parseBundleManifest(value, expectedComponent) {
  const manifest = expectRecord(value, "bundle manifest");
  expectExactKeys(manifest, ["component", "worker"], ["assetsDir"], "bundle manifest");
  if (manifest.component !== expectedComponent) {
    throw new Error(`Bundle manifest declares ${String(manifest.component)}, expected ${expectedComponent}`);
  }
  const worker = expectRecord(manifest.worker, "bundle Worker");
  expectExactKeys(worker, ["entrypoint", "wranglerConfig"], [], "bundle Worker");
  requireRelativePath(worker.entrypoint, "bundle Worker entrypoint");
  requireRelativePath(worker.wranglerConfig, "bundle Wrangler config");
  if (manifest.assetsDir !== undefined) requireRelativePath(manifest.assetsDir, "bundle assetsDir");
  return manifest;
}

function parseWranglerConfig(file, text) {
  let value;
  if (file.endsWith(".toml")) {
    value = parseToml(text);
  } else {
    const errors = [];
    value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length > 0) {
      throw new Error(
        `Wrangler config ${file} is invalid: ${errors.map((error) => printParseErrorCode(error.error)).join(", ")}`,
      );
    }
  }
  const config = expectRecord(value, `Wrangler config ${file}`);
  if (typeof config.name !== "string" || config.name.length === 0) {
    throw new Error(`Wrangler config ${file} has no Worker name`);
  }
  if (typeof config.compatibility_date !== "string") {
    throw new Error(`Wrangler config ${file} has no compatibility date`);
  }
  requireOptionalArray(config.migrations, "migrations");
  requireOptionalArray(config.durable_objects?.bindings, "Durable Object bindings");
  requireOptionalArray(config.kv_namespaces, "KV bindings");
  requireOptionalArray(config.r2_buckets, "R2 bindings");
  requireOptionalArray(config.services, "service bindings");
  requireOptionalArray(config.worker_loaders, "Worker Loader bindings");
  return config;
}

function requireOptionalArray(value, label) {
  if (value !== undefined && !Array.isArray(value)) throw new Error(`Wrangler ${label} must be an array`);
}

function expectRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function expectExactKeys(value, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown field ${unknown[0]}`);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) throw new Error(`${label} is missing field ${missing[0]}`);
}

function requireRelativePath(value, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || value.startsWith("/")
    || value.includes("\\")
    || value.split("/").some((part) => part === "" || part === "." || part === "..")
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} must be a safe relative path`);
  }
}

async function requireFile(file, label) {
  const value = await stat(file);
  if (!value.isFile() || value.size < 1) throw new Error(`${label} is missing or empty: ${file}`);
}
