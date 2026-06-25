import { describe, expect, it } from "vitest";
import type { OpenFileOptions, OpenFileRange, OpenFileRangeRequest, OpenFileResult } from "./fs/mount";
import {
  ensurePublicAssetStorageLayout,
  matchPublicAssetPath,
  servePublicAssetRequest,
  type PublicAssetFileSystem,
} from "./public-assets";

class FakePublicAssetFs implements PublicAssetFileSystem {
  readonly files = new Map<string, {
    bytes: Uint8Array;
    mtime: Date;
    contentType?: string;
    cacheControl?: string;
  }>();
  readonly links = new Map<string, string>();

  put(
    path: string,
    content: string,
    options: { mtime?: Date; contentType?: string; cacheControl?: string } = {},
  ): void {
    this.files.set(path, {
      bytes: new TextEncoder().encode(content),
      mtime: options.mtime ?? new Date("2026-05-20T12:00:00Z"),
      contentType: options.contentType,
      cacheControl: options.cacheControl,
    });
  }

  link(path: string, target: string): void {
    this.links.set(path, target);
  }

  async realpath(path: string): Promise<string> {
    return this.links.get(path) ?? path;
  }

  async openFile(path: string, options?: OpenFileOptions): Promise<OpenFileResult> {
    const file = this.files.get(path);
    if (!file) {
      throw new Error("ENOENT");
    }

    const etag = fakeEtag(file.bytes, file.mtime);
    if (options?.conditions?.etagDoesNotMatch === etag) {
      return this.openResult(file, etag, undefined, 304);
    }

    const range = resolveRange(options?.range, file.bytes.byteLength);
    const bytes = range
      ? file.bytes.slice(range.offset, range.offset + range.length)
      : file.bytes;
    return this.openResult(file, etag, bytes, range ? 206 : 200, range);
  }

  private openResult(
    file: { bytes: Uint8Array; mtime: Date; contentType?: string; cacheControl?: string },
    etag: string,
    bytes: Uint8Array | undefined,
    status: OpenFileResult["status"],
    range?: OpenFileRange,
  ): OpenFileResult {
    return {
      body: bytes ? bytesToStream(bytes) : undefined,
      size: range?.length ?? file.bytes.byteLength,
      totalSize: file.bytes.byteLength,
      mtime: file.mtime,
      status,
      contentType: file.contentType,
      etag,
      range,
      writeHttpMetadata: (headers) => {
        if (file.contentType) {
          headers.set("content-type", file.contentType);
        }
        if (file.cacheControl) {
          headers.set("cache-control", file.cacheControl);
        }
      },
    };
  }
}

