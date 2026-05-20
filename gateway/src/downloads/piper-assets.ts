export const PIPER_PUBLIC_ASSET_ROOT = "public/gsv/assets/tts";
export const PIPER_PUBLIC_URL_ROOT = "/public/gsv/assets/tts";
export const PIPER_DEFAULT_VOICE = "en_US-lessac-medium";

export const ONNX_RUNTIME_VERSION = "1.26.0";
export const PIPER_WASM_VERSION = "1.0.0";
export const PIPER_VOICE_REF = "main";

const ONNX_RUNTIME_CDN_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ONNX_RUNTIME_VERSION}/dist`;
const PIPER_WASM_CDN_BASE = `https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@${PIPER_WASM_VERSION}/build`;
const PIPER_VOICE_BASE = `https://huggingface.co/diffusionstudio/piper-voices/resolve/${PIPER_VOICE_REF}`;

type PiperPublicAsset = {
  key: string;
  sourceUrl: string;
  contentType: string;
};

export const PIPER_DEFAULT_VOICE_MODEL_PATHS: Record<string, string> = {
  [PIPER_DEFAULT_VOICE]: "en/en_US/lessac/medium/en_US-lessac-medium.onnx",
};

export const PIPER_PUBLIC_ASSET_MANIFEST_KEY = `${PIPER_PUBLIC_ASSET_ROOT}/manifest.json`;

export const PIPER_PUBLIC_ASSETS: readonly PiperPublicAsset[] = [
  {
    key: `${PIPER_PUBLIC_ASSET_ROOT}/onnxruntime-web/${ONNX_RUNTIME_VERSION}/ort.min.mjs`,
    sourceUrl: `${ONNX_RUNTIME_CDN_BASE}/ort.min.mjs`,
    contentType: "application/javascript; charset=utf-8",
  },
  ...[
    "ort-wasm-simd-threaded.jsep.mjs",
    "ort-wasm-simd-threaded.jsep.wasm",
    "ort-wasm-simd-threaded.mjs",
    "ort-wasm-simd-threaded.wasm",
    "ort-wasm-simd-threaded.asyncify.mjs",
    "ort-wasm-simd-threaded.asyncify.wasm",
    "ort-wasm-simd-threaded.jspi.mjs",
    "ort-wasm-simd-threaded.jspi.wasm",
  ].map((file): PiperPublicAsset => ({
    key: `${PIPER_PUBLIC_ASSET_ROOT}/onnxruntime-web/${ONNX_RUNTIME_VERSION}/${file}`,
    sourceUrl: `${ONNX_RUNTIME_CDN_BASE}/${file}`,
    contentType: file.endsWith(".wasm") ? "application/wasm" : "application/javascript; charset=utf-8",
  })),
  {
    key: `${PIPER_PUBLIC_ASSET_ROOT}/piper-wasm/${PIPER_WASM_VERSION}/piper_phonemize.data`,
    sourceUrl: `${PIPER_WASM_CDN_BASE}/piper_phonemize.data`,
    contentType: "application/octet-stream",
  },
  {
    key: `${PIPER_PUBLIC_ASSET_ROOT}/piper-wasm/${PIPER_WASM_VERSION}/piper_phonemize.wasm`,
    sourceUrl: `${PIPER_WASM_CDN_BASE}/piper_phonemize.wasm`,
    contentType: "application/wasm",
  },
  ...Object.values(PIPER_DEFAULT_VOICE_MODEL_PATHS).flatMap((voicePath): PiperPublicAsset[] => [
    {
      key: `${PIPER_PUBLIC_ASSET_ROOT}/piper-voices/${PIPER_VOICE_REF}/${voicePath}`,
      sourceUrl: `${PIPER_VOICE_BASE}/${voicePath}`,
      contentType: "application/octet-stream",
    },
    {
      key: `${PIPER_PUBLIC_ASSET_ROOT}/piper-voices/${PIPER_VOICE_REF}/${voicePath}.json`,
      sourceUrl: `${PIPER_VOICE_BASE}/${voicePath}.json`,
      contentType: "application/json; charset=utf-8",
    },
  ]),
];

export type PiperPublicAssetSeedResult = {
  assets: number;
  seeded: number;
  skipped: number;
};

export async function seedPiperPublicAssets(
  bucket: R2Bucket,
  fetchAsset: typeof fetch = fetch,
): Promise<PiperPublicAssetSeedResult> {
  let seeded = 0;
  let skipped = 0;

  for (const asset of PIPER_PUBLIC_ASSETS) {
    if (await bucket.head(asset.key)) {
      skipped += 1;
      continue;
    }

    const response = await fetchAsset(asset.sourceUrl);
    if (!response.ok) {
      throw new Error(`Failed to seed Piper asset ${asset.sourceUrl}: ${response.status}`);
    }

    await bucket.put(asset.key, response.body ?? await response.arrayBuffer(), {
      httpMetadata: {
        contentType: response.headers.get("content-type") || asset.contentType,
        cacheControl: "public, max-age=31536000, immutable",
      },
    });
    seeded += 1;
  }

  await bucket.put(PIPER_PUBLIC_ASSET_MANIFEST_KEY, JSON.stringify({
    generatedAt: new Date().toISOString(),
    onnxRuntimeVersion: ONNX_RUNTIME_VERSION,
    piperWasmVersion: PIPER_WASM_VERSION,
    defaultVoice: PIPER_DEFAULT_VOICE,
    assets: PIPER_PUBLIC_ASSETS.map((asset) => ({
      key: asset.key,
      sourceUrl: asset.sourceUrl,
    })),
  }, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });

  return {
    assets: PIPER_PUBLIC_ASSETS.length,
    seeded,
    skipped,
  };
}

