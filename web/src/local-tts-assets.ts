export const ONNX_RUNTIME_VERSION = "1.26.0";
export const PIPER_WASM_VERSION = "1.0.0";
export const PIPER_VOICE_REF = "main";

export const GSV_TTS_PUBLIC_BASE = "/public/gsv/assets/tts";
export const GSV_ONNX_RUNTIME_BASE = `${GSV_TTS_PUBLIC_BASE}/onnxruntime-web/${ONNX_RUNTIME_VERSION}/`;
export const GSV_ONNX_RUNTIME_MODULE = `${GSV_ONNX_RUNTIME_BASE}ort.min.mjs`;
export const GSV_PIPER_WASM_BASE = `${GSV_TTS_PUBLIC_BASE}/piper-wasm/${PIPER_WASM_VERSION}/piper_phonemize`;
export const GSV_PIPER_VOICE_BASE = `${GSV_TTS_PUBLIC_BASE}/piper-voices/${PIPER_VOICE_REF}`;

export const HUGGINGFACE_PIPER_VOICE_BASE = `https://huggingface.co/diffusionstudio/piper-voices/resolve/${PIPER_VOICE_REF}`;

export const DEFAULT_PIPER_VOICE = "en_US-lessac-medium";
