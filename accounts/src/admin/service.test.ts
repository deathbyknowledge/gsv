import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { InstallationOnboardingStore } from "../onboarding";
import { ManagedInferencePolicyStore } from "../inference-policy";
import { ManagedInferenceUsageStore } from "../inference-usage";
import { AccountStore } from "../store";
import { InstallationAdminService } from "./service";

function adminService(): InstallationAdminService {
  const accounts = new AccountStore(env.ACCOUNT_DB, "gsv.space");
  return new InstallationAdminService(
    env.ACCOUNT_DB,
    accounts,
    new InstallationOnboardingStore(env.ACCOUNT_DB, accounts),
    new ManagedInferencePolicyStore(env.ACCOUNT_DB),
  );
}

describe("installation admin service", () => {
  it("creates a routed installation and one-time onboarding claim", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const service = adminService();
    const created = await service.create({
      operationId: `operation_admin_${suffix}`,
      handle: `admin-${suffix}`,
    });

    expect(created.installation).toMatchObject({
      installationId: created.onboarding.installationId,
      handle: `admin-${suffix}`,
      state: "provisioning",
      operationState: "provisioning",
    });
    expect(created.onboarding.onboardingUrl).toMatch(
      new RegExp(`^https://admin-${suffix}\\.gsv\\.space/onboarding#onboard_`),
    );
    await expect(service.overview()).resolves.toMatchObject({
      installations: expect.arrayContaining([created.installation]),
    });
  });

  it("reissues a claim without creating another installation", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const service = adminService();
    const created = await service.create({
      operationId: `operation_reissue_${suffix}`,
      handle: `reissue-${suffix}`,
    });
    const reissued = await service.reissueOnboarding(
      created.installation.installationId,
    );

    expect(reissued.installation.installationId).toBe(
      created.installation.installationId,
    );
    expect(reissued.onboarding.onboardingUrl).not.toBe(
      created.onboarding.onboardingUrl,
    );
  });

  it("includes current-period managed inference usage", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const service = adminService();
    const created = await service.create({
      operationId: `operation_usage_${suffix}`,
      handle: `usage-${suffix}`,
    });
    const startedAt = Date.now();
    await new ManagedInferenceUsageStore(env.ACCOUNT_DB).record([{
      version: 1,
      installationId: created.installation.installationId,
      logicalRequestId: `inference:${suffix}`,
      actor: { localUid: 1_000 },
      period: new Date(startedAt).toISOString().slice(0, 7),
      model: "gsv/default",
      inputTokens: 2,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 3,
      reservedNanoUsd: 6_000,
      costNanoUsd: 340,
      outcome: "completed",
      stopReason: "stop",
      startedAt,
      completedAt: startedAt + 10,
    }]);

    await expect(service.overview()).resolves.toMatchObject({
      installations: expect.arrayContaining([expect.objectContaining({
        installationId: created.installation.installationId,
        inference: expect.objectContaining({
          requests: 1,
          tokens: 3,
          costNanoUsd: 340,
        }),
      })]),
    });
  });

  it("updates global and installation inference controls", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const service = adminService();
    const created = await service.create({
      operationId: `operation_control_${suffix}`,
      handle: `control-${suffix}`,
    });

    await service.setInferenceControl(true);
    await service.setInstallationInferencePolicy(
      created.installation.installationId,
      { enabled: true, monthlyLimitNanoUsd: 10_000_000_000 },
    );

    await expect(service.overview()).resolves.toMatchObject({
      inference: { enabled: true },
      installations: expect.arrayContaining([expect.objectContaining({
        installationId: created.installation.installationId,
        inference: expect.objectContaining({
          enabled: true,
          monthlyLimitNanoUsd: 10_000_000_000,
        }),
      })]),
    });
  });

  it("suspends and reactivates only active installations", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const service = adminService();
    const created = await service.create({
      operationId: `operation_lifecycle_${suffix}`,
      handle: `lifecycle-${suffix}`,
    });

    await expect(
      service.setInstallationState(
        created.installation.installationId,
        "restricted",
      ),
    ).rejects.toThrow("cannot transition from provisioning");
    await env.ACCOUNT_DB.prepare(
      "UPDATE installations SET state = 'active' WHERE id = ?",
    ).bind(created.installation.installationId).run();
    await service.setInferenceControl(true);
    await service.setInstallationInferencePolicy(
      created.installation.installationId,
      { enabled: true, monthlyLimitNanoUsd: 1_000_000_000 },
    );

    await service.setInstallationState(
      created.installation.installationId,
      "restricted",
    );
    await service.setInstallationState(
      created.installation.installationId,
      "restricted",
    );
    await expect(service.overview()).resolves.toMatchObject({
      installations: expect.arrayContaining([expect.objectContaining({
        installationId: created.installation.installationId,
        state: "restricted",
      })]),
    });
    await expect(new ManagedInferencePolicyStore(env.ACCOUNT_DB).resolve(
      created.installation.installationId,
    )).resolves.toMatchObject({ enabled: false });

    await service.setInstallationState(
      created.installation.installationId,
      "active",
    );
    await expect(service.overview()).resolves.toMatchObject({
      installations: expect.arrayContaining([expect.objectContaining({
        installationId: created.installation.installationId,
        state: "active",
      })]),
    });
    await expect(new ManagedInferencePolicyStore(env.ACCOUNT_DB).resolve(
      created.installation.installationId,
    )).resolves.toMatchObject({ enabled: true });
  });
});
