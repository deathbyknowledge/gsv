import type {
  AiAssistantMessage,
  AiStopReason,
  AiTextMessage,
  AiTextTool,
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

export type ManagedInferenceGeneration = {
  result: () => Promise<ManagedInferenceResult>;
  abort: () => Promise<void>;
};

export interface ManagedInferenceService {
  generate(input: ManagedInferenceRequest): Promise<ManagedInferenceGeneration>;
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

export interface ManagedMailSummaryService {
  summarizeMail(input: ManagedMailSummaryRequest): Promise<ManagedMailSummary>;
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

export type ManagedInferencePolicy = {
  version: 1;
  installationId: string;
  enabled: boolean;
  monthlyLimitNanoUsd: number;
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
