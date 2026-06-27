import { describe, expect, it, vi } from "vitest";
import {
  packageArtifactPublicBase,
  packageArtifactToWorkerCode,
  storePackageArtifact,
  type PackageArtifact,
} from "./packages";

type PutRecord = {
  key: string;
  value: unknown;
  options?: R2PutOptions;
};

function makeBucket(): R2Bucket & { puts: PutRecord[] } {
  const puts: PutRecord[] = [];
  return {
    puts,
    async put(key: string, value: unknown, options?: R2PutOptions) {
      puts.push({ key, value, options });
      return {} as R2Object;
    },
  } as R2Bucket & { puts: PutRecord[] };
}

describe("package artifacts", () => {
  it("stores public package files under the public fs root", async () => {
    const bucket = makeBucket();
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
      publicFiles: [
        {
          path: "gsv/packages/__GSV_ARTIFACT_HASH__/browser/src/main.js",
          contentType: "text/javascript; charset=utf-8",
          encoding: "utf-8",
          content: "import \"/public/gsv/packages/__GSV_ARTIFACT_HASH__/browser/src/app.js\";",
        },
        {
          path: "lib/npm/wasm-lib/1.0.0/module.wasm",
          contentType: "application/wasm",
          encoding: "base64",
          content: "AGFzbQ==",
        },
      ],
    };

    await storePackageArtifact(bucket, artifact);

    const main = bucket.puts.find((record) =>
      record.key === "public/gsv/packages/sha256-abc123/browser/src/main.js"
    );
    expect(main?.value).toBe("import \"/public/gsv/packages/sha256-abc123/browser/src/app.js\";");
    expect(main?.options?.httpMetadata?.contentType).toBe("text/javascript; charset=utf-8");
    expect(main?.options?.httpMetadata?.cacheControl).toBe("public, max-age=31536000, immutable");
    expect(main?.options?.customMetadata?.mode).toBe("644");

    const wasm = bucket.puts.find((record) =>
      record.key === "public/lib/npm/wasm-lib/1.0.0/module.wasm"
    );
    expect(Array.from(wasm?.value as Uint8Array)).toEqual([0x00, 0x61, 0x73, 0x6d]);
    expect(wasm?.options?.httpMetadata?.contentType).toBe("application/wasm");

    const loaderArtifact = bucket.puts.find((record) =>
      record.key === "runtime/package-artifacts/sha256%3Aabc123.json"
    );
    expect(JSON.parse(loaderArtifact?.value as string)).not.toHaveProperty("publicFiles");
  });

  it("derives a stable public base from an artifact hash", () => {
    expect(packageArtifactPublicBase("sha256:abc123")).toBe("/public/gsv/packages/sha256-abc123");
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
