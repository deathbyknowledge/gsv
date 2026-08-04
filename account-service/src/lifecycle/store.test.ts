import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { EntitlementStore } from "../entitlements/store";
import { AccountStore } from "../store";
import { InstallationLifecycleStore } from "./store";

type ActiveFixture = {
  principalId: string;
  installationId: string;
  handle: string;
  operationId: string;
};

async function activeInstallation(label: string): Promise<ActiveFixture> {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const principalId = `principal_${label}_${suffix}`;
  const operationId = `provision_${label}_${suffix}`;
  const handle = `${label}-${suffix}`;
  const accounts = new AccountStore(env.ACCOUNT_DB, "gsv.space");
  await accounts.createPrincipal({
    principalId,
    email: `${label}-${suffix}@example.com`,
    displayName: label,
    verified: true,
  });
  const reserved = await accounts.reserveInstallation({
    principalId,
    operationId,
    handle,
    ownerUsername: "owner",
  });
  const now = Date.now();
  await new EntitlementStore(env.ACCOUNT_DB).project({
    installationId: reserved.installationId,
    state: "active",
    planKey: "lifecycle-test",
    inferenceBudgetMicrounits: 5_000_000,
    inferencePeriodStartsAt: now,
    inferencePeriodEndsAt: now + 30 * 24 * 60 * 60_000,
    storageLimitBytes: 10_000_000,
    effectiveAt: now,
    version: 1,
  });
  await accounts.beginProvisioning(operationId, principalId);
  await accounts.completeProvisioning(operationId, principalId, "owner", {
    state: "active",
    installationId: reserved.installationId,
    principalId,
    localUid: 1000,
    username: "owner",
    provisionVersion: reserved.provisionVersion,
  });
  return {
    principalId,
    installationId: reserved.installationId,
    handle,
    operationId,
  };
}

