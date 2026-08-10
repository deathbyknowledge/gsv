import type {
  AiAssistantMessage,
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
