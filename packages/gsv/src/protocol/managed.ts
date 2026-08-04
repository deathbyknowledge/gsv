import type {
  AiAssistantMessage,
  AiTextMessage,
  AiTextTool,
} from "./syscalls/ai";

export const MANAGED_INFERENCE_PROVIDER = "gsv";
export const MANAGED_INFERENCE_MODEL = "default";
export const MANAGED_INFERENCE_PRODUCT_MODEL = "gsv/default";

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

export type LoginHandoffVerificationResult =
  | {
      ok: true;
      installationId: string;
      principalId: string;
      localUid: number;
    }
  | { ok: false };

export interface InstallationDirectoryService {
  resolveHostname(hostname: string): Promise<InstallationDirectoryResult>;
  verifyLoginHandoff(
    token: string,
    hostname: string,
  ): Promise<LoginHandoffVerificationResult>;
}

export type ProvisionInstallationInput = {
  operationId: string;
  installation: ManagedInstallationIdentity;
  owner: {
    principalId: string;
    username: string;
    agentName?: string;
    timezone?: string;
  };
  provisionVersion: number;
};

export type ProvisionInstallationResult = {
  state: "active";
  installationId: string;
  principalId: string;
  localUid: number;
  username: string;
  provisionVersion: number;
};

export interface ManagedGatewayProvisioningInterface {
  provisionInstallation(
    input: ProvisionInstallationInput,
  ): Promise<ProvisionInstallationResult>;
}

export type ManagedEntitlementState =
  | "trialing"
  | "active"
  | "past_due"
  | "restricted"
  | "cancelled"
  | "retained";

export type ManagedEntitlementProjection = {
  installationId: string;
  state: ManagedEntitlementState;
  planKey: string;
  inferenceBudgetMicrounits: number;
  inferencePeriodStartsAt: number;
  inferencePeriodEndsAt: number;
  storageLimitBytes: number;
  effectiveAt: number;
  version: number;
};

export interface ManagedEntitlementService {
  projectEntitlement(
    input: ManagedEntitlementProjection,
  ): Promise<ManagedEntitlementProjection>;
}

export interface ManagedEntitlementReader {
  getEntitlement(
    installationId: string,
  ): Promise<ManagedEntitlementProjection | null>;
}

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
  model: typeof MANAGED_INFERENCE_PRODUCT_MODEL;
  capability: "text";
  systemPrompt?: string;
  messages: AiTextMessage[];
  tools?: AiTextTool[];
  maxOutputTokens: number;
  reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs: number;
};

export type ManagedInferenceAbort = Pick<
  ManagedInferenceRequest,
  "installationId" | "logicalRequestId"
>;

export type ManagedInferenceAbortResult = {
  aborted: boolean;
};

export type ManagedInferencePartialMessage = Omit<AiAssistantMessage, "stopReason"> & {
  stopReason: AiAssistantMessage["stopReason"] | "pending";
};

export type ManagedInferenceStreamEvent =
  | { type: "start"; partial: ManagedInferencePartialMessage }
  | { type: "text_start"; contentIndex: number; partial: ManagedInferencePartialMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: ManagedInferencePartialMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: ManagedInferencePartialMessage }
  | { type: "thinking_start"; contentIndex: number; partial: ManagedInferencePartialMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: ManagedInferencePartialMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: ManagedInferencePartialMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: ManagedInferencePartialMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: ManagedInferencePartialMessage }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: Extract<AiAssistantMessage["content"][number], { type: "toolCall" }>;
      partial: ManagedInferencePartialMessage;
    }
  | {
      type: "done";
      reason: "stop" | "length" | "toolUse";
      message: AiAssistantMessage;
    }
  | {
      type: "error";
      reason: "aborted" | "error";
      error: AiAssistantMessage;
    };

export interface ManagedInferenceService {
  run(input: ManagedInferenceRequest): Promise<Response>;
  abort(input: ManagedInferenceAbort): Promise<ManagedInferenceAbortResult>;
}
