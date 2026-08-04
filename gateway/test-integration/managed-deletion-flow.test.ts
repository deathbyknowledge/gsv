import { createHash, randomUUID } from "node:crypto";
import type { ManagedGatewayDataLifecycleInterface } from "@humansandmachines/gsv/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TestHarness } from "wrangler";
import { createManagedAccountTestHarness } from "./harness";
import {
  expectManagedRpcOk,
  type HarnessWebSocket,
} from "./managed-rpc";

type AccountEnv = {
  ACCOUNT_DB: D1Database;
  GATEWAY: ManagedGatewayDataLifecycleInterface;
};
type GatewayEnv = { STORAGE: R2Bucket };
type HarnessWorker = ReturnType<TestHarness["getWorker"]>;
type FetchWorker = { fetch: HarnessWorker["fetch"] };
type AccountWorker = FetchWorker & {
  getEnv(): Promise<AccountEnv>;
  getExport(): Promise<unknown>;
};
type AccountApi = {
  projectEntitlement(input: {
    installationId: string;
    state: "active" | "retained";
    planKey: string;
    inferenceBudgetMicrounits: number;
    inferencePeriodStartsAt: number;
    inferencePeriodEndsAt: number;
    storageLimitBytes: number;
    effectiveAt: number;
    version: number;
  }): Promise<unknown>;
  scheduled(): Promise<void>;
};

