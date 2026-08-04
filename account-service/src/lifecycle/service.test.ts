import { env } from "cloudflare:workers";
import type {
  DeleteManagedInstallationResourceBatchResult,
  ManagedGatewayDataLifecycleInterface,
  ManagedInferenceDataLifecycleInterface,
  ManagedTelegramDataLifecycleInterface,
} from "@humansandmachines/gsv/protocol";
import { describe, expect, it, vi } from "vitest";
import type { PasskeyProvider } from "../auth/passkeys";
import { PlatformAuthService } from "../auth/service";
import { PlatformAuthStore } from "../auth/store";
import type { TransactionalMailer } from "../email/mailer";
import { EntitlementStore } from "../entitlements/store";
import { sha256Hex } from "../security/tokens";
import { AccountStore } from "../store";
import { ManagedTelegramLinkOperationStore } from "../telegram/store";
import {
  InstallationLifecycleService,
  InstallationLifecycleUnavailableError,
} from "./service";
import { InstallationLifecycleStore } from "./store";

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

type ServiceFixture = Awaited<ReturnType<typeof serviceFixture>>;

async function serviceFixture(options: {
  prepareFails?: boolean;
  recoverFails?: boolean;
} = {}) {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const principalId = `principal_service_${suffix}`;
  const handle = `service-${suffix}`;
  const provisionOperationId = `provision_service_${suffix}`;
  const accounts = new AccountStore(env.ACCOUNT_DB, "gsv.space");
  await accounts.createPrincipal({
    principalId,
    email: `service-${suffix}@example.com`,
    displayName: "Lifecycle Service",
    verified: true,
  });
  const reserved = await accounts.reserveInstallation({
    principalId,
    operationId: provisionOperationId,
    handle,
    ownerUsername: "owner",
  });
  const now = Date.now();
  await new EntitlementStore(env.ACCOUNT_DB).project({
    installationId: reserved.installationId,
    state: "active",
    planKey: "lifecycle-service-test",
    inferenceBudgetMicrounits: 5_000_000,
    inferencePeriodStartsAt: now,
    inferencePeriodEndsAt: now + 30 * 24 * 60 * 60_000,
    storageLimitBytes: 10_000_000,
    effectiveAt: now,
    version: 1,
  });
  await accounts.beginProvisioning(provisionOperationId, principalId);
  await accounts.completeProvisioning(provisionOperationId, principalId, "owner", {
    state: "active",
    installationId: reserved.installationId,
    principalId,
    localUid: 1000,
    username: "owner",
    provisionVersion: reserved.provisionVersion,
  });
  const sessionToken = `gsvsession_${crypto.randomUUID()}${crypto.randomUUID()}`;
  await env.ACCOUNT_DB.prepare(
    `INSERT INTO sessions (
       id_hash, principal_id, created_at, expires_at, recent_auth_at,
       revoked_at, ip_hash, user_agent, auth_method
     ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'test', 'passkey')`,
  ).bind(
    await sha256Hex(sessionToken),
    principalId,
    now,
    now + 30 * 24 * 60 * 60_000,
    now,
  ).run();
  await env.ACCOUNT_DB.prepare(
    `INSERT INTO managed_telegram_link_operations (
       operation_id, claim_id, claim_token_hash, principal_id,
       actor_id, surface_id, target_installation_id, target_local_uid,
       target_canonical_origin, previous_installation_id, previous_local_uid,
       previous_canonical_origin, state, attempt, last_error_code,
       created_at, updated_at, completed_at
     ) VALUES (?, ?, ?, ?, '424242', '424242', ?, 1000, ?, NULL, NULL,
               NULL, 'complete', 1, NULL, ?, ?, ?)`,
  ).bind(
    `telegram_${suffix}`,
    `claim_${suffix}`,
    suffix.repeat(6).slice(0, 64),
    principalId,
    reserved.installationId,
    reserved.canonicalOrigin,
    now,
    now,
    now,
  ).run();

  const gateway = {
    prepareManagedInstallationDeletion: vi.fn(async (input) => {
      if (options.prepareFails) throw new Error("Gateway unavailable");
      return {
        ...input,
        prepared: true,
        suspendedProcesses: 1,
      };
    }),
    recoverManagedInstallation: vi.fn(async (input) => {
      if (options.recoverFails) throw new Error("Gateway recovery unavailable");
      return {
        ...input,
        recovered: true as const,
        resumedProcesses: 1,
      };
    }),
    inspectManagedInstallationResources: vi.fn(async (installationId) => ({
      version: 1 as const,
      installationId,
      processIds: [],
      repositories: [],
      storage: { objectCount: 0, bytes: 0 },
    })),
    deleteManagedInstallationResourceBatch: vi.fn(async (
      input,
    ): Promise<DeleteManagedInstallationResourceBatchResult> => ({
      installationId: input.installationId,
      operationId: input.operationId,
      stage: "complete",
      deleted: { processes: 0, repositories: 0, storageObjects: 0 },
      complete: true,
    })),
  } satisfies ManagedGatewayDataLifecycleInterface;
  const inference = {
    suspendManagedInferenceInstallation: vi.fn(async () => ({
      suspended: true as const,
    })),
    recoverManagedInferenceInstallation: vi.fn(async () => ({ recovered: true })),
    deleteManagedInferenceInstallation: vi.fn(async () => ({
      deleted: true as const,
    })),
  } satisfies ManagedInferenceDataLifecycleInterface;
  const telegram = {
    suspendManagedTelegramInstallationRoute: vi.fn(async () => ({ suspended: true })),
    recoverManagedTelegramInstallationRoute: vi.fn(async () => ({ recovered: true })),
    deleteManagedTelegramInstallationRoute: vi.fn(async () => ({ deleted: true })),
  } satisfies ManagedTelegramDataLifecycleInterface;
  const lifecycle = new InstallationLifecycleStore(env.ACCOUNT_DB);
  const service = new InstallationLifecycleService(
    lifecycle,
    new PlatformAuthService(
      new PlatformAuthStore(env.ACCOUNT_DB),
      unusedPasskeys,
      unusedMailer,
      { accountOrigin: "https://accounts.gsv.space" },
    ),
    gateway,
    inference,
    telegram,
    new ManagedTelegramLinkOperationStore(env.ACCOUNT_DB),
    1_000,
  );
  return {
    service,
    lifecycle,
    gateway,
    inference,
    telegram,
    principalId,
    installationId: reserved.installationId,
    handle,
    sessionToken,
    now,
  };
}

