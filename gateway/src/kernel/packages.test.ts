import { describe, expect, it, vi } from "vitest";
import {
  artifactMetadataFromArtifact,
  computePackageArtifactHash,
  loadPackageArtifact,
  packageArtifactPublicBase,
  packageArtifactStorageKey,
  packageArtifactToWorkerCode,
  storePackageArtifact,
  type PackageArtifact,
} from "./packages";

type PutRecord = {
  key: string;
  value: unknown;
  options?: R2PutOptions;
};

type StoredObject = {
  bytes: Uint8Array;
  httpMetadata: R2HTTPMetadata;
  customMetadata: Record<string, string>;
};

type TestBucket = R2Bucket & {
  puts: PutRecord[];
  objects: Map<string, StoredObject>;
  seed(key: string, value: string | Uint8Array, options?: R2PutOptions): void;
};

const ZERO_HASH = `sha256:${"0".repeat(64)}`;

function makeBucket(): TestBucket {
  const puts: PutRecord[] = [];
  const objects = new Map<string, StoredObject>();
  const seed = (key: string, value: string | Uint8Array, options: R2PutOptions = {}) => {
    objects.set(key, {
      bytes: typeof value === "string" ? new TextEncoder().encode(value) : value.slice(),
      httpMetadata: options.httpMetadata instanceof Headers ? {} : options.httpMetadata ?? {},
      customMetadata: options.customMetadata ?? {},
    });
  };
  return {
    puts,
    objects,
    seed,
    async get(key: string) {
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        key,
        version: "1",
        size: stored.bytes.byteLength,
        etag: "etag",
        httpEtag: '"etag"',
        uploaded: new Date(0),
        httpMetadata: stored.httpMetadata,
        customMetadata: stored.customMetadata,
        checksums: {},
        storageClass: "Standard",
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(stored.bytes.slice());
            controller.close();
          },
        }),
        bodyUsed: false,
        async arrayBuffer() {
          return stored.bytes.slice().buffer;
        },
        async text() {
          return new TextDecoder().decode(stored.bytes);
        },
        async json<T>() {
          return JSON.parse(new TextDecoder().decode(stored.bytes)) as T;
        },
        async blob() {
          return new Blob([stored.bytes.slice()]);
        },
        writeHttpMetadata() {},
      } as R2ObjectBody;
    },
    async put(key: string, value: unknown, options?: R2PutOptions) {
      puts.push({ key, value, options });
      if (
        !(options?.onlyIf instanceof Headers)
        && options?.onlyIf?.etagDoesNotMatch === "*"
        && objects.has(key)
      ) {
        return null;
      }
      if (typeof value !== "string" && !(value instanceof Uint8Array)) {
        throw new Error(`Unsupported test R2 value for ${key}`);
      }
      seed(key, value, options);
      return {} as R2Object;
    },
  } as unknown as TestBucket;
}

async function packageArtifact(
  input: Omit<PackageArtifact, "hash">,
): Promise<PackageArtifact> {
  const candidate: PackageArtifact = {
    hash: ZERO_HASH,
    ...input,
  };
  return {
    ...candidate,
    hash: await computePackageArtifactHash(candidate),
  };
}