describe("managed installation deletion integration", () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = createManagedAccountTestHarness();
    await harness.listen();
    await harness.getWorker<AccountEnv>("gsv-accounts-integration")
      .applyD1Migrations("ACCOUNT_DB");
  });

  afterAll(async () => {
    await harness.close();
  });

  it("suspends a live installation and restores its process and inference state", async () => {
    const account = harness.getWorker<AccountEnv>("gsv-accounts-integration");
    const gateway = harness.getWorker("gsv-managed-account");
    const fixture = await provisionInstallation(account);
    const installationCookie = await enterInstallation(
      account,
      gateway,
      fixture.accountCookie,
      fixture.installationId,
      fixture.handle,
    );
    const socket = await openManagedOwnerSocket(
      gateway,
      fixture.handle,
      installationCookie,
      "deletion-live",
    );
    const pid = await runManagedInference(socket);
    const closed = webSocketClosed(socket);

    const deletion = await account.fetch(
      `https://accounts.gsv.space/api/installations/${fixture.installationId}/deletion`,
      {
        method: "POST",
        headers: accountHeaders(fixture.accountCookie),
        body: JSON.stringify({
          confirmedHandle: fixture.handle,
          idempotencyKey: randomUUID(),
        }),
      },
    );
    expect(deletion.status, await deletion.clone().text()).toBe(202);
    const deletionBody = await deletion.json() as {
      deletion: {
        operationId: string;
        state: string;
        recoverableUntil: number;
      };
    };
    expect(deletionBody.deletion).toMatchObject({
      state: "recoverable",
    });
    expect(deletionBody.deletion.recoverableUntil).toBeGreaterThan(Date.now());
    await closed;

    const retiredRoute = await gateway.fetch(
      `https://${fixture.handle}.gsv.space/.well-known/oauth-client/gsv.json`,
    );
    expect(retiredRoute.status).toBe(404);
    const status = await account.fetch(
      `https://accounts.gsv.space/api/installations/${fixture.installationId}/deletion`,
      { headers: { Cookie: fixture.accountCookie } },
    );
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      deletion: {
        operationId: deletionBody.deletion.operationId,
        state: "recoverable",
      },
    });

    const recovered = await account.fetch(
      `https://accounts.gsv.space/api/installations/${fixture.installationId}/deletion/recover`,
      {
        method: "POST",
        headers: accountHeaders(fixture.accountCookie),
        body: "{}",
      },
    );
    expect(recovered.status, await recovered.clone().text()).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({
      deletion: {
        operationId: deletionBody.deletion.operationId,
        state: "recovered",
      },
    });
    const restoredRoute = await gateway.fetch(
      `https://${fixture.handle}.gsv.space/.well-known/oauth-client/gsv.json`,
    );
    expect(restoredRoute.status).toBe(200);

    const restoredSocket = await openManagedOwnerSocket(
      gateway,
      fixture.handle,
      installationCookie,
      "deletion-restored",
    );
    try {
      const history = await expectManagedRpcOk(
        restoredSocket,
        "deletion-history",
        "proc.history",
        { pid },
      );
      expect(history.data).toMatchObject({
        ok: true,
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            content: "synthetic managed response",
          }),
        ]),
      });
      await sendManagedInference(restoredSocket, pid, "after-recovery");
      await expectManagedRpcOk(restoredSocket, "deletion-kill", "proc.kill", {
        pid,
        archive: false,
      });
    } finally {
      restoredSocket.close(1000, "test complete");
    }
  });

  it("deletes every retained resource owner in bounded, retryable batches", async () => {
    const account = harness.getWorker<AccountEnv>("gsv-accounts-integration");
    const gateway = harness.getWorker<GatewayEnv>("gsv-managed-account");
    const dependencies = harness.getWorker("gsv-test-dependencies");
    const fixture = await provisionInstallation(account);
    const installationCookie = await enterInstallation(
      account,
      gateway,
      fixture.accountCookie,
      fixture.installationId,
      fixture.handle,
    );
    const socket = await openManagedOwnerSocket(
      gateway,
      fixture.handle,
      installationCookie,
      "retention-live",
    );
    await runManagedInference(socket);
    await expectManagedRpcOk(socket, "retention-write", "fs.write", {
      path: "/tmp/retention-delete.txt",
      content: "delete this installation object",
    });
    const gatewayEnv = await gateway.getEnv();
    const storagePrefix = `installations/${encodeURIComponent(fixture.installationId)}/`;
    expect((await gatewayEnv.STORAGE.list({ prefix: storagePrefix })).objects.length)
      .toBeGreaterThan(0);
    const closed = webSocketClosed(socket);

    const now = Date.now();
    const accountApi = await account.getExport() as unknown as AccountApi;
    await accountApi.projectEntitlement({
      installationId: fixture.installationId,
      state: "retained",
      planKey: "integration-deletion",
      inferenceBudgetMicrounits: 0,
      inferencePeriodStartsAt: now - 30 * 24 * 60 * 60_000,
      inferencePeriodEndsAt: now - 1,
      storageLimitBytes: 10_000_000_000,
      effectiveAt: now,
      version: 2,
    });
    const accountEnv = await account.getEnv();
    const billingAccountId = `billing_retention_${randomUUID()}`;
    await accountEnv.ACCOUNT_DB.batch([
      accountEnv.ACCOUNT_DB.prepare(
        `INSERT INTO billing_accounts (
           id, principal_id, provider, provider_customer_id,
           created_at, updated_at
         ) VALUES (?, ?, 'stripe', ?, ?, ?)`,
      ).bind(
        billingAccountId,
        fixture.principalId,
        `cus_retention_${randomUUID()}`,
        now,
        now,
      ),
      accountEnv.ACCOUNT_DB.prepare(
        `INSERT INTO subscriptions (
           id, billing_account_id, installation_id, provider_subscription_id,
           price_key, state, provider_state, provider_observed_at,
           provider_snapshot_hash, current_period_starts_at,
           current_period_ends_at, cancel_at_period_end, paid_through,
           grace_ends_at, retention_ends_at, entitlement_version,
           entitlement_effective_at, entitlement_json,
           last_reconciled_at, updated_at
         ) VALUES (?, ?, ?, ?, 'founding-monthly', 'retained', 'cancelled', ?,
                   ?, ?, ?, 0, ?, NULL, ?, 1, ?, ?, ?, ?)`,
      ).bind(
        `subscription_retention_${randomUUID()}`,
        billingAccountId,
        fixture.installationId,
        `sub_retention_${randomUUID()}`,
        now,
        "d".repeat(64),
        now - 30 * 24 * 60 * 60_000,
        now - 1,
        now - 1,
        now - 1,
        now,
        JSON.stringify({
          state: "retained",
          planKey: "integration-deletion",
          inferenceBudgetMicrounits: 0,
          inferencePeriodStartsAt: now - 30 * 24 * 60 * 60_000,
          inferencePeriodEndsAt: now - 1,
          storageLimitBytes: 10_000_000_000,
        }),
        now,
        now,
      ),
    ]);

    let deletionState: string | null = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await accountApi.scheduled();
      const operation = await accountEnv.ACCOUNT_DB.prepare(
        `SELECT state
         FROM installation_deletion_operations
         WHERE installation_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      ).bind(fixture.installationId).first<{ state: string }>();
      deletionState = operation?.state ?? null;
      if (deletionState === "complete") break;
    }
    expect(deletionState).toBe("complete");
    await closed;

    const operation = await accountEnv.ACCOUNT_DB.prepare(
      `SELECT operation_id, recoverable_until
       FROM installation_deletion_operations
       WHERE installation_id = ? AND state = 'complete'
       LIMIT 1`,
    ).bind(fixture.installationId).first<{
      operation_id: string;
      recoverable_until: number;
    }>();
    if (!operation) throw new Error("Completed deletion operation was not persisted");
    expect(await accountEnv.GATEWAY.deleteManagedInstallationResourceBatch({
      installationId: fixture.installationId,
      operationId: operation.operation_id,
      recoverableUntil: operation.recoverable_until,
    })).toMatchObject({ stage: "complete", complete: true });

    const installation = await accountEnv.ACCOUNT_DB.prepare(
      "SELECT state, deleted_at FROM installations WHERE id = ?",
    ).bind(fixture.installationId).first<{
      state: string;
      deleted_at: number | null;
    }>();
    expect(installation?.state).toBe("deleted");
    expect(installation?.deleted_at).not.toBeNull();
    const membership = await accountEnv.ACCOUNT_DB.prepare(
      "SELECT COUNT(*) AS count FROM memberships WHERE installation_id = ?",
    ).bind(fixture.installationId).first<{ count: number }>();
    expect(membership?.count).toBe(0);
    expect((await gatewayEnv.STORAGE.list({ prefix: storagePrefix })).objects).toEqual([]);
    const deletedRepositories = await dependencies.fetch(
      "https://dependencies.invalid/__test/deleted-repositories",
    );
    expect(await deletedRepositories.json()).toEqual(expect.arrayContaining([
      "/owner/home",
      "/root/home",
    ]));
    const retiredRoute = await gateway.fetch(
      `https://${fixture.handle}.gsv.space/.well-known/oauth-client/gsv.json`,
    );
    expect(retiredRoute.status).toBe(404);
  });
});

