import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  createGsvCloudflareRelease,
  prepareCloudflareWorkerBundle,
} from "../dist/index.js";

const encoder = new TextEncoder();
const LIMITS = Object.freeze({
  maxCompressedBytes: 1024 * 1024,
  maxUncompressedBytes: 4 * 1024 * 1024,
  maxFiles: 100,
  maxFileBytes: 1024 * 1024,
  maxTotalFileBytes: 3 * 1024 * 1024,
});

const WRANGLER_CONFIG = Object.freeze({
  name: "source-gateway",
  main: "src/index.ts",
  compatibility_date: "2026-06-02",
  compatibility_flags: ["nodejs_compat"],
  migrations: [{ tag: "v1", new_sqlite_classes: ["Kernel"] }],
  durable_objects: {
    bindings: [{ name: "KERNEL", class_name: "Kernel" }],
  },
  kv_namespaces: [{
    binding: "CACHE",
    id: "provider-kv-namespace-id",
    preview_id: "provider-kv-preview-id",
  }],
  r2_buckets: [{
    binding: "STORAGE",
    bucket_name: "source-concrete-bucket-name",
    jurisdiction: "default",
  }],
  ai: { binding: "AI" },
  assets: {
    directory: "../web/dist",
    binding: "ASSETS",
    not_found_handling: "single-page-application",
    run_worker_first: ["/ws", "/apps/*"],
  },
  observability: { enabled: true },
  limits: { cpu_ms: 10_000 },
});

test("prepares verified bytes as deterministic logical deployment material", async () => {
  const fixture = await bundleFixture();
  const prepared = await prepareCloudflareWorkerBundle({
    release: fixture.release,
    componentId: "gateway",
    artifact: fixture.compressed,
    limits: LIMITS,
  });

  assert.equal(prepared.componentId, "gateway");
  assert.equal(prepared.mainModule, "index.js");
  assert.deepEqual(
    prepared.modules.map(({ name, contentType }) => [name, contentType]),
    [
      ["index.js", "application/javascript+module"],
      ["helper.wasm", "application/wasm"],
    ],
  );
  assert.deepEqual(
    prepared.assets.map(({ path, contentType }) => [path, contentType]),
    [
      ["/app.css", "text/css; charset=utf-8"],
      ["/index.html", "text/html; charset=utf-8"],
    ],
  );
  assert.deepEqual(prepared.assetConfig, {
    not_found_handling: "single-page-application",
    run_worker_first: ["/ws", "/apps/*"],
    _headers: "/static/*\n  Cache-Control: public\n",
    _redirects: "/home / 302\n",
  });
  assert.deepEqual(prepared.deploymentSettings, {
    limits: { cpu_ms: 10_000 },
    observability: { enabled: true },
  });
  assert.deepEqual(
    prepared.bindings.map((binding) => binding.kind),
    ["workers-ai", "kv-namespace", "durable-object", "r2-bucket"],
  );
  assert.deepEqual(
    prepared.bindings.find(({ kind }) => kind === "r2-bucket"),
    {
      kind: "r2-bucket",
      name: "STORAGE",
      resource: "gateway.r2.storage",
      ownerComponent: "gateway",
      jurisdiction: "default",
    },
  );
  assert.doesNotMatch(
    JSON.stringify({ bindings: prepared.bindings, settings: prepared.deploymentSettings }),
    /provider-kv|source-concrete-bucket/u,
  );
  assert.equal(prepared.statistics.compressedBytes, fixture.compressed.byteLength);
  assert.equal(prepared.statistics.fileCount, 8);
  assert.equal(prepared.statistics.retainedBytes > 0, true);
});

