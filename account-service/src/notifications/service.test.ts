import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { LifecycleNotificationMailer } from "../email/mailer";
import { InstallationLifecycleStore } from "../lifecycle/store";
import { AccountStore } from "../store";
import { BillingStore } from "../billing/store";
import { LifecycleNotificationService } from "./service";
import { LifecycleNotificationStore } from "./store";

const DAY_MS = 24 * 60 * 60_000;

describe("lifecycle notifications", () => {
  it("delivers each retention warning once in its durable window", async () => {
    const fixture = await retainedInstallation();
    let sendAttempt = 0;
    const delivered: string[] = [];
    const mailer: LifecycleNotificationMailer = {
      async sendLifecycleNotification(message) {
        sendAttempt += 1;
        if (message.kind === "retention_1_day" && sendAttempt === 3) {
          throw Object.assign(new Error("rate limited"), {
            code: "E_RATE_LIMIT_EXCEEDED",
          });
        }
        delivered.push(message.kind);
        return { messageId: `message_${sendAttempt}` };
      },
    };
    const store = new LifecycleNotificationStore(env.ACCOUNT_DB);
    const service = new LifecycleNotificationService(
      store,
      mailer,
      "https://accounts.gsv.space",
    );

    await expect(service.sync(fixture.now)).resolves.toEqual({
      claimed: 1,
      sent: 1,
      failed: 0,
    });
    await expect(service.sync(fixture.retentionEndsAt - 7 * DAY_MS))
      .resolves.toMatchObject({ claimed: 1, sent: 1 });
    await expect(service.sync(fixture.retentionEndsAt - DAY_MS))
      .resolves.toEqual({ claimed: 1, sent: 0, failed: 1 });
    await expect(service.sync(fixture.retentionEndsAt - DAY_MS + 30_000))
      .resolves.toEqual({ claimed: 1, sent: 1, failed: 0 });

    expect(delivered).toEqual([
      "retention_started",
      "retention_7_days",
      "retention_1_day",
    ]);
    const notifications = await store.listForInstallation(fixture.installationId);
    expect(notifications).toHaveLength(3);
    expect(notifications.map((notification) => notification.state))
      .toEqual(["sent", "sent", "sent"]);
    await expect(service.sync(fixture.retentionEndsAt - DAY_MS + 60_000))
      .resolves.toEqual({ claimed: 0, sent: 0, failed: 0 });
  });

  it("expires a superseded deletion request and sends the recovery notice", async () => {
    const suffix = uniqueSuffix();
    const principalId = `principal_notice_recovery_${suffix}`;
    const accounts = new AccountStore(env.ACCOUNT_DB, "gsv.space");
    await accounts.createPrincipal({
      principalId,
      email: `notice-recovery-${suffix}@example.com`,
      displayName: "Notification Recovery",
      verified: true,
    });
    const installation = await accounts.reserveInstallation({
      principalId,
      operationId: `provision_notice_recovery_${suffix}`,
      handle: `notice-recovery-${suffix}`,
    });
    await env.ACCOUNT_DB.prepare(
      "UPDATE installations SET state = 'active' WHERE id = ?",
    ).bind(installation.installationId).run();
    const now = Date.now();
    const lifecycle = new InstallationLifecycleStore(env.ACCOUNT_DB);
    const operation = await lifecycle.beginUserDeletion({
      operationId: `deletion_notice_recovery_${suffix}`,
      principalId,
      installationId: installation.installationId,
      confirmedHandle: installation.handle,
      recoverableUntil: now + 7 * DAY_MS,
      now,
    });
    await lifecycle.recover(operation.operationId, principalId, now + 1);

    const delivered: string[] = [];
    const service = new LifecycleNotificationService(
      new LifecycleNotificationStore(env.ACCOUNT_DB),
      {
        async sendLifecycleNotification(message) {
          delivered.push(message.kind);
          return { messageId: `message_${message.kind}` };
        },
      },
      "https://accounts.gsv.space",
    );
    await service.sync(now + 2);

    expect(delivered).toEqual(["user_deletion_recovered"]);
    const notifications = await new LifecycleNotificationStore(env.ACCOUNT_DB)
      .listForInstallation(installation.installationId);
    expect(notifications).toEqual([
      expect.objectContaining({
        kind: "user_deletion_requested",
        state: "expired",
        lastErrorCode: "lifecycle_superseded",
      }),
      expect.objectContaining({
        kind: "user_deletion_recovered",
        state: "sent",
      }),
    ]);
  });

  it("leases a due message to only one concurrent delivery owner", async () => {
    const fixture = await retainedInstallation();
    const store = new LifecycleNotificationStore(env.ACCOUNT_DB);
    await store.enqueueDue(fixture.now);

    const first = await store.claimDue(fixture.now, 1);
    const second = await store.claimDue(fixture.now, 1);
    expect(first).toHaveLength(1);
    expect(first[0]?.kind).toBe("retention_started");
    expect(second).toEqual([]);
  });
});

async function retainedInstallation(): Promise<{
  installationId: string;
  now: number;
  retentionEndsAt: number;
}> {
  const suffix = uniqueSuffix();
  const principalId = `principal_notice_${suffix}`;
  const accounts = new AccountStore(env.ACCOUNT_DB, "gsv.space");
  await accounts.createPrincipal({
    principalId,
    email: `notice-${suffix}@example.com`,
    displayName: "Notification Owner",
    verified: true,
  });
  const installation = await accounts.reserveInstallation({
    principalId,
    operationId: `provision_notice_${suffix}`,
    handle: `notice-${suffix}`,
  });
  await env.ACCOUNT_DB.prepare(
    "UPDATE installations SET state = 'retained' WHERE id = ?",
  ).bind(installation.installationId).run();
  const billing = new BillingStore(env.ACCOUNT_DB);
  const account = await billing.registerBillingAccount({
    principalId,
    provider: "stripe",
    providerCustomerId: `cus_notice_${suffix}`,
  });
  const now = Date.now();
  const retentionEndsAt = now + 30 * DAY_MS;
  await billing.reconcileSubscription({
    account,
    snapshot: {
      subscriptionId: `sub_notice_${suffix}`,
      customerId: account.providerCustomerId,
      installationId: installation.installationId,
      planKey: "founding-monthly",
      state: "cancelled",
      observedAt: now,
      currentPeriodStartsAt: now - 30 * DAY_MS,
      currentPeriodEndsAt: now - 1,
      cancelAtPeriodEnd: false,
    },
    snapshotHash: suffix.padEnd(64, "a").slice(0, 64),
    lifecycle: {
      state: "retained",
      paidThrough: now - 1,
      graceEndsAt: null,
      retentionEndsAt,
      entitlement: null,
    },
    now,
  });
  return { installationId: installation.installationId, now, retentionEndsAt };
}

function uniqueSuffix(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}