async function provisionInstallation(account: AccountWorker): Promise<{
  accountCookie: string;
  principalId: string;
  installationId: string;
  handle: string;
}> {
  const accountEnv = await account.getEnv();
  const suffix = randomUUID().slice(0, 8);
  const principalId = `principal_deletion_${suffix}`;
  const accountToken = `gsvsession_${randomUUID()}${randomUUID()}`;
  const now = Date.now();
  await accountEnv.ACCOUNT_DB.batch([
    accountEnv.ACCOUNT_DB.prepare(
      `INSERT INTO principals (
         id, primary_email, primary_email_normalized, display_name,
         email_verified_at, state, created_at, updated_at
       ) VALUES (?, ?, ?, 'Deletion Owner', ?, 'active', ?, ?)`,
    ).bind(
      principalId,
      `deletion-${suffix}@example.com`,
      `deletion-${suffix}@example.com`,
      now,
      now,
      now,
    ),
    accountEnv.ACCOUNT_DB.prepare(
      `INSERT INTO sessions (
         id_hash, principal_id, created_at, expires_at, recent_auth_at,
         revoked_at, ip_hash, user_agent, auth_method
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'integration', 'passkey')`,
    ).bind(
      sha256Hex(accountToken),
      principalId,
      now,
      now + 30 * 24 * 60 * 60_000,
      now,
    ),
  ]);
  const accountCookie = `__Host-gsv-account-session=${encodeURIComponent(accountToken)}`;
  const handle = `deletion-${suffix}`;
  const reservation = await account.fetch(
    "https://accounts.gsv.space/api/installations",
    {
      method: "POST",
      headers: accountHeaders(accountCookie),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        handle,
        ownerUsername: "owner",
      }),
    },
  );
  expect(reservation.status, await reservation.clone().text()).toBe(201);
  const reservationBody = await reservation.json() as {
    installation: { installationId: string };
  };
  const accountApi = await account.getExport() as unknown as AccountApi;
  await accountApi.projectEntitlement({
    installationId: reservationBody.installation.installationId,
    state: "active",
    planKey: "integration-deletion",
    inferenceBudgetMicrounits: 5_000_000,
    inferencePeriodStartsAt: now,
    inferencePeriodEndsAt: now + 30 * 24 * 60 * 60_000,
    storageLimitBytes: 10_000_000_000,
    effectiveAt: now,
    version: 1,
  });
  const provision = await account.fetch(
    `https://accounts.gsv.space/api/installations/${reservationBody.installation.installationId}/provision`,
    {
      method: "POST",
      headers: accountHeaders(accountCookie),
      body: "{}",
    },
  );
  expect(provision.status, await provision.clone().text()).toBe(200);
  return {
    accountCookie,
    principalId,
    installationId: reservationBody.installation.installationId,
    handle,
  };
}

