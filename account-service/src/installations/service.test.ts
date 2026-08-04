import { env } from "cloudflare:workers";
import type {
  ManagedGatewayProvisioningInterface,
  ProvisionInstallationInput,
} from "@humansandmachines/gsv/protocol";
import { describe, expect, it, vi } from "vitest";
import type { TransactionalMailer } from "../email/mailer";
import { EntitlementStore } from "../entitlements/store";
import type { PasskeyProvider } from "../auth/passkeys";
import { PlatformAuthService } from "../auth/service";
import { PlatformAuthStore } from "../auth/store";
import { sha256Hex } from "../security/tokens";
import { AccountStore } from "../store";
import { ManagedInstallationService } from "./service";

const unusedPasskeys: PasskeyProvider = {
  async registrationOptions() { throw new Error("unused"); },
  async verifyRegistration() { throw new Error("unused"); },
  async authenticationOptions() { throw new Error("unused"); },
  async verifyAuthentication() { throw new Error("unused"); },
};

const unusedMailer: TransactionalMailer = {
  async sendVerificationEmail() {},
  async sendSecurityNotification() {},
};

async function fixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const principalId = `principal_installation_${suffix}`;
  const accounts = new AccountStore(env.ACCOUNT_DB, "gsv.space");
  await accounts.createPrincipal({
    principalId,
    email: `installation-${suffix}@example.com`,
    displayName: "Installation Owner",
    verified: true,
  });
  const token = `gsvsession_${crypto.randomUUID()}${crypto.randomUUID()}`;
  const now = Date.now();
  await env.ACCOUNT_DB.prepare(
    `INSERT INTO sessions (
       id_hash, principal_id, created_at, expires_at, recent_auth_at,
       revoked_at, ip_hash, user_agent, auth_method
     ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'test', 'passkey')`,
  ).bind(
    await sha256Hex(token),
    principalId,
    now,
    now + 30 * 24 * 60 * 60_000,
    now,
  ).run();
  const gateway = {
    provisionInstallation: vi.fn(async (input: ProvisionInstallationInput) => ({
      state: "active" as const,
      installationId: input.installation.installationId,
      principalId: input.owner.principalId,
      localUid: 1000,
      username: input.owner.username,
      provisionVersion: input.provisionVersion,
    })),
  } satisfies ManagedGatewayProvisioningInterface;
  const entitlements = new EntitlementStore(env.ACCOUNT_DB);
  return {
    accounts,
    entitlements,
    gateway,
    principalId,
    token,
    service: new ManagedInstallationService(
      accounts,
      entitlements,
      new PlatformAuthService(
        new PlatformAuthStore(env.ACCOUNT_DB),
        unusedPasskeys,
        unusedMailer,
        { accountOrigin: "https://accounts.gsv.space" },
      ),
      gateway,
    ),
  };
}

describe("managed installation service", () => {
  it("provisions from immutable reservation input after an entitlement grant", async () => {
    const result = await fixture();
    const idempotencyKey = crypto.randomUUID();
    const reserved = await result.service.reserve({
      sessionToken: result.token,
      idempotencyKey,
      handle: `entitled-${crypto.randomUUID().slice(0, 8)}`,
      ownerUsername: "owner",
      agentName: "companion",
      timezone: "Europe/Amsterdam",
    });
    await expect(result.service.reserve({
      sessionToken: result.token,
      idempotencyKey,
      handle: reserved.handle,
      ownerUsername: "owner",
      agentName: "companion",
      timezone: "Europe/Amsterdam",
    })).resolves.toEqual(reserved);
    await result.entitlements.project({
      installationId: reserved.installationId,
      state: "trialing",
      planKey: "founding-trial",
      inferenceBudgetMicrounits: 5_000_000,
      inferencePeriodStartsAt: Date.now(),
      inferencePeriodEndsAt: Date.now() + 30 * 24 * 60 * 60_000,
      storageLimitBytes: 10_000_000_000,
      effectiveAt: Date.now(),
      version: 1,
    });

    const provisioned = await result.service.provision({
      sessionToken: result.token,
      installationId: reserved.installationId,
    });
    expect(provisioned).toMatchObject({
      state: "trialing",
      operationState: "complete",
      entitlement: { state: "trialing", planKey: "founding-trial" },
    });
    expect(result.gateway.provisionInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: {
          principalId: result.principalId,
          username: "owner",
          agentName: "companion",
          timezone: "Europe/Amsterdam",
        },
      }),
    );

    await expect(result.service.provision({
      sessionToken: result.token,
      installationId: reserved.installationId,
    })).resolves.toEqual(provisioned);
    expect(result.gateway.provisionInstallation).toHaveBeenCalledTimes(1);

    await result.entitlements.project({
      installationId: reserved.installationId,
      state: "restricted",
      planKey: "founding-trial",
      inferenceBudgetMicrounits: 0,
      inferencePeriodStartsAt: Date.now(),
      inferencePeriodEndsAt: Date.now() + 30 * 24 * 60 * 60_000,
      storageLimitBytes: 10_000_000_000,
      effectiveAt: Date.now(),
      version: 2,
    });
    await expect(result.service.list(result.token)).resolves.toMatchObject([{
      installationId: reserved.installationId,
      state: "restricted",
      entitlement: { state: "restricted" },
    }]);
  });
});
