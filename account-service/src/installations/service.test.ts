import { env } from "cloudflare:workers";
import type {
  ManagedGatewayProvisioningInterface,
  ManagedInferenceUsageReader,
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
  const inference = {
    getManagedInferenceBudgetUsage: vi.fn<
      ManagedInferenceUsageReader["getManagedInferenceBudgetUsage"]
    >(async () => null),
  } satisfies ManagedInferenceUsageReader;
  return {
    accounts,
    entitlements,
    gateway,
    inference,
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
      inference,
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

  it("projects provider-neutral usage warnings only for the owning account", async () => {
    const result = await fixture();
    const reserved = await result.service.reserve({
      sessionToken: result.token,
      idempotencyKey: crypto.randomUUID(),
      handle: `usage-${crypto.randomUUID().slice(0, 8)}`,
      ownerUsername: "owner",
      agentName: "companion",
    });
    const now = Date.now();
    await result.entitlements.project({
      installationId: reserved.installationId,
      state: "active",
      planKey: "founding-monthly",
      inferenceBudgetMicrounits: 5_000_000,
      inferencePeriodStartsAt: now - 60_000,
      inferencePeriodEndsAt: now + 60_000,
      storageLimitBytes: 10_000_000_000,
      effectiveAt: now - 60_000,
      version: 1,
    });
    await result.service.provision({
      sessionToken: result.token,
      installationId: reserved.installationId,
    });
    result.inference.getManagedInferenceBudgetUsage.mockResolvedValue({
      installationId: reserved.installationId,
      periodStartsAt: now - 60_000,
      periodEndsAt: now + 60_000,
      budgetMicrounits: 5_000_000,
      spentMicrounits: 4_500_000,
      reservedMicrounits: 0,
    });

    await expect(result.service.usage({
      sessionToken: result.token,
      installationId: reserved.installationId,
    })).resolves.toEqual({
      level: "approaching",
      usedPercent: 90,
      periodEndsAt: now + 60_000,
    });
    await expect(result.service.usage({
      sessionToken: "gsvsession_invalid",
      installationId: reserved.installationId,
    })).rejects.toThrow("authentication required");

    result.inference.getManagedInferenceBudgetUsage.mockRejectedValue(
      new Error("inference unavailable"),
    );
    await expect(result.service.usage({
      sessionToken: result.token,
      installationId: reserved.installationId,
    })).resolves.toBeNull();
  });
});
