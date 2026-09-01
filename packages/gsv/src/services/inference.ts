import type {
  AiAssistantMessage,
  AiStopReason,
  AiTextContent,
  AiThinkingContent,
  AiTextMessage,
  AiTextTool,
  AiToolCall,
} from "../protocol/syscalls/ai";

export const GSV_INFERENCE_PROVIDER = "gsv";
export const GSV_INFERENCE_MODEL = "default";
export const GSV_INFERENCE_PRODUCT_MODEL = "gsv/default";
export const GSV_INFERENCE_FEATURE = "ai.provider.gsv";

export type ManagedInferenceActor = {
  localUid: number;
  processId?: string;
  runId?: string;
};

export type ManagedInferencePurpose = "agent" | "mail-intake";

export type ManagedInferenceWorkload =
  | "interactive"
  | "background"
  | "ipc"
  | "compaction"
  | "kernel"
  | "mail-intake";

export type ManagedInferenceRequest = {
  version: 1;
  installationId: string;
  logicalRequestId: string;
  actor: ManagedInferenceActor;
  /** Additive for rolling deployments; omitted callers are reported as unknown. */
  workload?: ManagedInferenceWorkload;
  model: typeof GSV_INFERENCE_PRODUCT_MODEL;
  systemPrompt?: string;
  messages: AiTextMessage[];
  tools?: AiTextTool[];
  maxOutputTokens: number;
  reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs: number;
};

export type ManagedInferenceResult = Omit<
  AiAssistantMessage,
  "diagnostics" | "timestamp"
> & {
  timestamp: number;
};

export type ManagedInferencePartial = Omit<
  ManagedInferenceResult,
  "stopReason"
> & {
  stopReason: AiStopReason | "pending";
};

export type ManagedInferenceStreamEvent =
  | { type: "start"; partial: ManagedInferencePartial }
  | { type: "text_start"; contentIndex: number; content: AiTextContent }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: AiTextContent }
  | {
      type: "thinking_start";
      contentIndex: number;
      content: AiThinkingContent;
    }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | {
      type: "thinking_end";
      contentIndex: number;
      content: AiThinkingContent;
    }
  | { type: "toolcall_start"; contentIndex: number; toolCall: AiToolCall }
  | {
      type: "toolcall_delta";
      contentIndex: number;
      delta: string;
      toolCall: AiToolCall;
    }
  | { type: "toolcall_end"; contentIndex: number; toolCall: AiToolCall }
  | {
      type: "done";
      reason: Extract<AiStopReason, "stop" | "length" | "toolUse">;
      message: ManagedInferenceResult;
    }
  | {
      type: "error";
      reason: Extract<AiStopReason, "aborted" | "error">;
      error: ManagedInferenceResult;
    };

export type ManagedInferenceAbortRequest = {
  version: 1;
  installationId: string;
  logicalRequestId: string;
};

/** Installation-scoped inference capability returned to a Gateway deployment. */
export interface InferenceTarget {
  generate(input: ManagedInferenceRequest): Promise<ManagedInferenceResult>;
  generateStream(
    input: ManagedInferenceRequest,
  ): Promise<ReadableStream<Uint8Array>>;
  abort(logicalRequestId: string): Promise<void>;
}

/** Platform inference contract consumed by a Gateway deployment. */
export interface InferenceService {
  getInstallation(installationId: string): Promise<InferenceTarget>;
}

/** @deprecated Import `InferenceService` from `@humansandmachines/gsv/services/inference`. */
export type ManagedInferenceService = InferenceService;
