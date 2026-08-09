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