test("accepts Web byte streams and async iterables", async () => {
  const fixture = await bundleFixture();
  const midpoint = Math.floor(fixture.compressed.byteLength / 2);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(fixture.compressed.slice(0, midpoint));
      controller.enqueue(fixture.compressed.slice(midpoint));
      controller.close();
    },
  });
  const streamed = await prepareCloudflareWorkerBundle({
    release: fixture.release,
    componentId: "gateway",
    artifact: stream,
    limits: LIMITS,
  });
  assert.equal(streamed.artifact.sha256, fixture.sha256);

  async function* chunks() {
    yield fixture.compressed.slice(0, 7);
    yield fixture.compressed.slice(7);
  }
  const iterated = await prepareCloudflareWorkerBundle({
    release: fixture.release,
    componentId: "gateway",
    artifact: chunks(),
    limits: LIMITS,
  });
  assert.deepEqual(
    iterated.modules.map(({ name }) => name),
    streamed.modules.map(({ name }) => name),
  );
});

test("parses a bundled Wrangler TOML config with the same logical result", async () => {
  const fixture = await bundleFixture({
    configPath: "wrangler.toml",
    configText: `
name = "source-gateway"
main = "src/index.ts"
compatibility_date = "2026-06-02"
compatibility_flags = ["nodejs_compat"]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Kernel"]

[durable_objects]
bindings = [{ name = "KERNEL", class_name = "Kernel" }]

[[kv_namespaces]]
binding = "CACHE"
id = "provider-kv-namespace-id"
preview_id = "provider-kv-preview-id"

[[r2_buckets]]
binding = "STORAGE"
bucket_name = "source-concrete-bucket-name"
jurisdiction = "default"

[ai]
binding = "AI"

[assets]
directory = "../web/dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/ws", "/apps/*"]

[observability]
enabled = true

[limits]
cpu_ms = 10000
`,
  });
  const prepared = await prepareCloudflareWorkerBundle({
    release: fixture.release,
    componentId: "gateway",
    artifact: fixture.compressed,
    limits: LIMITS,
  });
  assert.deepEqual(prepared.deploymentSettings, {
    limits: { cpu_ms: 10_000 },
    observability: { enabled: true },
  });
  assert.equal(prepared.bindings.length, 4);
});

test("an explicit asset directory wins over a root-level module tree", async () => {
  const fixture = await bundleFixture({
    entrypoint: "index.js",
    extraFiles: [{ path: "gateway/assets/client.js", body: "console.log('asset');\n" }],
  });
  const prepared = await prepareCloudflareWorkerBundle({
    release: fixture.release,
    componentId: "gateway",
    artifact: fixture.compressed,
    limits: LIMITS,
  });
  assert.deepEqual(
    prepared.modules.map(({ name }) => name),
    ["index.js", "helper.wasm"],
  );
  assert.equal(prepared.modules.some(({ name }) => name.includes("assets/")), false);
  assert.equal(prepared.assets.some(({ path }) => path === "/client.js"), true);
});

test("cancels an owned stream when its artifact size is wrong", async () => {
  const fixture = await bundleFixture();
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(fixture.compressed);
      controller.enqueue(new Uint8Array([0]));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    prepareCloudflareWorkerBundle({
      release: fixture.release,
      componentId: "gateway",
      artifact: stream,
      limits: LIMITS,
    }),
    /size does not match/u,
  );
  assert.equal(cancelled, true);
});

test("enforces every caller-supplied archive limit", async (context) => {
  const fixture = await bundleFixture();
  const largestFixtureFile = Math.max(
    encoder.encode(JSON.stringify(WRANGLER_CONFIG)).byteLength,
    encoder.encode(JSON.stringify(bundleManifest())).byteLength,
  );
  const cases = [
    [
      "compressed bytes",
      { ...LIMITS, maxCompressedBytes: fixture.compressed.byteLength - 1 },
      /compressed-byte limit/u,
    ],
    [
      "uncompressed bytes",
      {
        ...LIMITS,
        maxUncompressedBytes: fixture.tar.byteLength - 1,
        maxFileBytes: fixture.tar.byteLength - 1,
        maxTotalFileBytes: fixture.tar.byteLength - 1,
      },
      /uncompressed-byte limit/u,
    ],
    [
      "file count",
      { ...LIMITS, maxFiles: 2 },
      /too many files/u,
    ],
    [
      "per-file bytes",
      { ...LIMITS, maxFileBytes: 8 },
      /per-file limit/u,
    ],
    [
      "total file bytes",
      {
        ...LIMITS,
        maxFileBytes: largestFixtureFile,
        maxTotalFileBytes: largestFixtureFile,
      },
      /total-file-byte limit/u,
    ],
  ];
  for (const [name, limits, pattern] of cases) {
    await context.test(name, async () => {
      await assert.rejects(
        prepareCloudflareWorkerBundle({
          release: fixture.release,
          componentId: "gateway",
          artifact: fixture.compressed,
          limits,
        }),
        pattern,
      );
    });
  }
});

