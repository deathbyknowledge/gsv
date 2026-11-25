/** Deployment-granted authority; ordinary clients never select an installation or local uid. */
export type BeginInstallationOwnerLinkInput = {
  installationId: string;
  attemptId: string;
  secretHash: string;
};

/**
 * An email sign-in attempt the Kernel forwards for its own installation. `secret` is the client's attempt secret;
 * `source` is an opaque per-client rate-limit key.
 */
export type OwnerSignInCodeInput = {
  installationId: string;
  attemptId: string;
  secret: string;
  email: string;
  source: string;
  resend?: boolean;
};

export type OwnerSignInVerifyInput = {
  installationId: string;
  attemptId: string;
  secret: string;
  code: string;
};

export type OwnerSignInVerification =
  | { authorized: AuthorizeRootRecoveryInput }
  | { failed: "invalid" | "expired" | "locked" | "unavailable" };

export interface InstallationOwnershipService {
  beginInstallationOwnerLink(input: BeginInstallationOwnerLinkInput): Promise<{ url: string; expiresAt: number }>;
  /** Mails a sign-in code when `email` is the owner's; the answer is the same either way. */
  sendOwnerSignInCode(input: OwnerSignInCodeInput): Promise<{ accepted: true }>;
  /** Verifies the code and returns the one-time claim the Kernel records and then spends on a session. */
  verifyOwnerSignIn(input: OwnerSignInVerifyInput): Promise<OwnerSignInVerification>;
}

/**
 * The verified owner's one-time claim. The `root-password-reset` wire name predates one-person Ships and email sign-in:
 * the Kernel lets its receiver spend the claim on a new password for either account or on a personal session.
 */
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
