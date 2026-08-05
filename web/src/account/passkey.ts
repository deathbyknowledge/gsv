import type {
  AuthenticationResponseJSON,
  PublicKeyRequestOptionsJSON,
} from "./telegram/types";
import type {
  PublicKeyCreationOptionsJSON,
  RegistrationResponseJSON,
} from "./home/types";

export async function createPasskey(
  options: PublicKeyCreationOptionsJSON,
  credentials: CredentialsContainer = navigator.credentials,
): Promise<RegistrationResponseJSON> {
  if (!credentials?.create) {
    throw new Error("Passkeys are not supported by this browser");
  }
  const credential = await credentials.create({
    publicKey: creationOptions(options),
  });
  if (!credential || credential.type !== "public-key") {
    throw new Error("Passkey creation was cancelled");
  }
  return registrationResponse(credential as PublicKeyCredential);
}

export function creationOptions(
  options: PublicKeyCreationOptionsJSON,
): PublicKeyCredentialCreationOptions {
  return {
    challenge: base64UrlToBuffer(options.challenge),
    rp: options.rp,
    user: {
      ...options.user,
      id: base64UrlToBuffer(options.user.id),
    },
    pubKeyCredParams: options.pubKeyCredParams,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.excludeCredentials
      ? {
          excludeCredentials: options.excludeCredentials.map((credential) => ({
            ...credential,
            id: base64UrlToBuffer(credential.id),
          })),
        }
      : {}),
    ...(options.authenticatorSelection
      ? { authenticatorSelection: options.authenticatorSelection }
      : {}),
    ...(options.attestation ? { attestation: options.attestation } : {}),
    ...(options.extensions ? { extensions: options.extensions } : {}),
  };
}

export function registrationResponse(
  credential: PublicKeyCredential,
): RegistrationResponseJSON {
  const response = credential.response as AuthenticatorAttestationResponse;
  if (
    !(response.clientDataJSON instanceof ArrayBuffer)
    || !(response.attestationObject instanceof ArrayBuffer)
  ) {
    throw new Error("Passkey response is invalid");
  }
  const attachment = credential.authenticatorAttachment === "platform"
      || credential.authenticatorAttachment === "cross-platform"
    ? credential.authenticatorAttachment
    : undefined;
  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      attestationObject: bufferToBase64Url(response.attestationObject),
      ...(typeof response.getTransports === "function"
        ? { transports: response.getTransports() as AuthenticatorTransport[] }
        : {}),
    },
    ...(attachment ? { authenticatorAttachment: attachment } : {}),
    clientExtensionResults: credential.getClientExtensionResults(),
    type: "public-key",
  };
}

export async function getPasskeyAssertion(
  options: PublicKeyRequestOptionsJSON,
  credentials: CredentialsContainer = navigator.credentials,
): Promise<AuthenticationResponseJSON> {
  if (!credentials?.get) {
    throw new Error("Passkeys are not supported by this browser");
  }
  const credential = await credentials.get({
    publicKey: requestOptions(options),
  });
  if (!credential || credential.type !== "public-key") {
    throw new Error("Passkey authentication was cancelled");
  }
  return authenticationResponse(credential as PublicKeyCredential);
}

export function requestOptions(
  options: PublicKeyRequestOptionsJSON,
): PublicKeyCredentialRequestOptions {
  return {
    challenge: base64UrlToBuffer(options.challenge),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.rpId ? { rpId: options.rpId } : {}),
    ...(options.userVerification
      ? { userVerification: options.userVerification }
      : {}),
    ...(options.extensions ? { extensions: options.extensions } : {}),
    ...(options.allowCredentials
      ? {
          allowCredentials: options.allowCredentials.map((credential) => ({
            id: base64UrlToBuffer(credential.id),
            type: credential.type,
            ...(credential.transports
              ? { transports: credential.transports }
              : {}),
          })),
        }
      : {}),
  };
}

export function authenticationResponse(
  credential: PublicKeyCredential,
): AuthenticationResponseJSON {
  const response = credential.response as AuthenticatorAssertionResponse;
  if (
    !(response.clientDataJSON instanceof ArrayBuffer)
    || !(response.authenticatorData instanceof ArrayBuffer)
    || !(response.signature instanceof ArrayBuffer)
  ) {
    throw new Error("Passkey response is invalid");
  }
  const attachment = credential.authenticatorAttachment === "platform"
      || credential.authenticatorAttachment === "cross-platform"
    ? credential.authenticatorAttachment
    : undefined;
  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      authenticatorData: bufferToBase64Url(response.authenticatorData),
      signature: bufferToBase64Url(response.signature),
      ...(response.userHandle
        ? { userHandle: bufferToBase64Url(response.userHandle) }
        : {}),
    },
    ...(attachment ? { authenticatorAttachment: attachment } : {}),
    clientExtensionResults: credential.getClientExtensionResults(),
    type: "public-key",
  };
}

export function base64UrlToBuffer(value: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Passkey challenge is invalid");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const decoded = atob(padded);
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  return bytes.buffer;
}

export function bufferToBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