function deletionRequest(fixture: ServiceFixture, idempotencyKey = crypto.randomUUID()) {
  return {
    sessionToken: fixture.sessionToken,
    installationId: fixture.installationId,
    confirmedHandle: fixture.handle,
    idempotencyKey,
    now: fixture.now,
  };
}

describe("installation lifecycle service", () => {
  it("prepares idempotently and recovers every resource owner before restoring routing", async () => {
    const fixture = await serviceFixture();
    const idempotencyKey = crypto.randomUUID();
    const requested = await fixture.service.requestUserDeletion(
      deletionRequest(fixture, idempotencyKey),
    );
    expect(requested).toMatchObject({
      installationId: fixture.installationId,
      requestKind: "user",
      state: "recoverable",
    });
    await expect(fixture.service.requestUserDeletion(
      deletionRequest(fixture, idempotencyKey),
    )).resolves.toEqual(requested);
    expect(fixture.gateway.prepareManagedInstallationDeletion).toHaveBeenCalledTimes(1);
    expect(fixture.inference.suspendManagedInferenceInstallation).toHaveBeenCalledTimes(1);
    expect(fixture.telegram.suspendManagedTelegramInstallationRoute)
      .toHaveBeenCalledWith(expect.objectContaining({
        installationId: fixture.installationId,
        actorId: "424242",
        surfaceId: "424242",
      }));

    const recovered = await fixture.service.recoverUserDeletion({
      sessionToken: fixture.sessionToken,
      installationId: fixture.installationId,
      now: fixture.now + 1,
    });
    expect(recovered.state).toBe("recovered");
    expect(fixture.inference.recoverManagedInferenceInstallation).toHaveBeenCalledOnce();
    expect(fixture.telegram.recoverManagedTelegramInstallationRoute).toHaveBeenCalledOnce();
    expect(fixture.gateway.recoverManagedInstallation).toHaveBeenCalledOnce();
    await expect(fixture.lifecycle.getActiveForInstallation(fixture.installationId))
      .resolves.toBeNull();
  });

  it("re-suspends recovered owners if a later recovery boundary fails", async () => {
    const fixture = await serviceFixture({ recoverFails: true });
    const requested = await fixture.service.requestUserDeletion(deletionRequest(fixture));

    await expect(fixture.service.recoverUserDeletion({
      sessionToken: fixture.sessionToken,
      installationId: fixture.installationId,
      now: fixture.now + 1,
    })).rejects.toBeInstanceOf(InstallationLifecycleUnavailableError);
    expect(fixture.inference.suspendManagedInferenceInstallation).toHaveBeenCalledTimes(2);
    expect(fixture.telegram.suspendManagedTelegramInstallationRoute).toHaveBeenCalledTimes(2);
    expect(fixture.gateway.prepareManagedInstallationDeletion).toHaveBeenCalledTimes(2);
    await expect(fixture.lifecycle.getActiveForInstallation(fixture.installationId))
      .resolves.toMatchObject({
        state: "recoverable",
        lastErrorCode: "recovery_unavailable",
      });
    await fixture.lifecycle.recover(
      requested.operationId,
      fixture.principalId,
      fixture.now + 2,
    );
  });

  it("expires unfinished preparation and advances bounded teardown without getting stuck", async () => {
    const fixture = await serviceFixture({ prepareFails: true });
    const requested = await fixture.service.requestUserDeletion(deletionRequest(fixture));
    expect(requested.state).toBe("preparing");
    const stored = await fixture.lifecycle.get(requested.operationId);
    expect(stored?.lastErrorCode).toBe("preparation_unavailable");

    fixture.gateway.deleteManagedInstallationResourceBatch.mockImplementationOnce(
      async (input) => ({
        installationId: input.installationId,
        operationId: input.operationId,
        stage: "storage" as const,
        deleted: { processes: 2, repositories: 1, storageObjects: 25 },
        complete: false,
      }),
    );
    await expect(fixture.service.advanceActionable(requested.recoverableUntil + 1))
      .resolves.toBe(1);
    expect(fixture.gateway.prepareManagedInstallationDeletion).toHaveBeenCalledTimes(1);
    expect(fixture.gateway.deleteManagedInstallationResourceBatch).toHaveBeenCalledTimes(1);
    expect(fixture.telegram.deleteManagedTelegramInstallationRoute).toHaveBeenCalledOnce();
    expect(fixture.inference.deleteManagedInferenceInstallation).toHaveBeenCalledOnce();
    await expect(fixture.lifecycle.get(requested.operationId)).resolves.toMatchObject({
      state: "deleting",
      gatewayDeleted: false,
      telegramDeleted: true,
      inferenceDeleted: true,
    });

    await expect(fixture.service.advanceActionable(requested.recoverableUntil + 2))
      .resolves.toBe(1);
    expect(fixture.gateway.deleteManagedInstallationResourceBatch).toHaveBeenCalledTimes(2);
    expect(fixture.telegram.deleteManagedTelegramInstallationRoute).toHaveBeenCalledOnce();
    expect(fixture.inference.deleteManagedInferenceInstallation).toHaveBeenCalledOnce();
    await expect(fixture.lifecycle.get(requested.operationId)).resolves.toMatchObject({
      state: "complete",
    });
    const installation = await env.ACCOUNT_DB.prepare(
      "SELECT state FROM installations WHERE id = ?",
    ).bind(fixture.installationId).first<{ state: string }>();
    expect(installation?.state).toBe("deleted");
  });
});
