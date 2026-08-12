import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { InstallationOnboardingStore } from "../onboarding";
import { ManagedInferencePolicyStore } from "../inference-policy";
import { ManagedInferenceUsageStore } from "../inference-usage";
import { AccountStore } from "../store";
import { InstallationAdminService } from "./service";

const FIRST_PAGE = { query: "", state: null, page: 1 } as const;

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
    await expect(service.getInstallation(
      created.installation.installationId,
    )).resolves.toEqual(created.installation);
    await expect(service.listInstallations(FIRST_PAGE)).resolves.toMatchObject({
      page: 1,
      pageSize: 50,
      installations: expect.arrayContaining([expect.objectContaining({
        installationId: created.installation.installationId,
        handle: created.installation.handle,
      })]),
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

    await expect(service.getInstallation(
      created.installation.installationId,
    )).resolves.toMatchObject({
      inference: {
        requests: 1,
        tokens: 3,
        costNanoUsd: 340,
      },
    });
    await expect(service.inferenceOverview()).resolves.toMatchObject({
      requests: 1,
      tokens: 3,
      costNanoUsd: 340,
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

    await expect(service.inferenceOverview()).resolves.toMatchObject({
      enabled: true,
    });
    await expect(service.getInstallation(
      created.installation.installationId,
    )).resolves.toMatchObject({
      inference: expect.objectContaining({
        enabled: true,
        monthlyLimitNanoUsd: 10_000_000_000,
      }),
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
    await expect(service.getInstallation(
      created.installation.installationId,
    )).resolves.toMatchObject({
      state: "restricted",
    });
    await expect(new ManagedInferencePolicyStore(env.ACCOUNT_DB).resolve(
      created.installation.installationId,
    )).resolves.toMatchObject({ enabled: false });

    await service.setInstallationState(
      created.installation.installationId,
      "active",
    );
    await expect(service.getInstallation(
      created.installation.installationId,
    )).resolves.toMatchObject({
      state: "active",
    });
    await expect(new ManagedInferencePolicyStore(env.ACCOUNT_DB).resolve(
      created.installation.installationId,
    )).resolves.toMatchObject({ enabled: true });
  });

  it("searches and filters the bounded installation registry", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const service = adminService();
    const matching = await service.create({
      operationId: `operation_search_match_${suffix}`,
      handle: `search-match-${suffix}`,
    });
    await service.create({
      operationId: `operation_search_other_${suffix}`,
      handle: `other-${suffix}`,
    });

    const result = await service.listInstallations({
      query: `MATCH-${suffix.toUpperCase()}`,
      state: "provisioning",
      page: 1,
    });
    expect(result).toMatchObject({
      query: `match-${suffix}`,
      state: "provisioning",
      page: 1,
      pageSize: 50,
      total: 1,
      totalPages: 1,
    });
    expect(result.installations).toEqual([
      expect.objectContaining({
        installationId: matching.installation.installationId,
        handle: `search-match-${suffix}`,
        state: "provisioning",
      }),
    ]);

    await expect(service.listInstallations({
      query: `match-${suffix}`,
      state: "active",
      page: 1,
    })).resolves.toMatchObject({ total: 0, installations: [] });
    await expect(service.listInstallations({
      query: `match-${suffix}`,
      state: "provisioning",
      page: 2,
    })).resolves.toMatchObject({
      page: 2,
      total: 1,
      totalPages: 1,
      installations: [],
    });
  });

  it("paginates installation summaries without overlapping rows", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const service = adminService();
    const oldest = await service.create({
      operationId: `operation_page_${suffix}`,
      handle: `page-${suffix}`,
    });
    const owner = await env.ACCOUNT_DB.prepare(
      "SELECT owner_principal_id FROM installations WHERE id = ?",
    ).bind(oldest.installation.installationId).first<{
      owner_principal_id: string;
    }>();
    if (!owner) throw new Error("admin test owner is unavailable");

    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < 50; index += 1) {
      const installationId = `inst_page_${suffix}_${index}`;
      const handle = `page-${suffix}-${index}`;
      const createdAt = oldest.installation.createdAt + index + 1;
      statements.push(
        env.ACCOUNT_DB.prepare(
          `INSERT INTO installations (
             id, owner_principal_id, handle, canonical_origin, state,
             provision_version, created_at
           ) VALUES (?, ?, ?, ?, 'provisioning', 1, ?)`,
        ).bind(
          installationId,
          owner.owner_principal_id,
          handle,
          `https://${handle}.gsv.space`,
          createdAt,
        ),
        env.ACCOUNT_DB.prepare(
          `INSERT INTO provisioning_operations (
             operation_id, installation_id, principal_id, kind, state,
             attempt, last_error, updated_at
           ) VALUES (?, ?, ?, 'create', 'provisioning', 1, NULL, ?)`,
        ).bind(
          `operation_${installationId}`,
          installationId,
          owner.owner_principal_id,
          createdAt,
        ),
      );
    }
    await env.ACCOUNT_DB.batch(statements.slice(0, 50));
    await env.ACCOUNT_DB.batch(statements.slice(50));

    const query = {
      query: `page-${suffix}`,
      state: "provisioning" as const,
    };
    const first = await service.listInstallations({ ...query, page: 1 });
    const second = await service.listInstallations({ ...query, page: 2 });

    expect(first).toMatchObject({ total: 51, totalPages: 2, pageSize: 50 });
    expect(first.installations).toHaveLength(50);
    expect(second.installations).toEqual([expect.objectContaining({
      installationId: oldest.installation.installationId,
    })]);
    expect(first.installations).not.toContainEqual(expect.objectContaining({
      installationId: oldest.installation.installationId,
    }));
  });
});
