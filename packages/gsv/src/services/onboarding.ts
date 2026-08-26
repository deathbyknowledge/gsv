import type { ManagedInstallationIdentity } from "./directory";

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

/** Authorizes and completes a one-time installation setup claim. */
export interface InstallationOnboardingService {
  authorizeInstallationOnboarding(
    input: AuthorizeInstallationOnboardingInput,
  ): Promise<InstallationOnboardingAuthorization>;
  completeInstallationOnboarding(
    input: CompleteInstallationOnboardingInput,
  ): Promise<CompleteInstallationOnboardingResult>;
}