function fakeEtag(bytes: Uint8Array, mtime: Date): string {
  return `W/"${bytes.byteLength.toString(16)}-${mtime.getTime().toString(16)}"`;
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function resolveRange(request: OpenFileRangeRequest | undefined, total: number): OpenFileRange | undefined {
  if (!request) {
    return undefined;
  }

  if ("suffix" in request) {
    const length = Math.min(request.suffix, total);
    return {
      offset: total - length,
      length,
      total,
    };
  }

  const offset = request.offset;
  if (!Number.isFinite(offset) || offset >= total) {
    return undefined;
  }

  const length = request.length ?? total - offset;
  return {
    offset,
    length: Math.min(total - offset, length),
    total,
  };
}

describe("public asset serving", () => {
  it("creates the public directory marker during storage setup", async () => {
    const writes: Array<{ key: string; metadata: Record<string, string> | undefined }> = [];
    const env = {
      STORAGE: {
        head: async () => null,
        put: async (key: string, _value: unknown, options?: { customMetadata?: Record<string, string> }) => {
          writes.push({ key, metadata: options?.customMetadata });
          return null;
        },
      },
    } as unknown as Pick<Env, "STORAGE">;

    await ensurePublicAssetStorageLayout(env);

    expect(writes).toEqual([{
      key: "public/.dir",
      metadata: {
        uid: "0",
        gid: "0",
        mode: "755",
        dirmarker: "1",
      },
    }]);
  });

  it("maps public URL paths to the public filesystem root", () => {
    expect(matchPublicAssetPath("/public/gsv/assets/app-logo.bin")).toEqual({
      fsPath: "/public/gsv/assets/app-logo.bin",
    });
    expect(matchPublicAssetPath("/public/wallpapers/hello%20world.jpg")).toEqual({
      fsPath: "/public/wallpapers/hello world.jpg",
    });
  });

  it("rejects empty roots and traversal attempts", () => {
    expect(matchPublicAssetPath("/public")).toBeNull();
    expect(matchPublicAssetPath("/public/")).toBeNull();
    expect(matchPublicAssetPath("/public/%2e%2e/secret.txt")).toBeNull();
    expect(matchPublicAssetPath("/public/assets%2fsecret.txt")).toBeNull();
  });

  it("serves files with public asset headers", async () => {
    const fs = new FakePublicAssetFs();
    fs.put("/public/gsv/assets/app-logo.bin", "asset", {
      contentType: "application/octet-stream",
      cacheControl: "private, max-age=0",
    });
    const match = matchPublicAssetPath("/public/gsv/assets/app-logo.bin");

    const response = await servePublicAssetRequest(
      new Request("https://gsv.test/public/gsv/assets/app-logo.bin"),
      fs,
      match!,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("asset");
  });

  it("relays stored HTTP metadata for normal public files", async () => {
    const fs = new FakePublicAssetFs();
    fs.put("/public/wallpapers/current.webp", "image", {
      contentType: "image/webp",
      cacheControl: "public, max-age=60",
    });
    const match = matchPublicAssetPath("/public/wallpapers/current.webp");

    const response = await servePublicAssetRequest(
      new Request("https://gsv.test/public/wallpapers/current.webp"),
      fs,
      match!,
    );

    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("does not serve symlinks that resolve outside the public tree", async () => {
    const fs = new FakePublicAssetFs();
    fs.link("/public/latest-secret.txt", "/home/hank/secret.txt");
    fs.put("/home/hank/secret.txt", "secret");
    const match = matchPublicAssetPath("/public/latest-secret.txt");

    const response = await servePublicAssetRequest(
      new Request("https://gsv.test/public/latest-secret.txt"),
      fs,
      match!,
    );

    expect(response.status).toBe(404);
  });

  it("supports HEAD and conditional GET without reading the file body", async () => {
    const fs = new FakePublicAssetFs();
    fs.put("/public/wallpapers/current.png", "image");
    const match = matchPublicAssetPath("/public/wallpapers/current.png");

    const head = await servePublicAssetRequest(
      new Request("https://gsv.test/public/wallpapers/current.png", { method: "HEAD" }),
      fs,
      match!,
    );
    const etag = head.headers.get("etag");

    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("5");
    expect(await head.text()).toBe("");
    expect(etag).toBeTruthy();

    const cached = await servePublicAssetRequest(
      new Request("https://gsv.test/public/wallpapers/current.png", {
        headers: { "if-none-match": etag! },
      }),
      fs,
      match!,
    );

    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");
  });

  it("serves byte ranges from the opened file result", async () => {
    const fs = new FakePublicAssetFs();
    fs.put("/public/audio/sample.wav", "image");
    const match = matchPublicAssetPath("/public/audio/sample.wav");

    const response = await servePublicAssetRequest(
      new Request("https://gsv.test/public/audio/sample.wav", {
        headers: { range: "bytes=1-3" },
      }),
      fs,
      match!,
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-length")).toBe("3");
    expect(response.headers.get("content-range")).toBe("bytes 1-3/5");
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("mag");
  });

  it("rejects malformed byte ranges before opening the file", async () => {
    const fs = new FakePublicAssetFs();
    fs.put("/public/audio/sample.wav", "image");
    const match = matchPublicAssetPath("/public/audio/sample.wav");

    const response = await servePublicAssetRequest(
      new Request("https://gsv.test/public/audio/sample.wav", {
        headers: { range: "bytes=3-1" },
      }),
      fs,
      match!,
    );

    expect(response.status).toBe(416);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
  });

  it("rejects byte ranges beyond EOF after opening the file", async () => {
    const fs = new FakePublicAssetFs();
    fs.put("/public/audio/sample.wav", "image");
    const match = matchPublicAssetPath("/public/audio/sample.wav");

    const response = await servePublicAssetRequest(
      new Request("https://gsv.test/public/audio/sample.wav", {
        headers: { range: "bytes=5-" },
      }),
      fs,
      match!,
    );

    expect(response.status).toBe(416);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBe("bytes */5");
  });

  it("sandboxes document-like public files", async () => {
    const fs = new FakePublicAssetFs();
    fs.put("/public/site/index.html", "<script>alert(1)</script>");
    const match = matchPublicAssetPath("/public/site/index.html");

    const response = await servePublicAssetRequest(
      new Request("https://gsv.test/public/site/index.html"),
      fs,
      match!,
    );

    expect(response.headers.get("content-security-policy")).toBe("sandbox");
  });
});
