/** JSON WebAuthn fields used by GSV. The Kernel derives account and relying-party identity. */
export type PasskeyRegistrationOptions = {
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: { type: "public-key"; alg: number }[];
  timeout?: number;
  excludeCredentials?: { id: string; type: "public-key"; transports?: string[] }[];
  authenticatorSelection?: { residentKey?: "discouraged" | "preferred" | "required"; requireResidentKey?: boolean; userVerification?: "discouraged" | "preferred" | "required" };
  attestation?: "none" | "direct" | "indirect" | "enterprise";
};
export type PasskeyAuthenticationOptions = {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: { id: string; type: "public-key"; transports?: string[] }[];
  userVerification?: "discouraged" | "preferred" | "required";
};
type PasskeyResponse = {
  id: string;
  rawId: string;
  type: "public-key";
  authenticatorAttachment?: "platform" | "cross-platform";
  clientExtensionResults: { credProps?: { rk?: boolean } };
};
export type PasskeyRegistrationResponse = PasskeyResponse & {
  response: { clientDataJSON: string; attestationObject: string; transports?: string[]; authenticatorData?: string; publicKeyAlgorithm?: number; publicKey?: string };
};
export type PasskeyAuthenticationResponse = PasskeyResponse & {
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
};
export type AccountPasskey = { id: string; label: string; createdAt: number; lastUsedAt: number | null };
