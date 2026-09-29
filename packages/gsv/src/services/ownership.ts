/** Deployment-granted authority; ordinary clients never select an installation or local uid. */
export type BeginInstallationOwnerLinkInput = {
  installationId: string;
  attemptId: string;
  secretHash: string;
};

export interface InstallationOwnershipService {
  beginInstallationOwnerLink(input: BeginInstallationOwnerLinkInput): Promise<{ url: string; expiresAt: number }>;
}

export type AuthorizeRootRecoveryInput = {
  installationId: string;
  attemptId: string;
  purpose: "root-password-reset";
  secretHash: string;
  expiresAt: number;
};

/** Bound only to Accounts. The Kernel consumes the claim and issues local credentials. */
export interface InstallationRecoveryGatewayService {
  authorizeRootRecovery(input: AuthorizeRootRecoveryInput): Promise<{ authorized: true }>;
  confirmOwnerLinkAuthorization(input: { installationId: string; attemptId: string }): Promise<{ authorized: true }>;
}
