import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { TransactionalMailer } from "../email/mailer";
import type { PasskeyProvider } from "./passkeys";
import {
  PlatformAuthStore,
  type IssuedPlatformSession,
  type PlatformSession,
} from "./store";

export type AuthServiceConfig = {
  accountOrigin: string;
  defer?: (task: Promise<void>) => void;
};

const RECENT_AUTH_TTL_MS = 10 * 60 * 1000;

export class PlatformAuthUnavailableError extends Error {}

export class PlatformAuthService {
  constructor(
    private readonly store: PlatformAuthStore,
    private readonly passkeys: PasskeyProvider,
    private readonly mailer: TransactionalMailer,
    private readonly config: AuthServiceConfig,
  ) {}

  async requestSignup(input: {
    email: string;
    displayName: string;
  }): Promise<{ accepted: true }> {
    const principal = await this.store.createOrFindPendingPrincipal(input);
    if (principal.state !== "pending") {
      return { accepted: true };
    }
    const verification = await this.store.issueEmailVerification(principal.id);
    const verificationUrl = new URL("/verify", this.config.accountOrigin);
    verificationUrl.hash = new URLSearchParams({ token: verification.token }).toString();
    try {
      await this.mailer.sendVerificationEmail({
        to: principal.email,
        verificationUrl: verificationUrl.toString(),
        expiresInMinutes: Math.ceil((verification.expiresAt - Date.now()) / 60_000),
      });
    } catch {
      throw new PlatformAuthUnavailableError("verification email delivery unavailable");
    }
    return { accepted: true };
  }

  async verifyEmail(input: {
    token: string;
    ipHash?: string;
    userAgent?: string;
  }): Promise<IssuedPlatformSession> {
    return await this.store.consumeEmailVerification(input);
  }

  async authenticateSession(token: string): Promise<PlatformSession | null> {
    return await this.store.authenticateSession(token);
  }

  async logout(token: string): Promise<boolean> {
    return await this.store.revokeSession(token);
  }

  async recoverWithCode(input: {
    email: string;
    code: string;
    ipHash?: string;
    userAgent?: string;
  }): Promise<IssuedPlatformSession> {
    const session = await this.store.consumeRecoveryCode(input);
    await this.notifySecurity({
      to: session.principal.email,
      kind: "recovery_started",
    });
    return session;
  }

  async beginPasskeyRegistration(sessionToken: string): Promise<{
    challengeId: string;
    options: PublicKeyCredentialCreationOptionsJSON;
  }> {
    const session = await this.requireSession(sessionToken);
    if (
      session.principal.state !== "pending"
      && session.principal.state !== "active"
      && session.principal.state !== "recovery"
    ) {
      throw new Error("credential enrollment principal is required");
    }
    if (
      session.authMethod === "passkey"
      && session.recentAuthAt + RECENT_AUTH_TTL_MS <= Date.now()
    ) {
      throw new Error("recent passkey authentication is required");
    }
    const passkeys = await this.store.listPasskeys(session.principal.id);
    const options = await this.passkeys.registrationOptions({
      principal: session.principal,
      passkeys,
    });
    const challenge = await this.store.createWebAuthnChallenge({
      principalId: session.principal.id,
      sessionHash: session.sessionHash,
      kind: "registration",
      challenge: options.challenge,
    });
    return { challengeId: challenge.id, options };
  }

  async finishPasskeyRegistration(input: {
    sessionToken: string;
    challengeId: string;
    response: RegistrationResponseJSON;
  }): Promise<{ verified: true; recoveryCodes: string[]; expiresAt: number }> {
    const session = await this.requireSession(input.sessionToken);
    const challenge = await this.store.getWebAuthnChallenge(
      input.challengeId,
      "registration",
    );
    if (
      !challenge
      || challenge.principalId !== session.principal.id
      || challenge.sessionHash !== session.sessionHash
    ) {
      throw new Error("passkey registration challenge is invalid or expired");
    }
    const verified = await this.passkeys.verifyRegistration({
      response: input.response,
      expectedChallenge: challenge.challenge,
    });
    const committed = await this.store.commitPasskeyRegistration({
      challenge,
      session,
      credential: verified.credential,
      deviceType: verified.deviceType,
      backedUp: verified.backedUp,
    });
    await this.notifySecurity({
      to: session.principal.email,
      kind: session.principal.state === "recovery"
        ? "recovery_completed"
        : "passkey_registered",
    });
    return {
      verified: true,
      recoveryCodes: committed.recoveryCodes,
      expiresAt: committed.expiresAt,
    };
  }

  async beginPasskeyAuthentication(): Promise<{
    challengeId: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }> {
    const options = await this.passkeys.authenticationOptions();
    const challenge = await this.store.createWebAuthnChallenge({
      kind: "authentication",
      challenge: options.challenge,
    });
    return { challengeId: challenge.id, options };
  }

  async finishPasskeyAuthentication(input: {
    challengeId: string;
    response: AuthenticationResponseJSON;
    ipHash?: string;
    userAgent?: string;
  }): Promise<IssuedPlatformSession> {
    const challenge = await this.store.getWebAuthnChallenge(
      input.challengeId,
      "authentication",
    );
    if (!challenge) {
      throw new Error("passkey authentication challenge is invalid or expired");
    }
    const passkey = await this.store.getPasskey(input.response.id);
    if (!passkey) throw new Error("passkey is unavailable");
    const verified = await this.passkeys.verifyAuthentication({
      response: input.response,
      expectedChallenge: challenge.challenge,
      passkey,
    });
    return await this.store.commitPasskeyAuthentication({
      challenge,
      passkey,
      newCounter: verified.newCounter,
      deviceType: verified.deviceType,
      backedUp: verified.backedUp,
      ipHash: input.ipHash,
      userAgent: input.userAgent,
    });
  }

  async createInstallationHandoff(input: {
    sessionToken: string;
    installationId: string;
  }): Promise<{ token: string; canonicalOrigin: string; expiresAt: number }> {
    const session = await this.requireRecentPasskeySession(input.sessionToken);
    return await this.store.createLoginHandoff({
      principalId: session.principal.id,
      installationId: input.installationId,
    });
  }

  async requireRecentPasskeySession(sessionToken: string): Promise<PlatformSession> {
    const session = await this.requireSession(sessionToken);
    if (session.authMethod !== "passkey") {
      throw new Error("passkey authentication is required");
    }
    if (session.recentAuthAt + RECENT_AUTH_TTL_MS <= Date.now()) {
      throw new Error("recent passkey authentication is required");
    }
    return session;
  }

  private async requireSession(token: string): Promise<PlatformSession> {
    const session = await this.store.authenticateSession(token);
    if (!session) throw new Error("authentication required");
    return session;
  }

  private async notifySecurity(message: {
    to: string;
    kind: "passkey_registered" | "recovery_started" | "recovery_completed";
  }): Promise<void> {
    const delivery = this.mailer.sendSecurityNotification(message).catch(() => undefined);
    if (this.config.defer) {
      this.config.defer(delivery);
      return;
    }
    await delivery;
  }
}
