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

export const MANAGED_TELEGRAM_ACCOUNT_ID = "managed";

export type LinkManagedTelegramActorInput = {
  operationId: string;
  installationId: string;
  principalId: string;
  localUid: number;
  actorId: string;
  surfaceId: string;
};

export type LinkManagedTelegramActorResult = {
  state: "linked";
  installationId: string;
  actorId: string;
  surfaceId: string;
  localUid: number;
};

export type UnlinkManagedTelegramActorInput = {
  operationId: string;
  installationId: string;
  actorId: string;
  surfaceId: string;
  expectedLocalUid: number;
};

export type UnlinkManagedTelegramActorResult = {
  state: "unlinked";
  installationId: string;
  actorId: string;
  surfaceId: string;
  localUid: number;
  removed: boolean;
};

export interface ManagedGatewayTelegramInterface {
  linkManagedTelegramActor(
    input: LinkManagedTelegramActorInput,
  ): Promise<LinkManagedTelegramActorResult>;
  unlinkManagedTelegramActor(
    input: UnlinkManagedTelegramActorInput,
  ): Promise<UnlinkManagedTelegramActorResult>;
}

export type ManagedTelegramPeerRoute = {
  installationId: string;
  localUid: number;
  canonicalOrigin: string;
  linkedAt: number;
};

export type ManagedTelegramClaim = {
  claimId: string;
  actorId: string;
  surfaceId: string;
  actorName?: string;
  actorHandle?: string;
  expiresAt: number;
  activeRoute?: ManagedTelegramPeerRoute;
};

export type ManagedTelegramClaimInspection =
  | { ok: true; claim: ManagedTelegramClaim }
  | { ok: false; reason: "invalid" | "expired" | "used" };

export type SuspendManagedTelegramClaimInput = {
  operationId: string;
  claimToken: string;
};

export type SuspendManagedTelegramClaimResult = {
  claim: ManagedTelegramClaim;
  previousRoute?: ManagedTelegramPeerRoute;
};

export type ActivateManagedTelegramClaimInput = {
  operationId: string;
  claimToken: string;
  installationId: string;
  localUid: number;
  canonicalOrigin: string;
};

export type ActivateManagedTelegramClaimResult = {
  state: "active";
  claimId: string;
  actorId: string;
  surfaceId: string;
  route: ManagedTelegramPeerRoute;
};

export interface ManagedTelegramControlInterface {
  inspectManagedTelegramClaim(
    claimToken: string,
  ): Promise<ManagedTelegramClaimInspection>;
  suspendManagedTelegramClaim(
    input: SuspendManagedTelegramClaimInput,
  ): Promise<SuspendManagedTelegramClaimResult>;
  activateManagedTelegramClaim(
    input: ActivateManagedTelegramClaimInput,
  ): Promise<ActivateManagedTelegramClaimResult>;
}

export type ManagedTelegramInstallationRouteLifecycleInput = {
  installationId: string;
  operationId: string;
  actorId: string;
  surfaceId: string;
};

export interface ManagedTelegramDataLifecycleInterface {
  suspendManagedTelegramInstallationRoute(
    input: ManagedTelegramInstallationRouteLifecycleInput,
  ): Promise<{ suspended: boolean }>;
  recoverManagedTelegramInstallationRoute(
    input: ManagedTelegramInstallationRouteLifecycleInput,
  ): Promise<{ recovered: boolean }>;
  deleteManagedTelegramInstallationRoute(
    input: ManagedTelegramInstallationRouteLifecycleInput,
  ): Promise<{ deleted: boolean }>;
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

export interface ManagedGatewayLifecycleInterface {
  applyManagedEntitlement(
    input: ManagedEntitlementProjection,
  ): Promise<ManagedEntitlementProjection>;
}

export interface ManagedGatewayDataLifecycleInterface {
  prepareManagedInstallationDeletion(
    input: PrepareManagedInstallationDeletionInput,
  ): Promise<PrepareManagedInstallationDeletionResult>;
  recoverManagedInstallation(
    input: RecoverManagedInstallationInput,
  ): Promise<RecoverManagedInstallationResult>;
  inspectManagedInstallationResources(
    installationId: string,
  ): Promise<ManagedInstallationResourceInventory>;
  deleteManagedInstallationResourceBatch(
    input: DeleteManagedInstallationResourceBatchInput,
  ): Promise<DeleteManagedInstallationResourceBatchResult>;
}

export type PrepareManagedInstallationDeletionInput = {
  installationId: string;
  operationId: string;
  recoverableUntil: number;
};

export type PrepareManagedInstallationDeletionResult = {
  installationId: string;
  operationId: string;
  recoverableUntil: number;
  prepared: boolean;
  suspendedProcesses: number;
};

export type RecoverManagedInstallationInput = {
  installationId: string;
  operationId: string;
};

export type RecoverManagedInstallationResult = {
  installationId: string;
  operationId: string;
  recovered: true;
  resumedProcesses: number;
};

export type ManagedInstallationResourceInventory = {
  version: 1;
  installationId: string;
  processIds: string[];
  repositories: Array<{ owner: string; repo: string }>;
  storage: {
    objectCount: number;
    bytes: number;
  };
};

export type DeleteManagedInstallationResourceBatchInput = {
  installationId: string;
  operationId: string;
  recoverableUntil: number;
  limit?: number;
};

export type ManagedInstallationDeletionStage =
  | "processes"
  | "repositories"
  | "storage"
  | "kernel"
  | "complete";

export type DeleteManagedInstallationResourceBatchResult = {
  installationId: string;
  operationId: string;
  stage: ManagedInstallationDeletionStage;
  deleted: {
    processes: number;
    repositories: number;
    storageObjects: number;
  };
  complete: boolean;
};

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

export interface ManagedInferenceDataLifecycleInterface {
  suspendManagedInferenceInstallation(
    input: PrepareManagedInstallationDeletionInput,
  ): Promise<{ suspended: true }>;
  recoverManagedInferenceInstallation(
    input: RecoverManagedInstallationInput,
  ): Promise<{ recovered: boolean }>;
  deleteManagedInferenceInstallation(
    input: RecoverManagedInstallationInput,
  ): Promise<{ deleted: true }>;
}

export interface ManagedInferenceService {
  run(input: ManagedInferenceRequest): Promise<Response>;
  abort(input: ManagedInferenceAbort): Promise<ManagedInferenceAbortResult>;
}