test("rejects unsafe, duplicate, linked, unsupported, and trailing tar entries", async (context) => {
  const badChecksum = tar([{ path: "gateway/file", body: "bad" }]);
  badChecksum[0] ^= 1;
  const cases = [
    [
      "traversal",
      tar([{ path: "gateway/../escape", body: "bad" }]),
      /traversing|unsafe path/u,
    ],
    [
      "duplicate",
      tar([
        { path: "gateway/file", body: "one" },
        { path: "gateway/file", body: "two" },
      ]),
      /duplicate path/u,
    ],
    [
      "symbolic link",
      tar([{ path: "gateway/link", type: "2" }]),
      /unsupported type/u,
    ],
    [
      "PAX metadata",
      tar([{ path: "PaxHeaders/file", type: "x", body: "metadata" }]),
      /unsupported type/u,
    ],
    [
      "bad header checksum",
      badChecksum,
      /header checksum mismatch/u,
    ],
    [
      "data after end marker",
      concatenate([tar([]), new Uint8Array([1])]),
      /data after its end marker/u,
    ],
  ];
  for (const [name, archive, pattern] of cases) {
    await context.test(name, async () => {
      const fixture = await bundleFixture({ tarBytes: archive });
      await assert.rejects(
        prepareCloudflareWorkerBundle({
          release: fixture.release,
          componentId: "gateway",
          artifact: fixture.compressed,
          limits: LIMITS,
        }),
        pattern,
      );
    });
  }
});

test("rejects digest, manifest, config, and file-inventory mismatches", async (context) => {
  const valid = await bundleFixture();
  await context.test("digest", async () => {
    const altered = valid.compressed.slice();
    altered[Math.floor(altered.byteLength / 2)] ^= 1;
    await assert.rejects(
      prepareCloudflareWorkerBundle({
        release: valid.release,
        componentId: "gateway",
        artifact: altered,
        limits: LIMITS,
      }),
      /digest does not match/u,
    );
  });

  const cases = [
    [
      "manifest component",
      await bundleFixture({ manifest: { ...bundleManifest(), component: "other" } }),
      /declares component other/u,
    ],
    [
      "compatibility",
      await bundleFixture({
        configText: JSON.stringify({ ...WRANGLER_CONFIG, compatibility_date: "2026-06-03" }),
      }),
      /compatibility date/u,
    ],
    [
      "duplicate JSONC key",
      await bundleFixture({
        configText: `{"name":"first","name":"second","compatibility_date":"2026-06-02"}`,
      }),
      /repeats property name/u,
    ],
    [
      "unreferenced file",
      await bundleFixture({ extraFiles: [{ path: "gateway/private.txt", body: "unused" }] }),
      /unreferenced file private\.txt/u,
    ],
  ];
  for (const [name, fixture, pattern] of cases) {
    await context.test(name, async () => {
      await assert.rejects(
        prepareCloudflareWorkerBundle({
          release: fixture.release,
          componentId: "gateway",
          artifact: fixture.compressed,
          limits: LIMITS,
        }),
        pattern,
      );
    });
  }
});

