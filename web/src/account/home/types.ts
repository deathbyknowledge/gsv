import type {
  ManagedEntitlementState,
  ManagedInstallationState,
} from "@humansandmachines/gsv/protocol";

export type ManagedInstallation = {
  installationId: string;
  handle: string;
  canonicalOrigin: string;
  state: ManagedInstallationState;
  operationState: "reserved" | "provisioning" | "complete" | "failed";
  ownerUsername: string | null;
  agentName: string | null;
  timezone: string | null;
  reservationExpiresAt: number | null;
  entitlement: null | {
    state: ManagedEntitlementState;
    planKey: string;
    effectiveAt: number;
  };
};

export type InstallationDeletion = {
  operationId: string;
  installationId: string;
  requestKind: "user" | "retention";
  state: "preparing" | "recoverable" | "deleting" | "complete" | "recovered";
  recoverableUntil: number;
  createdAt: number;
  completedAt: number | null;
};

export type InstallationUsage = {
  level: "normal" | "approaching" | "critical" | "exhausted";
  usedPercent: number;
  periodEndsAt: number;
};

export type PublicKeyCreationOptionsJSON = {
  challenge: string;
  rp: {
    id?: string;
    name: string;
  };
  user: {
    id: string;
    name: string;
    displayName: string;
  };
  pubKeyCredParams: PublicKeyCredentialParameters[];
  timeout?: number;
  excludeCredentials?: Array<{
    id: string;
    type: PublicKeyCredentialType;
    transports?: AuthenticatorTransport[];
  }>;
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
  extensions?: AuthenticationExtensionsClientInputs;
};

export type RegistrationResponseJSON = {
  id: string;
  rawId: string;
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: AuthenticatorTransport[];
  };
  authenticatorAttachment?: AuthenticatorAttachment;
  clientExtensionResults: AuthenticationExtensionsClientOutputs;
  type: PublicKeyCredentialType;
};

export type PasskeyRegistrationChallenge = {
  challengeId: string;
  options: PublicKeyCreationOptionsJSON;
};

export type PasskeyRegistrationResult = {
  recoveryCodes: string[];
  expiresAt: number;
};

export type InstallationHandoff = {
  action: string;
  token: string;
  expiresAt: number;
};

export type InstallationExport = {
  response: Response;
  filename: string;
};
