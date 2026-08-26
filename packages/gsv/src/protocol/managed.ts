import type { AiStopReason } from "./syscalls/ai";
import type {
  ManagedInferenceActor,
  ManagedInferencePurpose,
} from "../services/inference";
import { GSV_INFERENCE_PRODUCT_MODEL } from "../services/inference";

export {
  GSV_INFERENCE_FEATURE,
  GSV_INFERENCE_MODEL,
  GSV_INFERENCE_PRODUCT_MODEL,
  GSV_INFERENCE_PROVIDER,
} from "../services/inference";
export type {
  InferenceService as ManagedInferenceService,
  ManagedInferenceAbortRequest,
  ManagedInferenceActor,
  ManagedInferencePartial,
  ManagedInferencePurpose,
  ManagedInferenceRequest,
  ManagedInferenceResult,
  ManagedInferenceStreamEvent,
} from "../services/inference";

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

export type {
  InstallationDirectoryResult,
  InstallationDirectoryService,
  ManagedInstallationIdentity,
  ManagedInstallationState,
} from "../services/directory";
export type {
  AuthorizeInstallationOnboardingInput,
  CompleteInstallationOnboardingInput,
  CompleteInstallationOnboardingResult,
  InstallationOnboardingAuthorization,
  InstallationOnboardingService,
} from "../services/onboarding";

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
