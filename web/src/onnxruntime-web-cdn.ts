type OnnxRuntimeModule = {
  env: {
    wasm: {
      numThreads?: number;
      wasmPaths?: string;
    };
  };
  InferenceSession: unknown;
  Tensor: unknown;
};

import {
  GSV_ONNX_RUNTIME_BASE,
  GSV_ONNX_RUNTIME_MODULE,
} from "./local-tts-assets";

const ort = await import(
  /* @vite-ignore */
  GSV_ONNX_RUNTIME_MODULE
) as OnnxRuntimeModule;

export const env = ort.env;
configureWasmThreads(env.wasm);
env.wasm.wasmPaths = GSV_ONNX_RUNTIME_BASE;
export const InferenceSession = ort.InferenceSession;
export const Tensor = ort.Tensor;

function configureWasmThreads(wasm: OnnxRuntimeModule["env"]["wasm"]): void {
  const supportsThreads = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  const defaultThreads = supportsThreads ? normalizeThreadCount(navigator.hardwareConcurrency) : 1;
  let numThreads = defaultThreads;

  try {
    Object.defineProperty(wasm, "numThreads", {
      configurable: true,
      enumerable: true,
      get() {
        return numThreads;
      },
      set(value: unknown) {
        numThreads = supportsThreads ? normalizeThreadCount(value) : 1;
      },
    });
  } catch {
    // Some runtimes may make env.wasm immutable. Best effort still avoids our own bad value.
  }

  wasm.numThreads = defaultThreads;
}

function normalizeThreadCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : 1;
}