describe("installation lifecycle store", () => {
  it("atomically retires routing, preserves recoverable data, and restores it", async () => {
    const fixture = await activeInstallation("recover");
    const lifecycle = new InstallationLifecycleStore(env.ACCOUNT_DB);
    const now = Date.now();
    const operationId = `deletion_${crypto.randomUUID()}`;
    const recoverableUntil = now + 7 * 24 * 60 * 60_000;

    await expect(lifecycle.beginUserDeletion({
      operationId: `deletion_wrong_${crypto.randomUUID()}`,
      principalId: fixture.principalId,
      installationId: fixture.installationId,
      confirmedHandle: `wrong-${crypto.randomUUID().slice(0, 8)}`,
      recoverableUntil,
      now,
    })).rejects.toThrow("confirmation does not match");

    const started = await lifecycle.beginUserDeletion({
      operationId,
      principalId: fixture.principalId,
      installationId: fixture.installationId,
      confirmedHandle: fixture.handle,
      recoverableUntil,
      now,
    });
    expect(started).toMatchObject({
      state: "preparing",
      previousState: "active",
      gatewayPrepared: false,
      inferenceSuspended: false,
      telegramSuspended: false,
    });
    await expect(new AccountStore(env.ACCOUNT_DB, "gsv.space")
      .resolveHostname(`${fixture.handle}.gsv.space`)).resolves.toEqual({ found: false });
    await expect(lifecycle.beginUserDeletion({
      operationId,
      principalId: fixture.principalId,
      installationId: fixture.installationId,
      confirmedHandle: fixture.handle,
      recoverableUntil,
      now: now + 1,
    })).resolves.toEqual(started);
    await expect(lifecycle.beginUserDeletion({
      operationId: `deletion_conflict_${crypto.randomUUID()}`,
      principalId: fixture.principalId,
      installationId: fixture.installationId,
      confirmedHandle: fixture.handle,
      recoverableUntil,
      now,
    })).rejects.toThrow("already in progress");

    await lifecycle.markPreparationComponent(operationId, "gateway", now + 2);
    await lifecycle.markPreparationComponent(operationId, "inference", now + 3);
    expect((await lifecycle.get(operationId))?.state).toBe("preparing");
    const recoverable = await lifecycle.markPreparationComponent(
      operationId,
      "telegram",
      now + 4,
    );
    expect(recoverable.state).toBe("recoverable");

    const recovered = await lifecycle.recover(
      operationId,
      fixture.principalId,
      now + 5,
    );
    expect(recovered.state).toBe("recovered");
    const installation = await env.ACCOUNT_DB.prepare(
      "SELECT state FROM installations WHERE id = ?",
    ).bind(fixture.installationId).first<{ state: string }>();
    expect(installation?.state).toBe("active");
    await expect(new AccountStore(env.ACCOUNT_DB, "gsv.space")
      .resolveHostname(`${fixture.handle}.gsv.space`)).resolves.toMatchObject({
        found: true,
        installationId: fixture.installationId,
        state: "active",
      });
    const membership = await env.ACCOUNT_DB.prepare(
      "SELECT state, local_uid FROM memberships WHERE installation_id = ?",
    ).bind(fixture.installationId).first<{ state: string; local_uid: number }>();
    expect(membership).toEqual({ state: "active", local_uid: 1000 });
  });

  it("finalizes only after every resource owner confirms deletion", async () => {
    const fixture = await activeInstallation("finalize");
    const lifecycle = new InstallationLifecycleStore(env.ACCOUNT_DB);
    const now = Date.now();
    const recoverableUntil = now + 1_000;
    const operationId = `deletion_${crypto.randomUUID()}`;
    await lifecycle.beginUserDeletion({
      operationId,
      principalId: fixture.principalId,
      installationId: fixture.installationId,
      confirmedHandle: fixture.handle,
      recoverableUntil,
      now,
    });
    await lifecycle.advanceDue(operationId, recoverableUntil + 1);
    await lifecycle.markDeletionComponent(operationId, "telegram", recoverableUntil + 2);
    await lifecycle.markDeletionComponent(operationId, "inference", recoverableUntil + 3);
    await expect(lifecycle.finalize(operationId, recoverableUntil + 4))
      .rejects.toThrow("incomplete");
    await lifecycle.markDeletionComponent(operationId, "gateway", recoverableUntil + 4);
    await lifecycle.finalize(operationId, recoverableUntil + 5);

    await expect(lifecycle.get(operationId)).resolves.toMatchObject({
      state: "complete",
      gatewayDeleted: true,
      inferenceDeleted: true,
      telegramDeleted: true,
      completedAt: recoverableUntil + 5,
    });
    const installation = await env.ACCOUNT_DB.prepare(
      "SELECT state, deleted_at FROM installations WHERE id = ?",
    ).bind(fixture.installationId).first<{
      state: string;
      deleted_at: number | null;
    }>();
    expect(installation).toEqual({
      state: "deleted",
      deleted_at: recoverableUntil + 5,
    });
    for (const table of ["memberships", "provisioning_operations", "entitlements"]) {
      const row = await env.ACCOUNT_DB.prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE installation_id = ?`,
      ).bind(fixture.installationId).first<{ count: number }>();
      expect(row?.count, table).toBe(0);
    }
    await expect(lifecycle.getActiveForInstallation(fixture.installationId))
      .resolves.toBeNull();
  });

  it("starts expired retention cleanup directly in teardown", async () => {
    const fixture = await activeInstallation("retention");
    const now = Date.now();
    await new EntitlementStore(env.ACCOUNT_DB).project({
      installationId: fixture.installationId,
      state: "retained",
      planKey: "lifecycle-test",
      inferenceBudgetMicrounits: 0,
      inferencePeriodStartsAt: now,
      inferencePeriodEndsAt: now + 30 * 24 * 60 * 60_000,
      storageLimitBytes: 10_000_000,
      effectiveAt: now,
      version: 2,
    });
    const lifecycle = new InstallationLifecycleStore(env.ACCOUNT_DB);
    const operation = await lifecycle.beginRetentionDeletion({
      operationId: `deletion_${crypto.randomUUID()}`,
      installationId: fixture.installationId,
      now,
    });
    expect(operation).toMatchObject({
      requestKind: "retention",
      previousState: "retained",
      state: "deleting",
      gatewayPrepared: true,
      inferenceSuspended: true,
      telegramSuspended: true,
      recoverableUntil: now,
    });
  });
});
