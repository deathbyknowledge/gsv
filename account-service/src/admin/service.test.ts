import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { GatewayEntitlementProjector } from "../entitlements/projector";
import { EntitlementStore } from "../entitlements/store";
import { InstallationOnboardingStore } from "../installations/onboarding";
import { AccountStore } from "../store";
import {
  InstallationAdminService,
  operatorEntitlementConfig,
} from "./service";

function adminService() {
  const accounts = new AccountStore(env.ACCOUNT_DB, "gsv.space");
  const entitlements = new EntitlementStore(env.ACCOUNT_DB);
  const applyManagedEntitlement = vi.fn(async (projection) => projection);
  return {
    applyManagedEntitlement,
    onboarding: new InstallationOnboardingStore(env.ACCOUNT_DB, accounts),
    service: new InstallationAdminService(
      env.ACCOUNT_DB,
      accounts,
      entitlements,
      new GatewayEntitlementProjector(
        entitlements,
        { applyManagedEntitlement } as never,
      ),
      new InstallationOnboardingStore(env.ACCOUNT_DB, accounts),
      {
        planKey: "managed-preview",
        inferenceBudgetMicrounits: 5_000_000,
        storageLimitBytes: 10_000_000_000,
      },
    ),
  };
}

describe("installation admin service", () => {
  it("parses the operator-granted entitlement independently of billing", () => {
    expect(operatorEntitlementConfig({
      GSV_OPERATOR_PLAN_KEY: "managed-preview",
      GSV_OPERATOR_INFERENCE_BUDGET_MICROUNITS: "5000000",
      GSV_OPERATOR_STORAGE_LIMIT_BYTES: "10000000000",
    })).toEqual({
      planKey: "managed-preview",
      inferenceBudgetMicrounits: 5_000_000,
      storageLimitBytes: 10_000_000_000,
    });
    expect(() => operatorEntitlementConfig({
      GSV_OPERATOR_PLAN_KEY: "managed-preview",
      GSV_OPERATOR_INFERENCE_BUDGET_MICROUNITS: "unlimited",
      GSV_OPERATOR_STORAGE_LIMIT_BYTES: "10000000000",
    })).toThrow("GSV_OPERATOR_INFERENCE_BUDGET_MICROUNITS is invalid");
  });

  it("creates a routed installation with an operator entitlement and claim", async () => {
    const result = adminService();
    const suffix = crypto.randomUUID().slice(0, 8);
    const created = await result.service.create({
      operationId: `operation_admin_${suffix}`,
      handle: `admin-${suffix}`,
    });

    expect(created.installation).toMatchObject({
      installationId: created.onboarding.installationId,
      handle: `admin-${suffix}`,
      state: "provisioning",
      operationState: "provisioning",
      entitlementState: "active",
      planKey: "managed-preview",
    });
    const onboardingUrl = new URL(created.onboarding.onboardingUrl);
    expect(onboardingUrl.origin).toBe(`https://admin-${suffix}.gsv.space`);
    expect(onboardingUrl.pathname).toBe("/onboarding");
    expect(onboardingUrl.hash).toMatch(/^#onboard_/);
    expect(result.applyManagedEntitlement).toHaveBeenCalledOnce();
    await expect(result.onboarding.authorize({
      installationId: created.installation.installationId,
      token: new URL(created.onboarding.onboardingUrl).hash.slice(1),
    })).resolves.toMatchObject({ ok: true });
    await expect(result.service.list()).resolves.toContainEqual(
      created.installation,
    );
  });

  it("reissues a provisioning claim and invalidates the previous capability", async () => {
    const result = adminService();
    const suffix = crypto.randomUUID().slice(0, 8);
    const created = await result.service.create({
      operationId: `operation_reissue_${suffix}`,
      handle: `reissue-${suffix}`,
    });
    const reissued = await result.service.reissueOnboarding(
      created.installation.installationId,
    );
    const firstToken = new URL(created.onboarding.onboardingUrl).hash.slice(1);
    const secondToken = new URL(reissued.onboarding.onboardingUrl).hash.slice(1);

    expect(secondToken).not.toBe(firstToken);
    await expect(result.onboarding.authorize({
      installationId: created.installation.installationId,
      token: firstToken,
    })).resolves.toEqual({ ok: false });
    await expect(result.onboarding.authorize({
      installationId: created.installation.installationId,
      token: secondToken,
    })).resolves.toMatchObject({ ok: true });
  });

  it("replays the same operation without creating another installation", async () => {
    const result = adminService();
    const suffix = crypto.randomUUID().slice(0, 8);
    const input = {
      operationId: `operation_replay_${suffix}`,
      handle: `replay-${suffix}`,
    };
    const first = await result.service.create(input);
    const second = await result.service.create(input);

    expect(second.installation.installationId).toBe(
      first.installation.installationId,
    );
    expect(result.applyManagedEntitlement).toHaveBeenCalledTimes(2);
  });
});
