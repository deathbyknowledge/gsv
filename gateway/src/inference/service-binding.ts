import {
  createInferenceRequest,
  decodeInferenceResponse,
} from "@humansandmachines/gsv-worker-runtime/inference-transport";

type InferenceService = Pick<Fetcher, "fetch">;

type WorkersAiEnvironment = {
  AI?: Ai;
  GSV_INFERENCE?: unknown;
};

type WorkersAiService = {
  run(
    model: string,
    input: unknown,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  models(params?: Record<string, unknown>): Promise<unknown>;
};

export function resolveWorkersAiBinding(runtimeEnv: WorkersAiEnvironment): Ai | undefined {
  if (runtimeEnv.GSV_INFERENCE === undefined) return runtimeEnv.AI;
  if (!isInferenceService(runtimeEnv.GSV_INFERENCE)) {
    throw new Error("GSV_INFERENCE service binding is invalid");
  }
  const service = runtimeEnv.GSV_INFERENCE;
  const binding: WorkersAiService = {
    async run(
      model: string,
      input: unknown,
      options?: Record<string, unknown>,
    ): Promise<unknown> {
      const { signal, transported } = transportOptions(options);
      const request = createInferenceRequest({
        operation: "run",
        model,
        input,
        ...(transported === undefined ? {} : { options: transported }),
      }, { signal });
      const response = await service.fetch(request);
      return decodeInferenceResponse(response, { signal });
    },
    async models(params?: Record<string, unknown>): Promise<unknown> {
      const request = createInferenceRequest({
        operation: "models",
        ...(params === undefined ? {} : { params }),
      });
      return decodeInferenceResponse(await service.fetch(request));
    },
  };
  return binding as unknown as Ai;
}

function isInferenceService(value: unknown): value is InferenceService {
  return value !== null
    && typeof value === "object"
    && typeof (value as { fetch?: unknown }).fetch === "function";
}

function transportOptions(
  value: Record<string, unknown> | undefined,
): { signal?: AbortSignal; transported?: Record<string, unknown> } {
  if (value === undefined) return {};
  if (!isPlainRecord(value)) throw new TypeError("Workers AI options must be an object");
  const { signal: rawSignal, headers, ...options } = value;
  const signal = inferenceSignal(rawSignal);
  const transported = {
    ...options,
    ...(headers === undefined
      ? {}
      : { headers: Array.from(new Headers(headers as HeadersInit).entries()) }),
  };
  return {
    ...(signal === undefined ? {} : { signal }),
    transported,
  };
}

function inferenceSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof AbortSignal)) {
    throw new TypeError("Workers AI signal must be an AbortSignal");
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
