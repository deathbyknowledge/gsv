import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ManagedInferencePolicyStore } from "./inference-policy";
import { AccountStore } from "./store";

async function installation(
  suffix: string,
  active = true,
): Promise<string> {
  const accounts = new AccountStore(env.ACCOUNT_DB, "gsv.space");
  const principalId = `principal_policy_${suffix}`;
  await accounts.createPrincipal({
    principalId,
    email: `policy-${suffix}@example.com`,
    displayName: `Policy ${suffix}`,
    verified: true,
  });
  const reservation = await accounts.reserveInstallation({
    principalId,
    operationId: `operation_policy_${suffix}`,
    handle: `policy-${suffix}`,
  });
  if (active) {
    await env.ACCOUNT_DB.prepare(
      "UPDATE installations SET state = 'active' WHERE id = ?",
    ).bind(reservation.installationId).run();
  }
  return reservation.installationId;
}

describe("managed inference policy store", () => {
  it("requires both the global switch and an active installation policy", async () => {
    const installationId = await installation("gates");
    const policies = new ManagedInferencePolicyStore(env.ACCOUNT_DB);

    await expect(policies.resolve(installationId)).resolves.toMatchObject({
      installationId,
      enabled: false,
      monthlyLimitNanoUsd: 0,
    });

    await policies.setInstallationPolicy(installationId, {
      enabled: true,
      monthlyLimitNanoUsd: 5_000_000_000,
    });
    await expect(policies.resolve(installationId)).resolves.toMatchObject({
      enabled: false,
      monthlyLimitNanoUsd: 5_000_000_000,
    });

    await policies.setControl(true);
    await expect(policies.resolve(installationId)).resolves.toMatchObject({
      enabled: true,
      monthlyLimitNanoUsd: 5_000_000_000,
    });

    await policies.setControl(false);
    await expect(policies.resolve(installationId)).resolves.toMatchObject({
      enabled: false,
    });
  });

  it("does not enable an installation before activation", async () => {
    const installationId = await installation("inactive", false);
    const policies = new ManagedInferencePolicyStore(env.ACCOUNT_DB);
    await policies.setControl(true);
    await policies.setInstallationPolicy(installationId, {
      enabled: true,
      monthlyLimitNanoUsd: 1_000_000_000,
    });

    await expect(policies.resolve(installationId)).resolves.toMatchObject({
      enabled: false,
      monthlyLimitNanoUsd: 1_000_000_000,
    });
  });

  it("requires a positive allowance when enabling a policy", async () => {
    const installationId = await installation("allowance");
    const policies = new ManagedInferencePolicyStore(env.ACCOUNT_DB);

    await expect(policies.setInstallationPolicy(installationId, {
      enabled: true,
      monthlyLimitNanoUsd: 0,
    })).rejects.toThrow("monthly limit is required");
    await expect(policies.setInstallationPolicy("installation_unknown", {
      enabled: false,
      monthlyLimitNanoUsd: 0,
    })).rejects.toThrow("installation is unavailable");
  });

  it("validates and applies the operator-owned OpenRouter route", async () => {
    const installationId = await installation("routing");
    const policies = new ManagedInferencePolicyStore(env.ACCOUNT_DB);
    const current = await policies.routing();

    expect(current).toMatchObject({
      modelId: "deepseek/deepseek-v4-flash-0731",
      provider: { sort: "default", quantizations: [] },
    });
    const routing = await policies.setRouting({
      ...current,
      modelId: "deepseek/deepseek-r1",
      displayName: "DeepSeek R1",
      contextWindow: 131_072,
      maxOutputTokens: 32_768,
      inputNanoUsdPerToken: 400,
      outputNanoUsdPerToken: 1_200,
      provider: {
        ...current.provider,
        dataCollection: "deny",
        zdr: true,
        only: ["Fireworks"],
        quantizations: ["fp16", "bf16"],
        sort: "throughput",
        preferredMinThroughput: 30,
      },
    });

    expect(routing).toMatchObject({
      modelId: "deepseek/deepseek-r1",
      provider: {
        only: ["Fireworks"],
        quantizations: ["fp16", "bf16"],
      },
    });
    await expect(policies.resolve(installationId)).resolves.toMatchObject({
      routing: { modelId: "deepseek/deepseek-r1" },
    });
    await expect(policies.setRouting({
      ...routing,
      provider: {
        ...routing.provider,
        only: ["Fireworks"],
        ignore: ["Fireworks"],
      },
    })).rejects.toThrow("overlap");
  });
});
