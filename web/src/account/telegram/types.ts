export type AccountPrincipal = {
  id: string;
  email: string;
  displayName: string;
  state: string;
};

export type AccountSession = {
  authenticated: true;
  principal: AccountPrincipal;
  authMethod: string;
  recentAuthAt: number;
  expiresAt: number;
};

export type AccountSessionResult = AccountSession | { authenticated: false };

export type ManagedTelegramInstallation = {
  installationId: string;
  handle: string;
  canonicalOrigin: string;
  state: "active";
  role: "owner" | "admin" | "member";
};

export type ManagedTelegramClaim = {
  claimId: string;
  actorName?: string;
  actorHandle?: string;
  expiresAt: number;
  linked: boolean;
};

export type ManagedTelegramClaimInspection = {
  claim: ManagedTelegramClaim;
  installations: ManagedTelegramInstallation[];
};

export type ManagedTelegramInspectionResult =
  | { ok: true } & ManagedTelegramClaimInspection
  | { ok: false; reason: "invalid" | "expired" | "used" };

export type ManagedTelegramLink = {
  state: "active";
  claimId: string;
  actorId: string;
  installation: ManagedTelegramInstallation;
};

export type PublicKeyRequestOptionsJSON = {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: Array<{
    id: string;
    type: PublicKeyCredentialType;
    transports?: AuthenticatorTransport[];
  }>;
  userVerification?: UserVerificationRequirement;
  extensions?: AuthenticationExtensionsClientInputs;
};

export type AuthenticationResponseJSON = {
  id: string;
  rawId: string;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
  authenticatorAttachment?: AuthenticatorAttachment;
  clientExtensionResults: AuthenticationExtensionsClientOutputs;
  type: PublicKeyCredentialType;
};
