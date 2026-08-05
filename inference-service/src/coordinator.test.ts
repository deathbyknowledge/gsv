import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MANAGED_INFERENCE_PRODUCT_MODEL } from "@humansandmachines/gsv/protocol";
import type { BudgetCoordinator } from "./coordinator";
import type { BudgetSnapshot } from "./ledger";

describe("managed inference budget coordinator", () => {
  it("reports only the current installation budget period", async () => {
    const installationId = installation("usage");
    const stub = coordinator(installationId);
    await expect(stub.budgetUsage(installationId)).resolves.toBeNull();

    await events(await stub.run(
      request(installationId, "request_usage"),
      entitlement(installationId),
    ));
    await expect(stub.budgetUsage(installationId)).resolves.toMatchObject({
      installationId,
      budgetMicrounits: 5_000_000,
      spentMicrounits: 1,
      reservedMicrounits: 0,
    });
  });

  it("settles provider retries once per attempt and cannot replay a success", async () => {
    const installationId = installation("retry");
    const stub = coordinator(installationId);
    const input = request(installationId, "request_retry");
    const grant = entitlement(installationId);

    const first = await stub.run(input, grant);
    expect(first.status).toBe(200);
    expect((await events(first)).at(-1)).toMatchObject({
      type: "error",
      reason: "error",
    });

    const second = await stub.run(input, grant);
    expect((await events(second)).at(-1)).toMatchObject({
      type: "done",
      message: {
        provider: "gsv",
        model: MANAGED_INFERENCE_PRODUCT_MODEL,
      },
    });

    const replay = await stub.run(input, grant);
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({ code: "request_complete" });

    const snapshot = await stub.inspect() as BudgetSnapshot;
    expect(snapshot.requests).toHaveLength(1);
    expect(snapshot.requests[0]).toMatchObject({
      state: "succeeded",
      attempt_count: 2,
      spent_microunits: 20,
    });
    expect(snapshot.attempts.map((attempt) => ({
      ordinal: attempt.ordinal,
      state: attempt.state,
      settled: attempt.settled_microunits,
    }))).toEqual([
      { ordinal: 1, state: "failed", settled: 1 },
      { ordinal: 2, state: "succeeded", settled: 19 },
    ]);
    expect(snapshot.periods[0]).toMatchObject({
      spent_microunits: 20,
      reserved_microunits: 0,
    });
  });

  it("isolates identical request ids and budgets in different installations", async () => {
    const firstId = installation("first");
    const secondId = installation("second");
    const first = coordinator(firstId);
    const second = coordinator(secondId);

    await events(await first.run(request(firstId, "request_shared"), entitlement(firstId)));
    await events(await second.run(request(secondId, "request_shared"), entitlement(secondId)));

    const firstSnapshot = await first.inspect() as BudgetSnapshot;
    const secondSnapshot = await second.inspect() as BudgetSnapshot;
    expect(firstSnapshot.requests[0]?.spent_microunits).toBe(1);
    expect(secondSnapshot.requests[0]?.spent_microunits).toBe(1);
    expect(firstSnapshot.requests[0]?.logical_request_id).toBe("request_shared");
    expect(secondSnapshot.requests[0]?.logical_request_id).toBe("request_shared");
  });

  it("enforces concurrency before starting another provider attempt", async () => {
    const installationId = installation("concurrency");
    const stub = coordinator(installationId);
    const grant = entitlement(installationId);
    const first = await stub.run(request(installationId, "request_one"), grant);
    const second = await stub.run(request(installationId, "request_two"), grant);
    const denied = await stub.run(request(installationId, "request_three"), grant);

    expect(denied.status).toBe(429);
    await expect(denied.json()).resolves.toMatchObject({ code: "concurrency_limit" });
    await Promise.all([events(first), events(second)]);
  });

  it("propagates abort to the active upstream owner and releases reservation", async () => {
    const installationId = installation("abort");
    const stub = coordinator(installationId);
    const response = await stub.run(
      request(installationId, "request_abort"),
      entitlement(installationId),
    );
    await expect(stub.abort("request_abort")).resolves.toEqual({ aborted: true });
    expect((await events(response)).at(-1)).toMatchObject({
      type: "error",
      reason: "aborted",
    });
    const snapshot = await stub.inspect() as BudgetSnapshot;
    expect(snapshot.requests[0]?.state).toBe("aborted");
    expect(snapshot.periods[0]?.reserved_microunits).toBe(0);
  });

  it("charges the full reservation when the provider outcome is ambiguous", async () => {
    const installationId = installation("ambiguous");
    const stub = coordinator(installationId);
    const response = await stub.run(
      request(installationId, "throw_request"),
      entitlement(installationId),
    );

    expect((await events(response)).at(-1)).toMatchObject({
      type: "error",
      reason: "error",
    });
    const snapshot = await stub.inspect() as BudgetSnapshot;
    expect(snapshot.attempts[0]?.state).toBe("ambiguous");
    expect(snapshot.attempts[0]?.settled_microunits).toBe(
      snapshot.attempts[0]?.reserved_microunits,
    );
    expect(snapshot.periods[0]?.reserved_microunits).toBe(0);
  });

  it("rejects restricted entitlements and reservations above the budget", async () => {
    const installationId = installation("limits");
    const stub = coordinator(installationId);
    const restricted = await stub.run(
      request(installationId, "request_restricted"),
      { ...entitlement(installationId), state: "restricted", version: 2 },
    );
    expect(restricted.status).toBe(403);

    const exhausted = await stub.run(
      request(installationId, "request_exhausted"),
      { ...entitlement(installationId), inferenceBudgetMicrounits: 10 },
    );
    expect(exhausted.status).toBe(429);
    await expect(exhausted.json()).resolves.toMatchObject({ code: "monthly_budget" });
  });

  it("suspends active inference, blocks new work, and can recover", async () => {
    const installationId = installation("lifecycle");
    const stub = coordinator(installationId);
    const active = await stub.run(
      request(installationId, "request_before_suspend"),
      entitlement(installationId),
    );
    const lifecycle = {
      installationId,
      operationId: "deletion_inference_test",
      recoverableUntil: Date.now() + 60_000,
    };

    await expect(stub.suspendInstallation(lifecycle)).resolves.toEqual({ suspended: true });
    expect((await events(active)).at(-1)).toMatchObject({
      type: "error",
      reason: "aborted",
    });
    const blocked = await stub.run(
      request(installationId, "request_while_suspended"),
      entitlement(installationId),
    );
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      code: "installation_suspended",
    });

    await expect(stub.recoverInstallation({
      installationId,
      operationId: lifecycle.operationId,
    })).resolves.toEqual({ recovered: true });
    const recovered = await stub.run(
      request(installationId, "request_after_recovery"),
      entitlement(installationId),
    );
    expect(recovered.status).toBe(200);
    await events(recovered);
  });
});

