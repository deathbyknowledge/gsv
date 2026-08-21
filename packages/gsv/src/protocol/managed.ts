import type {
  AiAssistantMessage,
  AiStopReason,
  AiTextContent,
  AiThinkingContent,
  AiTextMessage,
  AiTextTool,
  AiToolCall,
} from "./syscalls/ai";

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

export type ManagedInferenceRequest = {
  version: 1;
  installationId: string;
  logicalRequestId: string;
  actor: ManagedInferenceActor;
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

export interface ManagedInferenceService {
  generate(input: ManagedInferenceRequest): Promise<ManagedInferenceResult>;
  generateStream(
    input: ManagedInferenceRequest,
  ): Promise<ReadableStream<Uint8Array>>;
  abort(input: ManagedInferenceAbortRequest): Promise<void>;
}

export type ManagedMailSummaryRequest = {
  version: 1;
  installationId: string;
  logicalRequestId: string;
  actor: ManagedInferenceActor;
  from: string;
  subject: string;
  text: string;
};

export type ManagedMailSummaryCategory =
  | "personal"
  | "work"
  | "transactional"
  | "newsletter"
  | "spam"
  | "suspicious"
  | "other";

export type ManagedMailSummary = {
  summary: string;
  category: ManagedMailSummaryCategory;
  requiresAttention: boolean;
  confidence: number;
};

export type ManagedMailSummaryRequestStatus =
  | { state: "missing" }
  | { state: "reserved" | "failed" | "aborted" | "abandoned" }
  | { state: "completed"; summary: ManagedMailSummary };

export interface ManagedMailSummaryService {
  summarizeMail(input: ManagedMailSummaryRequest): Promise<ManagedMailSummary>;
  getMailSummaryStatus(
    input: ManagedMailSummaryRequest,
  ): Promise<ManagedMailSummaryRequestStatus>;
}

export type ManagedInferenceUsageOutcome =
  | "completed"
  | "failed"
  | "aborted"
  | "abandoned";

export type ManagedInferenceUsageEvent = {
  version: 1;
  installationId: string;
  logicalRequestId: string;
  actor: ManagedInferenceActor;
  purpose: ManagedInferencePurpose;
  period: string;
  model: typeof GSV_INFERENCE_PRODUCT_MODEL;
  responseModel?: string;
  providerResponseId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reservedNanoUsd: number;
  costNanoUsd: number;
  outcome: ManagedInferenceUsageOutcome;
  stopReason?: AiStopReason;
  startedAt: number;
  completedAt: number;
};

export interface ManagedInferenceUsageService {
  recordManagedInferenceUsage(
    events: ManagedInferenceUsageEvent[],
  ): Promise<void>;
}

export const MANAGED_INFERENCE_QUANTIZATIONS = [
  "fp32",
  "fp16",
  "bf16",
  "fp8",
  "fp6",
  "fp4",
  "int8",
  "int4",
] as const;

export type ManagedInferenceQuantization =
  typeof MANAGED_INFERENCE_QUANTIZATIONS[number];

export type ManagedInferenceRouting = {
  version: 1;
  modelId: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoning: boolean;
  inputNanoUsdPerToken: number;
  outputNanoUsdPerToken: number;
  cacheReadNanoUsdPerToken: number;
  cacheWriteNanoUsdPerToken: number;
  provider: {
    allowFallbacks: boolean;
    requireParameters: boolean;
    dataCollection: "allow" | "deny";
    zdr: boolean;
    order: string[];
    only: string[];
    ignore: string[];
    quantizations: ManagedInferenceQuantization[];
    sort: "default" | "price" | "throughput" | "latency";
    preferredMinThroughput?: number;
    preferredMaxLatency?: number;
  };
  updatedAt: number;
};

export type ManagedInferencePolicy = {
  version: 1;
  installationId: string;
  enabled: boolean;
  monthlyLimitNanoUsd: number;
  routing: ManagedInferenceRouting;
};

export interface ManagedInferencePolicyService {
  getManagedInferencePolicy(
    installationId: string,
  ): Promise<ManagedInferencePolicy>;
}

export type ManagedInstallationState =
  | "reserved"
  | "provisioning"
  | "trialing"
  | "active"
  | "past_due"
  | "restricted"
  | "cancelled"
  | "retained"
  | "deleting"
  | "deleted";

export type ManagedInstallationIdentity = {
  installationId: string;
  handle: string;
  canonicalOrigin: string;
};

export type InstallationDirectoryResult =
  | ({ found: true; state: ManagedInstallationState } & ManagedInstallationIdentity)
  | { found: false };

export interface InstallationDirectoryService {
  resolveHostname(hostname: string): Promise<InstallationDirectoryResult>;
  resolveInstallation(
    installationId: string,
  ): Promise<InstallationDirectoryResult>;
}

export type AuthorizeInstallationOnboardingInput = {
  installationId: string;
  token: string;
};

export type InstallationOnboardingAuthorization =
  | {
      ok: true;
      claimId: string;
      installation: ManagedInstallationIdentity;
    }
  | { ok: false };

export type CompleteInstallationOnboardingInput = {
  claimId: string;
  installationId: string;
};

export type CompleteInstallationOnboardingResult = {
  state: "complete";
  installationId: string;
};

export interface InstallationOnboardingService {
  authorizeInstallationOnboarding(
    input: AuthorizeInstallationOnboardingInput,
  ): Promise<InstallationOnboardingAuthorization>;
  completeInstallationOnboarding(
    input: CompleteInstallationOnboardingInput,
  ): Promise<CompleteInstallationOnboardingResult>;
}

export type UnlinkManagedTelegramIdentityInput = {
  installationId: string;
  operationId: string;
  actorId: string;
  surfaceId: string;
  expectedLocalUid: number;
  expectedGeneration: string;
};

export type UnlinkManagedTelegramIdentityResult = {
  removed: boolean;
};

export interface ManagedTelegramGatewayService {
  unlinkManagedTelegramIdentity(
    input: UnlinkManagedTelegramIdentityInput,
  ): Promise<UnlinkManagedTelegramIdentityResult>;
}