async function bundleFixture(options = {}) {
  const configPath = options.configPath ?? "wrangler.jsonc";
  const entrypoint = options.entrypoint ?? "worker/index.js";
  const workerDirectory = entrypoint.includes("/")
    ? entrypoint.slice(0, entrypoint.lastIndexOf("/"))
    : "";
  const manifest = options.manifest ?? bundleManifest(configPath, entrypoint);
  const configText = options.configText ?? JSON.stringify(WRANGLER_CONFIG);
  const tarBytes = options.tarBytes ?? tar([
    { path: "gateway/", type: "5" },
    { path: "gateway/worker/", type: "5" },
    { path: "gateway/assets/", type: "5" },
    { path: "gateway/manifest.json", body: JSON.stringify(manifest) },
    { path: `gateway/${configPath}`, body: configText },
    { path: `gateway/${entrypoint}`, body: "export default {};\n" },
    {
      path: `gateway/${workerDirectory ? `${workerDirectory}/` : ""}helper.wasm`,
      body: new Uint8Array([0, 97, 115, 109]),
    },
    { path: "gateway/assets/index.html", body: "<!doctype html>\n" },
    { path: "gateway/assets/app.css", body: "body{}\n" },
    {
      path: "gateway/assets/_headers",
      body: "/static/*\n  Cache-Control: public\n",
    },
    { path: "gateway/assets/_redirects", body: "/home / 302\n" },
    ...(options.extraFiles ?? []),
  ]);
  const compressed = new Uint8Array(gzipSync(tarBytes, { mtime: 0 }));
  const sha256 = createHash("sha256").update(compressed).digest("hex");
  const release = await createGsvCloudflareRelease({
    releaseVersion: "v1.2.3",
    sourceCommitSha: "0123456789abcdef0123456789abcdef01234567",
    managedObjectDescriptorSchemaVersion: 1,
    dataFrameStreamVersion: 1,
    portableArchiveFormatVersion: 1,
    portableFeatures: ["gsv-do-logical-snapshot-v1"],
    components: [{
      id: "gateway",
      bundleRoot: "gateway",
      bundleManifest: "manifest.json",
      wranglerConfig: configPath,
      entrypoint,
      assetsDirectory: "assets",
      required: true,
      deployOrder: 10,
      dependsOn: [],
      artifact: {
        file: "gsv-cloudflare-gateway.tar.gz",
        sha256,
        size: compressed.byteLength,
      },
      config: WRANGLER_CONFIG,
    }],
  });
  return { compressed, release, sha256, tar: tarBytes };
}

function bundleManifest(configPath = "wrangler.jsonc", entrypoint = "worker/index.js") {
  return {
    component: "gateway",
    worker: {
      entrypoint,
      wranglerConfig: configPath,
    },
    assetsDir: "assets",
  };
}

function tar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const body = typeof entry.body === "string"
      ? encoder.encode(entry.body)
      : entry.body ?? new Uint8Array();
    const header = new Uint8Array(512);
    writeTarText(header, 0, 100, entry.path);
    writeTarOctal(header, 100, 8, 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, body.byteLength);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    writeTarText(header, 257, 6, "ustar ");
    header[263] = 0x20;
    let checksum = 0;
    for (const byte of header) checksum += byte;
    writeTarChecksum(header, checksum);
    blocks.push(header, body);
    const padding = (512 - (body.byteLength % 512)) % 512;
    if (padding > 0) blocks.push(new Uint8Array(padding));
  }
  blocks.push(new Uint8Array(1024));
  return concatenate(blocks);
}

function writeTarText(header, offset, length, value) {
  const bytes = encoder.encode(value);
  assert.ok(bytes.byteLength <= length, `test tar path is too long: ${value}`);
  header.set(bytes, offset);
}

function writeTarOctal(header, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, "0");
  writeTarText(header, offset, length - 1, text);
  header[offset + length - 1] = 0;
}

function writeTarChecksum(header, value) {
  const text = value.toString(8).padStart(6, "0");
  writeTarText(header, 148, 6, text);
  header[154] = 0;
  header[155] = 0x20;
}

function concatenate(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