function coordinator(installationId: string): DurableObjectStub<BudgetCoordinator> {
  const namespace = env.BUDGET_COORDINATOR as DurableObjectNamespace<BudgetCoordinator>;
  return namespace.get(namespace.idFromName(installationId));
}

function installation(label: string): string {
  return `inst_${label}_${crypto.randomUUID()}`;
}

function request(installationId: string, logicalRequestId: string) {
  return {
    version: 1 as const,
    installationId,
    logicalRequestId,
    actor: { localUid: 1000, processId: "proc:test", runId: "run:test" },
    model: MANAGED_INFERENCE_PRODUCT_MODEL,
    capability: "text" as const,
    messages: [{ role: "user" as const, content: "hello" }],
    maxOutputTokens: 128,
    reasoning: "high" as const,
    timeoutMs: 1_000,
  };
}

function entitlement(installationId: string) {
  const now = Date.now();
  return {
    installationId,
    state: "active" as const,
    planKey: "test",
    inferenceBudgetMicrounits: 5_000_000,
    inferencePeriodStartsAt: now - 60_000,
    inferencePeriodEndsAt: now + 30 * 24 * 60 * 60_000,
    storageLimitBytes: 10_000_000,
    effectiveAt: now - 60_000,
    version: 1,
  };
}

async function events(response: Response): Promise<Array<Record<string, unknown>>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
