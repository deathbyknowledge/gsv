import { describe, expect, it, vi } from "vitest";
import {
  PIPER_DEFAULT_VOICE,
  PIPER_PUBLIC_ASSET_MANIFEST_KEY,
  PIPER_PUBLIC_ASSETS,
  seedPiperPublicAssets,
} from "./piper-assets";

describe("Piper public asset seeding", () => {
  it("mirrors missing Piper runtime and default voice assets into public storage", async () => {
    const writes: Array<{ key: string; value: unknown; contentType?: string; cacheControl?: string }> = [];
    const bucket = {
      head: vi.fn(async () => null),
      put: vi.fn(async (
        key: string,
        value: unknown,
        options?: { httpMetadata?: { contentType?: string; cacheControl?: string } },
      ) => {
        writes.push({
          key,
          value,
          contentType: options?.httpMetadata?.contentType,
          cacheControl: options?.httpMetadata?.cacheControl,
        });
        return null;
      }),
    } as unknown as R2Bucket;
    const fetchAsset = vi.fn(async (url: string) => new Response(`asset:${url}`, {
      headers: { "content-type": url.endsWith(".wasm") ? "application/wasm" : "application/octet-stream" },
    }));

    const result = await seedPiperPublicAssets(bucket, fetchAsset as typeof fetch);

    expect(result).toEqual({
      assets: PIPER_PUBLIC_ASSETS.length,
      seeded: PIPER_PUBLIC_ASSETS.length,
      skipped: 0,
    });
    expect(fetchAsset).toHaveBeenCalledTimes(PIPER_PUBLIC_ASSETS.length);
    expect(writes.map((write) => write.key)).toEqual([
      ...PIPER_PUBLIC_ASSETS.map((asset) => asset.key),
      PIPER_PUBLIC_ASSET_MANIFEST_KEY,
    ]);
    expect(writes[0].key).toBe("public/gsv/assets/tts/onnxruntime-web/1.26.0/ort.min.mjs");
    expect(writes[0].cacheControl).toBe("public, max-age=31536000, immutable");
    expect(writes.some((write) => write.key.endsWith(`${PIPER_DEFAULT_VOICE}.onnx`))).toBe(true);
  });

  it("skips already mirrored assets and still refreshes the manifest", async () => {
    const writtenKeys: string[] = [];
    const bucket = {
      head: vi.fn(async () => ({ key: "existing" })),
      put: vi.fn(async (key: string) => {
        writtenKeys.push(key);
        return null;
      }),
    } as unknown as R2Bucket;
    const fetchAsset = vi.fn();

    const result = await seedPiperPublicAssets(bucket, fetchAsset as typeof fetch);

    expect(result).toEqual({
      assets: PIPER_PUBLIC_ASSETS.length,
      seeded: 0,
      skipped: PIPER_PUBLIC_ASSETS.length,
    });
    expect(fetchAsset).not.toHaveBeenCalled();
    expect(writtenKeys).toEqual([PIPER_PUBLIC_ASSET_MANIFEST_KEY]);
  });

  it("fails when an upstream asset cannot be fetched", async () => {
    const bucket = {
      head: vi.fn(async () => null),
      put: vi.fn(),
    } as unknown as R2Bucket;
    const fetchAsset = vi.fn(async () => new Response("missing", { status: 404 }));

    await expect(seedPiperPublicAssets(bucket, fetchAsset as typeof fetch)).rejects.toThrow(
      "Failed to seed Piper asset",
    );
    expect(bucket.put).not.toHaveBeenCalled();
  });
});

