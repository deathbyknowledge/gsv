import { env } from "cloudflare:workers";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { describe, expect, it } from "vitest";
import { AccountStore } from "../store";
import { EntitlementStore } from "../entitlements/store";
import type {
  SecurityNotification,
  TransactionalMailer,
  VerificationEmail,
} from "../email/mailer";
import type {
  PasskeyProvider,
  VerifiedPasskeyAuthentication,
  VerifiedPasskeyRegistration,
} from "./passkeys";
import { PlatformAuthService } from "./service";
import { PlatformAuthStore, type PlatformPrincipal, type StoredPasskey } from "./store";

class RecordingMailer implements TransactionalMailer {
  readonly messages: VerificationEmail[] = [];
  readonly securityNotifications: SecurityNotification[] = [];

  async sendVerificationEmail(message: VerificationEmail): Promise<void> {
    this.messages.push(message);
  }

  async sendSecurityNotification(message: SecurityNotification): Promise<void> {
    this.securityNotifications.push(message);
  }
}

class DeterministicPasskeys implements PasskeyProvider {
  credentialId = `credential-${crypto.randomUUID()}`;

  rotateCredential(): string {
    this.credentialId = `credential-${crypto.randomUUID()}`;
    return this.credentialId;
  }

  async registrationOptions(input: {
    principal: PlatformPrincipal;
    passkeys: StoredPasskey[];
  }): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return {
      challenge: `registration_${crypto.randomUUID()}`,
      rp: { id: "accounts.gsv.space", name: "GSV" },
      user: {
        id: input.principal.id,
        name: input.principal.email,
        displayName: input.principal.displayName,
      },
      pubKeyCredParams: [{ alg: -7, type: "public-key" }],
      timeout: 300_000,
      attestation: "none",
      excludeCredentials: input.passkeys.map((passkey) => ({
        id: passkey.credentialId,
        type: "public-key",
      })),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      extensions: {},
      hints: [],
    };
  }

  async verifyRegistration(): Promise<VerifiedPasskeyRegistration> {
    return {
      credential: {
        id: this.credentialId,
        publicKey: new Uint8Array([1, 2, 3, 4]),
        counter: 0,
        transports: ["internal"],
      },
      deviceType: "multiDevice",
      backedUp: true,
    };
  }

  async authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return {
      challenge: `authentication_${crypto.randomUUID()}`,
      rpId: "accounts.gsv.space",
      allowCredentials: [],
      timeout: 300_000,
      userVerification: "required",
      extensions: {},
      hints: [],
    };
  }

  async verifyAuthentication(input: {
    passkey: StoredPasskey;
  }): Promise<VerifiedPasskeyAuthentication> {
    return {
      newCounter: input.passkey.counter + 1,
      deviceType: input.passkey.deviceType,
      backedUp: input.passkey.backedUp,
    };
  }
}

function fixture(): {
  store: PlatformAuthStore;
  service: PlatformAuthService;
  mailer: RecordingMailer;
  passkeys: DeterministicPasskeys;
} {
  const store = new PlatformAuthStore(env.ACCOUNT_DB);
  const mailer = new RecordingMailer();
  const passkeys = new DeterministicPasskeys();
  return {
    store,
    mailer,
    passkeys,
    service: new PlatformAuthService(store, passkeys, mailer, {
      accountOrigin: "https://accounts.gsv.space",
    }),
  };
}

async function verifiedSession(service: PlatformAuthService, mailer: RecordingMailer) {
  const suffix = crypto.randomUUID();
  await service.requestSignup({
    email: `${suffix}@example.com`,
    displayName: `Person ${suffix}`,
  });
  const message = mailer.messages.at(-1);
  if (!message) throw new Error("Verification email was not recorded");
  const token = new URLSearchParams(new URL(message.verificationUrl).hash.slice(1)).get("token");
  if (!token) throw new Error("Verification email did not contain a token");
  return {
    verificationToken: token,
    session: await service.verifyEmail({ token, userAgent: "test-agent" }),
  };
}

async function registeredPasskeySession() {
  const result = fixture();
  const verified = await verifiedSession(result.service, result.mailer);
  const registration = await result.service.beginPasskeyRegistration(verified.session.token);
  const registrationResult = await result.service.finishPasskeyRegistration({
    sessionToken: verified.session.token,
    challengeId: registration.challengeId,
    response: registrationResponse(result.passkeys.credentialId),
  });
  return { ...result, ...verified, registration, registrationResult };
}

