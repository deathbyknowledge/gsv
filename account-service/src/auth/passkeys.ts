import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type CredentialDeviceType,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import type { PlatformPrincipal, StoredPasskey } from "./store";

export type VerifiedPasskeyRegistration = {
  credential: WebAuthnCredential;
  deviceType: CredentialDeviceType;
  backedUp: boolean;
};

export type VerifiedPasskeyAuthentication = {
  newCounter: number;
  deviceType: CredentialDeviceType;
  backedUp: boolean;
};

export interface PasskeyProvider {
  registrationOptions(input: {
    principal: PlatformPrincipal;
    passkeys: StoredPasskey[];
  }): Promise<PublicKeyCredentialCreationOptionsJSON>;
  verifyRegistration(input: {
    response: RegistrationResponseJSON;
    expectedChallenge: string;
  }): Promise<VerifiedPasskeyRegistration>;
  authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON>;
  verifyAuthentication(input: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    passkey: StoredPasskey;
  }): Promise<VerifiedPasskeyAuthentication>;
}

export class SimpleWebAuthnPasskeyProvider implements PasskeyProvider {
  constructor(
    private readonly rpName: string,
    private readonly rpId: string,
    private readonly origin: string,
  ) {}

  async registrationOptions(input: {
    principal: PlatformPrincipal;
    passkeys: StoredPasskey[];
  }): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpId,
      userID: new TextEncoder().encode(input.principal.id).slice(),
      userName: input.principal.email,
      userDisplayName: input.principal.displayName,
      attestationType: "none",
      excludeCredentials: input.passkeys.map((passkey) => ({
        id: passkey.credentialId,
        transports: passkey.transports,
      })),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      supportedAlgorithmIDs: [-7, -257],
      timeout: 5 * 60 * 1000,
    });
  }

  async verifyRegistration(input: {
    response: RegistrationResponseJSON;
    expectedChallenge: string;
  }): Promise<VerifiedPasskeyRegistration> {
    const verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpId,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -257],
    });
    if (!verification.verified || !verification.registrationInfo) {
      throw new Error("passkey registration could not be verified");
    }
    return {
      credential: verification.registrationInfo.credential,
      deviceType: verification.registrationInfo.credentialDeviceType,
      backedUp: verification.registrationInfo.credentialBackedUp,
    };
  }

  async authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return await generateAuthenticationOptions({
      rpID: this.rpId,
      allowCredentials: [],
      userVerification: "required",
      timeout: 5 * 60 * 1000,
    });
  }

  async verifyAuthentication(input: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    passkey: StoredPasskey;
  }): Promise<VerifiedPasskeyAuthentication> {
    const verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpId,
      requireUserVerification: true,
      credential: {
        id: input.passkey.credentialId,
        publicKey: input.passkey.publicKey.slice(),
        counter: input.passkey.counter,
        transports: input.passkey.transports,
      },
    });
    if (!verification.verified) {
      throw new Error("passkey authentication could not be verified");
    }
    return {
      newCounter: verification.authenticationInfo.newCounter,
      deviceType: verification.authenticationInfo.credentialDeviceType,
      backedUp: verification.authenticationInfo.credentialBackedUp,
    };
  }
}
