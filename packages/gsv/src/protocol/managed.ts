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
