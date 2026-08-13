import { env } from "cloudflare:workers";
import {
  GSV_INFERENCE_PRODUCT_MODEL,
  type ManagedInferenceUsageEvent,
} from "@humansandmachines/gsv/protocol";
import { describe, expect, it } from "vitest";
import { AccountStore } from "./store";
import { ManagedInferenceUsageStore } from "./inference-usage";

async function installation(suffix: string): Promise<string> {
  const accounts = new AccountStore(env.ACCOUNT_DB, "gsv.space");
  const principalId = `principal_usage_${suffix}`;
  await accounts.createPrincipal({
    principalId,
    email: `usage-${suffix}@example.com`,
    displayName: `Usage ${suffix}`,
    verified: true,
  });
  return (await accounts.reserveInstallation({
    principalId,
    operationId: `operation_usage_${suffix}`,
    handle: `usage-${suffix}`,
  })).installationId;
}

function usageEvent(
  installationId: string,
  suffix: string,
): ManagedInferenceUsageEvent {
  const startedAt = Date.now();
  return {
    version: 1,
    installationId,
    logicalRequestId: `inference:${suffix}`,
    actor: {
      localUid: 1_000,
      processId: `process_${suffix}`,
      runId: `run_${suffix}`,
    },
    purpose: suffix.includes("mail") ? "mail-intake" : "agent",
    period: new Date(startedAt).toISOString().slice(0, 7),
    model: GSV_INFERENCE_PRODUCT_MODEL,
    responseModel: "deepseek/deepseek-v4-flash-0731",
    providerResponseId: `generation_${suffix}`,
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
  };
}

describe("managed inference usage store", () => {
  it("records immutable installation-scoped usage", async () => {
    const installationId = await installation("record");
    const event = usageEvent(installationId, "record");

    await new ManagedInferenceUsageStore(env.ACCOUNT_DB).record([event]);

    const row = await env.ACCOUNT_DB.prepare(
      `SELECT installation_id, logical_request_id, purpose, total_tokens,
              cost_nano_usd
       FROM managed_inference_usage_events`,
    ).first<{
      installation_id: string;
      logical_request_id: string;
      purpose: string;
      total_tokens: number;
      cost_nano_usd: number;
    }>();
    expect(row).toEqual({
      installation_id: installationId,
      logical_request_id: event.logicalRequestId,
      purpose: "agent",
      total_tokens: 3,
      cost_nano_usd: 340,
    });
  });

  it("records mail intake as a distinct usage purpose", async () => {
    const installationId = await installation("mail");
    const event = usageEvent(installationId, "mail");

    await new ManagedInferenceUsageStore(env.ACCOUNT_DB).record([event]);

    const row = await env.ACCOUNT_DB.prepare(
      `SELECT purpose FROM managed_inference_usage_events
       WHERE installation_id = ? AND logical_request_id = ?`,
    ).bind(installationId, event.logicalRequestId).first<{ purpose: string }>();
    expect(row).toEqual({ purpose: "mail-intake" });
  });

  it("accepts an exact replay without double counting", async () => {
    const installationId = await installation("replay");
    const event = usageEvent(installationId, "replay");
    const usage = new ManagedInferenceUsageStore(env.ACCOUNT_DB);

    await usage.record([event]);
    await usage.record([event]);

    const row = await env.ACCOUNT_DB.prepare(
      `SELECT COUNT(*) AS events, SUM(cost_nano_usd) AS cost_nano_usd
       FROM managed_inference_usage_events
       WHERE installation_id = ?`,
    ).bind(installationId).first<{ events: number; cost_nano_usd: number }>();
    expect(row).toEqual({ events: 1, cost_nano_usd: 340 });
  });

  it("rejects a replay whose settled usage changed", async () => {
    const installationId = await installation("conflict");
    const event = usageEvent(installationId, "conflict");
    const usage = new ManagedInferenceUsageStore(env.ACCOUNT_DB);

    await usage.record([event]);

    await expect(usage.record([{ ...event, costNanoUsd: 341 }])).rejects.toThrow(
      "conflicts with an existing event",
    );
  });

  it("does not accept usage for an unknown installation", async () => {
    const event = usageEvent("installation_unknown", "unknown");

    await expect(
      new ManagedInferenceUsageStore(env.ACCOUNT_DB).record([event]),
    ).rejects.toThrow();
  });
});