describe("platform authentication", () => {
  it("verifies email once without storing the raw verification token", async () => {
    const { service, store, mailer } = fixture();
    const verified = await verifiedSession(service, mailer);

    expect(verified.session).toMatchObject({
      authMethod: "email_verification",
      principal: { state: "pending", emailVerifiedAt: expect.any(Number) },
    });
    expect(verified.session.expiresAt).toBeGreaterThan(Date.now() + 29 * 60_000);
    expect(verified.session.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
    await expect(store.authenticateSession(verified.session.token)).resolves.toMatchObject({
      principal: { id: verified.session.principal.id },
    });
    await expect(service.verifyEmail({ token: verified.verificationToken }))
      .rejects.toThrow("invalid or expired");

    const row = await env.ACCOUNT_DB.prepare(
      `SELECT token_hash, payload_json
       FROM verification_and_recovery_tokens
       WHERE principal_id = ? AND purpose = 'verify_email'`,
    ).bind(verified.session.principal.id).first<{
      token_hash: string;
      payload_json: string | null;
    }>();
    expect(row?.token_hash).not.toContain(verified.verificationToken);
    expect(row?.payload_json).toBeNull();
  });

  it("does not reveal an existing active account through signup delivery", async () => {
    const { service, mailer, session } = await registeredPasskeySession();
    const deliveries = mailer.messages.length;

    await expect(service.requestSignup({
      email: session.principal.email,
      displayName: "Different display name",
    })).resolves.toEqual({ accepted: true });
    expect(mailer.messages).toHaveLength(deliveries);
  });

  it("lets an email-verified pending account resume primary credential enrollment", async () => {
    const { service, mailer } = fixture();
    const verified = await verifiedSession(service, mailer);

    await expect(service.requestSignup({
      email: verified.session.principal.email,
      displayName: verified.session.principal.displayName,
    })).resolves.toEqual({ accepted: true });
    expect(mailer.messages).toHaveLength(2);
    const token = new URLSearchParams(
      new URL(mailer.messages[1]?.verificationUrl ?? "").hash.slice(1),
    ).get("token");
    if (!token) throw new Error("Resumed verification email did not contain a token");
    await expect(service.verifyEmail({ token })).resolves.toMatchObject({
      principal: { id: verified.session.principal.id, state: "pending" },
      authMethod: "email_verification",
    });
  });

  it("registers a passkey once and upgrades the platform session", async () => {
    const {
      service,
      store,
      passkeys,
      session,
      registration,
      registrationResult,
      mailer,
    } = await registeredPasskeySession();

    await expect(store.authenticateSession(session.token)).resolves.toMatchObject({
      authMethod: "passkey",
      principal: { state: "active" },
    });
    await expect(store.listPasskeys(session.principal.id)).resolves.toMatchObject([{
      credentialId: passkeys.credentialId,
      counter: 0,
      backedUp: true,
    }]);
    expect(registrationResult.recoveryCodes).toHaveLength(10);
    expect(registrationResult.expiresAt).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60_000);
    expect(new Set(registrationResult.recoveryCodes).size).toBe(10);
    for (const code of registrationResult.recoveryCodes) {
      expect(code).toMatch(/^(?:[23456789A-HJ-NP-Z]{4}-){5}[23456789A-HJ-NP-Z]{4}$/);
    }
    const storedRecoveryCodes = await env.ACCOUNT_DB.prepare(
      `SELECT lookup_key, secret_hash
       FROM credentials
       WHERE principal_id = ? AND kind = 'recovery_code'`,
    ).bind(session.principal.id).all<{
      lookup_key: string;
      secret_hash: string;
    }>();
    expect(storedRecoveryCodes.results).toHaveLength(10);
    expect(mailer.securityNotifications).toEqual([{
      to: session.principal.email,
      kind: "passkey_registered",
    }]);
    for (const code of registrationResult.recoveryCodes) {
      const normalized = code.replace(/-/g, "");
      expect(JSON.stringify(storedRecoveryCodes.results)).not.toContain(normalized);
    }
    await expect(service.finishPasskeyRegistration({
      sessionToken: session.token,
      challengeId: registration.challengeId,
      response: registrationResponse(passkeys.credentialId),
    })).rejects.toThrow("invalid or expired");
  });

  it("recovers with one code, revokes every old credential, and rotates the code set", async () => {
    const {
      service,
      store,
      passkeys,
      session,
      registrationResult,
      mailer,
    } = await registeredPasskeySession();
    const oldCredentialId = passkeys.credentialId;
    const [consumedCode, anotherOldCode] = registrationResult.recoveryCodes;
    if (!consumedCode || !anotherOldCode) throw new Error("recovery codes were not issued");

    const recovered = await service.recoverWithCode({
      email: session.principal.email,
      code: consumedCode,
      userAgent: "recovery-test",
    });
    expect(recovered).toMatchObject({
      authMethod: "recovery",
      principal: { id: session.principal.id, state: "recovery" },
    });
    expect(recovered.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
    await expect(store.authenticateSession(session.token)).resolves.toBeNull();
    await expect(store.getPasskey(oldCredentialId)).resolves.toBeNull();
    await expect(service.recoverWithCode({
      email: session.principal.email,
      code: consumedCode,
    })).rejects.toThrow("invalid");
    await expect(service.recoverWithCode({
      email: session.principal.email,
      code: anotherOldCode,
    })).rejects.toThrow("invalid");

    const replacementCredentialId = passkeys.rotateCredential();
    const replacementOptions = await service.beginPasskeyRegistration(recovered.token);
    const replacement = await service.finishPasskeyRegistration({
      sessionToken: recovered.token,
      challengeId: replacementOptions.challengeId,
      response: registrationResponse(replacementCredentialId),
    });

    expect(replacement.recoveryCodes).toHaveLength(10);
    expect(replacement.recoveryCodes).not.toEqual(registrationResult.recoveryCodes);
    expect(mailer.securityNotifications.slice(-2)).toEqual([
      { to: session.principal.email, kind: "recovery_started" },
      { to: session.principal.email, kind: "recovery_completed" },
    ]);
    await expect(store.authenticateSession(recovered.token)).resolves.toMatchObject({
      authMethod: "passkey",
      principal: { state: "active" },
    });
    await expect(store.listPasskeys(session.principal.id)).resolves.toMatchObject([{
      credentialId: replacementCredentialId,
    }]);
  });

  it("authenticates a discoverable passkey and advances its counter once", async () => {
    const { service, store, passkeys, session } = await registeredPasskeySession();
    const authentication = await service.beginPasskeyAuthentication();
    const response = authenticationResponse(passkeys.credentialId);
    const authenticated = await service.finishPasskeyAuthentication({
      challengeId: authentication.challengeId,
      response,
    });

    expect(authenticated.authMethod).toBe("passkey");
    await expect(store.authenticateSession(authenticated.token)).resolves.toMatchObject({
      principal: { id: session.principal.id },
    });
    await expect(store.getPasskey(passkeys.credentialId)).resolves.toMatchObject({ counter: 1 });
    await expect(service.finishPasskeyAuthentication({
      challengeId: authentication.challengeId,
      response,
    })).rejects.toThrow("invalid or expired");
  });

  it("requires a recent passkey ceremony for sensitive credential and handoff changes", async () => {
    const { service, session } = await registeredPasskeySession();
    await env.ACCOUNT_DB.prepare(
      "UPDATE sessions SET recent_auth_at = ? WHERE id_hash = ?",
    ).bind(Date.now() - 11 * 60_000, session.sessionHash).run();

    await expect(service.beginPasskeyRegistration(session.token))
      .rejects.toThrow("recent passkey authentication is required");
    await expect(service.createInstallationHandoff({
      sessionToken: session.token,
      installationId: `inst_${crypto.randomUUID()}`,
    })).rejects.toThrow("recent passkey authentication is required");
  });

  it("binds a one-time installation handoff to hostname and membership", async () => {
    const { service, store, session } = await registeredPasskeySession();
    const accountStore = new AccountStore(env.ACCOUNT_DB, "gsv.space");
    const operationId = `operation_${crypto.randomUUID()}`;
    const reserved = await accountStore.reserveInstallation({
      principalId: session.principal.id,
      operationId,
      handle: `h-${crypto.randomUUID().slice(0, 12)}`,
    });
    await new EntitlementStore(env.ACCOUNT_DB).project({
      installationId: reserved.installationId,
      state: "active",
      planKey: "test",
      inferenceBudgetMicrounits: 5_000_000,
      inferencePeriodStartsAt: Date.now(),
      inferencePeriodEndsAt: Date.now() + 30 * 24 * 60 * 60_000,
      storageLimitBytes: 10_000_000,
      effectiveAt: Date.now(),
      version: 1,
    });
    await accountStore.beginProvisioning(operationId, session.principal.id);
    await accountStore.completeProvisioning(operationId, session.principal.id, "owner", {
      state: "active",
      installationId: reserved.installationId,
      principalId: session.principal.id,
      localUid: 1000,
      username: "owner",
      provisionVersion: 1,
    });

    const handoff = await service.createInstallationHandoff({
      sessionToken: session.token,
      installationId: reserved.installationId,
    });
    await expect(store.consumeLoginHandoff(
      handoff.token,
      "wrong.gsv.space",
    )).resolves.toEqual({ ok: false });
    await expect(store.consumeLoginHandoff(
      handoff.token,
      `${reserved.handle}.gsv.space`,
    )).resolves.toEqual({
      ok: true,
      installationId: reserved.installationId,
      principalId: session.principal.id,
      localUid: 1000,
    });
    await expect(store.consumeLoginHandoff(
      handoff.token,
      `${reserved.handle}.gsv.space`,
    )).resolves.toEqual({ ok: false });
    const audit = await env.ACCOUNT_DB.prepare(
      `SELECT COUNT(*) AS count
       FROM audit_events
       WHERE principal_id = ? AND installation_id = ?
         AND action = 'installation.login_handoff_consumed'
         AND outcome = 'succeeded'`,
    ).bind(session.principal.id, reserved.installationId).first<{ count: number }>();
    expect(audit?.count).toBe(1);
  });
});

function registrationResponse(credentialId: string): RegistrationResponseJSON {
  return {
    id: credentialId,
    rawId: credentialId,
    response: {
      clientDataJSON: "e30",
      attestationObject: "e30",
      transports: ["internal"],
    },
    clientExtensionResults: {},
    type: "public-key",
  };
}

function authenticationResponse(credentialId: string): AuthenticationResponseJSON {
  return {
    id: credentialId,
    rawId: credentialId,
    response: {
      clientDataJSON: "e30",
      authenticatorData: "e30",
      signature: "e30",
      userHandle: "e30",
    },
    clientExtensionResults: {},
    type: "public-key",
  };
}