function accountHeaders(cookie: string): Record<string, string> {
  return {
    Cookie: cookie,
    Origin: "https://accounts.gsv.space",
    "Content-Type": "application/json",
  };
}

async function enterInstallation(
  account: FetchWorker,
  gateway: FetchWorker,
  accountCookie: string,
  installationId: string,
  handle: string,
): Promise<string> {
  const handoff = await account.fetch(
    "https://accounts.gsv.space/api/installations/handoff",
    {
      method: "POST",
      headers: accountHeaders(accountCookie),
      body: JSON.stringify({ installationId }),
    },
  );
  expect(handoff.status, await handoff.clone().text()).toBe(200);
  const handoffBody = await handoff.json() as { action: string; token: string };
  const exchange = await gateway.fetch(handoffBody.action, {
    method: "POST",
    redirect: "manual",
    headers: {
      Origin: "https://accounts.gsv.space",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token: handoffBody.token }).toString(),
  });
  expect(exchange.status, await exchange.clone().text()).toBe(303);
  const setCookie = exchange.headers.get("set-cookie");
  if (!setCookie) throw new Error(`Managed handoff for ${handle} did not set a cookie`);
  return setCookie.split(";", 1)[0]!;
}

async function openManagedOwnerSocket(
  gateway: FetchWorker,
  handle: string,
  cookie: string,
  id: string,
): Promise<HarnessWebSocket> {
  const response = await gateway.fetch(`https://${handle}.gsv.space/ws`, {
    headers: { Upgrade: "websocket", Cookie: cookie },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("Managed WebSocket was not created");
  socket.accept();
  await expectManagedRpcOk(socket, id, "sys.connect", {
    protocol: 2,
    client: {
      id,
      version: "1.0.0",
      platform: "integration",
      role: "user",
    },
  });
  return socket;
}

async function runManagedInference(socket: HarnessWebSocket): Promise<string> {
  const spawned = await expectManagedRpcOk(socket, "deletion-spawn", "proc.spawn", {
    label: "deletion recovery integration",
    interactive: true,
  });
  const pid = (spawned.data as { pid: string }).pid;
  await sendManagedInference(socket, pid, "before-deletion");
  return pid;
}

async function sendManagedInference(
  socket: HarnessWebSocket,
  pid: string,
  id: string,
): Promise<void> {
  const finishedRuns = new Set<string>();
  const eventSocket = socket as unknown as {
    addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
    removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  };
  const onMessage = (event: { data: unknown }) => {
    if (typeof event.data !== "string") return;
    const frame = JSON.parse(event.data) as {
      type?: string;
      signal?: string;
      payload?: { runId?: string; status?: string };
    };
    if (
      frame.type === "sig"
      && frame.signal === "proc.run.finished"
      && frame.payload?.status === "ok"
      && frame.payload.runId
    ) {
      finishedRuns.add(frame.payload.runId);
    }
  };
  eventSocket.addEventListener("message", onMessage);
  try {
    const sent = await expectManagedRpcOk(socket, `${id}-send`, "proc.send", {
      pid,
      message: id,
    });
    const runId = (sent.data as { runId: string }).runId;
    await vi.waitFor(() => expect(finishedRuns.has(runId)).toBe(true), {
      timeout: 5_000,
    });
  } finally {
    eventSocket.removeEventListener("message", onMessage);
  }
}

function webSocketClosed(socket: HarnessWebSocket): Promise<void> {
  const eventSocket = socket as unknown as {
    addEventListener(type: "close", listener: () => void, options?: { once?: boolean }): void;
  };
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Managed WebSocket was not closed for deletion")),
      5_000,
    );
    eventSocket.addEventListener("close", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