describe("package artifacts", () => {
  it("stores public package files under the public fs root", async () => {
    const bucket = makeBucket();
    const artifact = await packageArtifact({
      mainModule: "__gsv__/main.ts",
      modules: [
        {
          path: "__gsv__/main.ts",
          kind: "esm",
          content: "export default {};",
        },
      ],
      publicFiles: [
        {
          path: "gsv/packages/__GSV_ARTIFACT_HASH__/browser/src/main.js",
          contentType: "text/javascript; charset=utf-8",
          encoding: "utf-8",
          content: [
            "import \"/public/gsv/packages/__GSV_ARTIFACT_HASH__/browser/src/app.js\";",
            "import \"/public/lib/npm/wasm-lib/1.0.0/module.wasm\";",
          ].join("\n"),
        },
        {
          path: "lib/npm/wasm-lib/1.0.0/module.wasm",
          contentType: "application/wasm",
          encoding: "base64",
          content: "AGFzbQ==",
        },
      ],
    });

    await storePackageArtifact(bucket, artifact);

    const publicSegment = artifact.hash.replace(":", "-");
    const main = bucket.puts.find((record) =>
      record.key === `public/gsv/packages/${publicSegment}/browser/src/main.js`
    );
    expect(main?.value).toBe(
      [
        `import \"/public/gsv/packages/${publicSegment}/browser/src/app.js\";`,
        `import \"/public/gsv/packages/${publicSegment}/lib/npm/wasm-lib/1.0.0/module.wasm\";`,
      ].join("\n"),
    );
    expect(main?.options?.httpMetadata?.contentType).toBe("text/javascript; charset=utf-8");
    expect(main?.options?.httpMetadata?.cacheControl).toBe("public, max-age=31536000, immutable");
    expect(main?.options?.customMetadata?.mode).toBe("644");
    expect(main?.options?.onlyIf).toEqual({ etagDoesNotMatch: "*" });

    const wasm = bucket.puts.find((record) =>
      record.key === `public/gsv/packages/${publicSegment}/lib/npm/wasm-lib/1.0.0/module.wasm`
    );
    expect(Array.from(wasm?.value as Uint8Array)).toEqual([0x00, 0x61, 0x73, 0x6d]);
    expect(wasm?.options?.httpMetadata?.contentType).toBe("application/wasm");

    const loaderArtifact = bucket.puts.find((record) =>
      record.key === packageArtifactStorageKey(artifact.hash)
    );
    const loaderRecord = JSON.parse(loaderArtifact?.value as string) as Record<string, unknown>;
    expect(loaderRecord.loaderVersion).toBe(1);
    expect(loaderRecord.publicFiles).toHaveLength(2);
    expect(loaderArtifact?.options?.onlyIf).toEqual({ etagDoesNotMatch: "*" });
    expect(artifactMetadataFromArtifact(artifact).publicFilePaths).toEqual([
      "browser/src/main.js",
      "lib/npm/wasm-lib/1.0.0/module.wasm",
    ]);
  });

  it("derives a stable public base from an artifact hash", () => {
    expect(packageArtifactPublicBase("sha256:abc123")).toBe("/public/gsv/packages/sha256-abc123");
  });

  it("recomputes the assembler canonical SHA-256 input", async () => {
    const artifact = await packageArtifact({
      mainModule: "__gsv__/main.ts",
      modules: [{
        path: "__gsv__/main.ts",
        kind: "esm",
        content: "export default {};",
      }],
    });

    expect(artifact.hash).toBe(
      "sha256:0bbe0ddafddfc3b0e81414808e5575f2552c29ceee42558d77d1dea128be31b5",
    );
  });

  it("rejects a spoofed assembler hash before writing anything", async () => {
    const bucket = makeBucket();
    const artifact = await packageArtifact({
      mainModule: "__gsv__/main.ts",
      modules: [{
        path: "__gsv__/main.ts",
        kind: "esm",
        content: "export default {};",
      }],
    });
    const spoofed: PackageArtifact = {
      ...artifact,
      modules: [{
        ...artifact.modules[0],
        content: "export default { pwned: true };",
      }],
    };

    await expect(storePackageArtifact(bucket, spoofed)).rejects.toThrow(
      "Package artifact hash mismatch",
    );
    expect(bucket.puts).toHaveLength(0);
  });

  it("rejects public files outside the exact content-addressed namespace", async () => {
    const artifact = await packageArtifact({
      mainModule: "__gsv__/main.ts",
      modules: [{
        path: "__gsv__/main.ts",
        kind: "esm",
        content: "export default {};",
      }],
      publicFiles: [{
        path: "gsv/packages/__GSV_ARTIFACT_HASH__/browser/main.js",
        contentType: "text/javascript",
        encoding: "utf-8",
        content: "export {};",
      }],
    });

    const hostilePaths = [
      "root-owned.js",
      "gsv/assets/root-owned.js",
      "gsv/packages/__GSV_ARTIFACT_HASH__/../root-owned.js",
      "gsv/packages/__GSV_ARTIFACT_HASH__/%2e%2e/root-owned.js",
      "gsv/packages/__GSV_ARTIFACT_HASH__/browser//main.js",
      "gsv/packages/__GSV_ARTIFACT_HASH__/browser\\main.js",
    ];
    for (const path of hostilePaths) {
      const bucket = makeBucket();
      const hostile: PackageArtifact = {
        ...artifact,
        publicFiles: [{ ...artifact.publicFiles![0], path }],
      };
      await expect(storePackageArtifact(bucket, hostile)).rejects.toThrow(/Package public file|Invalid package public/);
      expect(bucket.puts, path).toHaveLength(0);
    }
  });

  it("uses create-only writes while allowing byte-identical repeated installs", async () => {
    const bucket = makeBucket();
    const artifact = await packageArtifact({
      mainModule: "__gsv__/main.ts",
      modules: [{
        path: "__gsv__/main.ts",
        kind: "esm",
        content: "export default {};",
      }],
      publicFiles: [{
        path: "gsv/packages/__GSV_ARTIFACT_HASH__/browser/main.js",
        contentType: "text/javascript",
        encoding: "utf-8",
        content: "export {};",
      }],
    });

    await storePackageArtifact(bucket, artifact);
    await expect(storePackageArtifact(bucket, artifact)).resolves.toBeUndefined();
    expect(bucket.puts).toHaveLength(4);
    expect(bucket.puts.every((put) =>
      !(put.options?.onlyIf instanceof Headers)
      && put.options?.onlyIf?.etagDoesNotMatch === "*"
    )).toBe(true);
  });

  it("never overwrites a conflicting object in the artifact public namespace", async () => {
    const bucket = makeBucket();
    const artifact = await packageArtifact({
      mainModule: "__gsv__/main.ts",
      modules: [{
        path: "__gsv__/main.ts",
        kind: "esm",
        content: "export default {};",
      }],
      publicFiles: [{
        path: "gsv/packages/__GSV_ARTIFACT_HASH__/browser/main.js",
        contentType: "text/javascript",
        encoding: "utf-8",
        content: "expected",
      }],
    });
    const key = `public/gsv/packages/${artifact.hash.replace(":", "-")}/browser/main.js`;
    bucket.seed(key, "root content", {
      httpMetadata: {
        contentType: "text/javascript",
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: { uid: "0", gid: "0", mode: "644" },
    });

    await expect(storePackageArtifact(bucket, artifact)).rejects.toThrow(
      `Package artifact storage collision: ${key}`,
    );
    expect(new TextDecoder().decode(bucket.objects.get(key)?.bytes)).toBe("root content");

    bucket.seed(key, "expected", {
      httpMetadata: {
        contentType: "text/javascript",
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: { uid: "0", gid: "0", mode: "666" },
    });
    await expect(storePackageArtifact(bucket, artifact)).rejects.toThrow(
      `Package artifact storage collision: ${key}`,
    );
  });

  it("revalidates stored artifact shape and hash on load", async () => {
    const bucket = makeBucket();
    const artifact = await packageArtifact({
      mainModule: "__gsv__/main.ts",
      modules: [{
        path: "__gsv__/main.ts",
        kind: "esm",
        content: "export default {};",
      }],
    });
    await storePackageArtifact(bucket, artifact);
    await expect(loadPackageArtifact(bucket, artifact.hash)).resolves.toMatchObject({
      hash: artifact.hash,
      mainModule: artifact.mainModule,
    });

    const key = packageArtifactStorageKey(artifact.hash);
    const storedRecord = JSON.parse(
      new TextDecoder().decode(bucket.objects.get(key)?.bytes),
    ) as Record<string, unknown>;
    expect(storedRecord.loaderVersion).toBe(1);
    const tampered = {
      ...storedRecord,
      modules: [{ ...artifact.modules[0], content: "tampered" }],
    };
    bucket.seed(key, JSON.stringify(tampered), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    await expect(loadPackageArtifact(bucket, artifact.hash)).rejects.toThrow(
      "Package artifact hash mismatch",
    );

    bucket.seed(key, JSON.stringify({ ...storedRecord, modules: "not-an-array" }), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    await expect(loadPackageArtifact(bucket, artifact.hash)).rejects.toThrow(
      "artifact.modules must contain at least one module",
    );
  });

  it("loads modules from legacy loader records that omitted public files", async () => {
    const bucket = makeBucket();
    const artifact = await packageArtifact({
      mainModule: "__gsv__/main.ts",
      modules: [{
        path: "__gsv__/main.ts",
        kind: "esm",
        content: "export default { legacy: true };",
      }],
      publicFiles: [{
        path: "gsv/packages/__GSV_ARTIFACT_HASH__/browser/main.js",
        contentType: "text/javascript",
        encoding: "utf-8",
        content: "export {};",
      }],
    });
    const { publicFiles: _publicFiles, ...legacyRecord } = artifact;
    bucket.seed(
      packageArtifactStorageKey(artifact.hash),
      JSON.stringify(legacyRecord),
      { httpMetadata: { contentType: "application/json; charset=utf-8" } },
    );

    const loaded = await loadPackageArtifact(bucket, artifact.hash);

    expect(loaded).toMatchObject({
      hash: artifact.hash,
      mainModule: artifact.mainModule,
      modules: artifact.modules,
      publicFiles: [],
    });
    expect(packageArtifactToWorkerCode(loaded).modules[artifact.mainModule]).toEqual({
      js: artifact.modules[0].content,
    });
  });

  it("rejects mismatched and malformed legacy loader records", async () => {
    const bucket = makeBucket();
    const artifact = await packageArtifact({
      mainModule: "__gsv__/main.ts",
      modules: [{
        path: "__gsv__/main.ts",
        kind: "esm",
        content: "export default {};",
      }],
      publicFiles: [{
        path: "gsv/packages/__GSV_ARTIFACT_HASH__/browser/main.js",
        contentType: "text/javascript",
        encoding: "utf-8",
        content: "export {};",
      }],
    });
    const { publicFiles: _publicFiles, ...legacyRecord } = artifact;
    const key = packageArtifactStorageKey(artifact.hash);

    bucket.seed(key, JSON.stringify({
      ...legacyRecord,
      hash: `sha256:${"1".repeat(64)}`,
    }));
    await expect(loadPackageArtifact(bucket, artifact.hash)).rejects.toThrow(
      "Package artifact identity mismatch",
    );

    bucket.seed(key, JSON.stringify({
      ...legacyRecord,
      modules: [{
        path: artifact.mainModule,
        kind: "executable",
        content: artifact.modules[0].content,
      }],
    }));
    await expect(loadPackageArtifact(bucket, artifact.hash)).rejects.toThrow(
      "Unsupported package module kind",
    );

    bucket.seed(key, JSON.stringify({
      loaderVersion: 1,
      ...legacyRecord,
    }));
    await expect(loadPackageArtifact(bucket, artifact.hash)).rejects.toThrow(
      "Versioned package artifact must include artifact.publicFiles",
    );
  });

  it("defaults dynamic worker outbound fetch to denied", () => {
    const artifact: PackageArtifact = {
      hash: "sha256:abc123",
      mainModule: "__gsv__/main.ts",
      modules: [
        {
          path: "__gsv__/main.ts",
          kind: "esm",
          content: "export default {};",
        },
      ],
    };

    expect(packageArtifactToWorkerCode(artifact).globalOutbound).toBeNull();
  });

  it("creates an allowlisted outbound fetcher for approved egress", async () => {
    const artifact: PackageArtifact = {
      hash: "sha256:abc123",
      mainModule: "__gsv__/main.ts",
      modules: [
        {
          path: "__gsv__/main.ts",
          kind: "esm",
          content: "export default {};",
        },
      ],
    };
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const code = packageArtifactToWorkerCode(artifact, undefined, {
        egress: { mode: "allowlist", allow: ["api.example.test"] },
      });

      await expect(code.globalOutbound?.fetch("https://api.example.test/v1")).resolves.toBeInstanceOf(Response);
      await expect(code.globalOutbound?.fetch("https://blocked.example.test/v1")).rejects.toThrow("Outbound request denied");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves schemes in outbound allowlist entries", async () => {
    const artifact: PackageArtifact = {
      hash: "sha256:abc123",
      mainModule: "__gsv__/main.ts",
      modules: [
        {
          path: "__gsv__/main.ts",
          kind: "esm",
          content: "export default {};",
        },
      ],
    };
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const code = packageArtifactToWorkerCode(artifact, undefined, {
        egress: {
          mode: "allowlist",
          allow: ["https://api.example.test", "http://legacy.example.test:8080"],
        },
      });

      await expect(code.globalOutbound?.fetch("https://api.example.test/v1")).resolves.toBeInstanceOf(Response);
      await expect(code.globalOutbound?.fetch("http://api.example.test/v1")).rejects.toThrow("Outbound request denied");
      await expect(code.globalOutbound?.fetch("http://legacy.example.test:8080/v1")).resolves.toBeInstanceOf(Response);
      await expect(code.globalOutbound?.fetch("https://legacy.example.test:8080/v1")).rejects.toThrow("Outbound request denied");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("prevents allowlisted outbound fetches from automatically following redirects", async () => {
    const artifact: PackageArtifact = {
      hash: "sha256:abc123",
      mainModule: "__gsv__/main.ts",
      modules: [
        {
          path: "__gsv__/main.ts",
          kind: "esm",
          content: "export default {};",
        },
      ],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      expect(request.url).toBe("https://api.example.test/redirect");
      expect(request.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://blocked.example.test/final",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const code = packageArtifactToWorkerCode(artifact, undefined, {
        egress: { mode: "allowlist", allow: ["api.example.test"] },
      });

      const response = await code.globalOutbound?.fetch("https://api.example.test/redirect", {
        redirect: "follow",
      });

      expect(response?.status).toBe(302);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
