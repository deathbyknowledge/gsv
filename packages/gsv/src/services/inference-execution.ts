import type {
  AiConfigResult,
  AiTextGenerateOptions,
  AiTextMessage,
  AiTextTool,
  AiImageReadResponseFormat,
  AiImageReadResult,
  AiTranscriptionCreateResult,
} from "../protocol/syscalls/ai";
import type { JsonObject } from "../protocol/json";
import type {
  ManagedInferenceAbortReason,
  ManagedInferenceActor,
  ManagedInferenceResult,
  ManagedInferenceWorkload,
} from "./inference";

/** Kernel-authorized connection. Credentials are transient and must never be stored. */
export type InferenceConnection = Pick<
  AiConfigResult,
  | "provider"
  | "model"
  | "apiKey"
  | "baseUrl"
  | "providerStyle"
  | "openAiCodex"
  | "reasoning"
  | "maxTokens"
  | "contextWindowTokens"
>;

/** One generation; Process continues to own history and model-stack fallback. */
export type InferenceExecutionRequest = {
  version: 1;
  installationId: string;
  logicalRequestId: string;
  actor: ManagedInferenceActor;
  workload?: ManagedInferenceWorkload;
  connection: InferenceConnection;
  systemPrompt?: string;
  messages: AiTextMessage[];
  tools?: AiTextTool[];
  options?: AiTextGenerateOptions;
  sessionAffinityKey?: string;
  timeoutMs: number;
  deadlineAt: number;
};

/**
 * A Kernel-authorized transport for one generation and one selected target.
 * Request and response bodies transfer ownership to the receiver. Cancellation
 * remains explicit because an AbortSignal cannot be carried across Worker RPC.
 */
export interface InferenceTransport {
  fetch(requestId: string, request: Request): Promise<Response>;
  abort(requestId: string): Promise<void>;
}

/** Returned only to a trusted gateway; its identity cannot change per call. */
export interface InferenceExecutor {
  generate(
    request: InferenceExecutionRequest,
    transport?: InferenceTransport,
  ): Promise<ManagedInferenceResult>;
  generateStream(
    request: InferenceExecutionRequest,
    transport?: InferenceTransport,
  ): Promise<ReadableStream<Uint8Array>>;
  abort(requestId: string, reason?: ManagedInferenceAbortReason): Promise<void>;
  media(
    request: InferenceMediaRequest,
    body?: ReadableStream<Uint8Array>,
    transport?: InferenceTransport,
  ): Promise<InferenceMediaResult>;
}

type InferenceMediaIdentity = Pick<InferenceExecutionRequest,
  "version" | "installationId" | "logicalRequestId" | "actor" | "workload" | "timeoutMs" | "deadlineAt"
>;

export type InferenceMediaRequest = InferenceMediaIdentity & (
  | { kind: "transcription"; input: {
    provider?: string; apiKey?: string; model: string;
    mimeType?: string; filename?: string; language?: string; prompt?: string;
    mode?: "transcribe" | "translate"; vadFilter?: boolean;
    conditionOnPreviousText?: boolean; maxInputBytes: number;
  } }
  | { kind: "image-read"; input: {
    mimeType?: string; mode?: "caption" | "query" | "ocr" | "point" | "detect";
    prompt?: string; target?: string; captionLength?: "short" | "normal" | "long";
    reasoning?: boolean; responseFormat?: AiImageReadResponseFormat;
    schema?: JsonObject; stream?: boolean; maxTokens?: number; maxObjects?: number;
    temperature?: number; topP?: number; maxInputBytes: number;
  } }
  | { kind: "image-generate"; input: {
    provider: string; apiKey?: string; model: string; prompt: string;
    size?: string; quality?: string; format?: string;
  } }
  | { kind: "speech"; input: {
    provider?: string; apiKey?: string; model: string; text: string;
    voice?: string; language?: string; encoding?: string; container?: string;
    sampleRate?: number; bitRate?: number;
  } }
);

export type InferenceMediaResult =
  | { kind: "transcription"; result: AiTranscriptionCreateResult }
  | { kind: "image-read"; result: AiImageReadResult; body?: ReadableStream<Uint8Array> }
  | { kind: "image-generate"; result: {
    mimeType: string; size: number; provider: string; model: string;
    revisedPrompt?: string; url?: string;
  }; body?: ReadableStream<Uint8Array> }
  | { kind: "speech"; result: {
    mimeType: string; size: number; provider: string; model: string;
    voice?: string; encoding?: string; container?: string;
  }; body: ReadableStream<Uint8Array> };

export type InferenceModelMetadata = {
  provider: string;
  model: string;
  contextWindowTokens: number | null;
};

/** Required public execution service, independent of commercial funding. */
export interface InferenceExecutionService {
  getExecutor(installationId: string): Promise<InferenceExecutor>;
  resolveModel(provider: string, model: string): Promise<InferenceModelMetadata>;
}
