import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TestHarness } from "wrangler";
import {
  MANAGED_INFERENCE_PRODUCT_MODEL,
  type ManagedInferenceService,
} from "@humansandmachines/gsv/protocol";
import { createManagedAccountTestHarness } from "./harness";
import {
  expectManagedRpc,
  expectManagedRpcOk,
  type HarnessWebSocket,
} from "./managed-rpc";

type AccountEnv = {
  ACCOUNT_DB: D1Database;
};

type FetchWorker = {
  fetch: ReturnType<TestHarness["getWorker"]>["fetch"];
};

type AccountExport = {
  projectEntitlement(input: {
    installationId: string;
    state: "trialing" | "active" | "restricted";
    planKey: string;
    inferenceBudgetMicrounits: number;
    inferencePeriodStartsAt: number;
    inferencePeriodEndsAt: number;
    storageLimitBytes: number;
    effectiveAt: number;
    version: number;
  }): Promise<unknown>;
  createInstallationOnboarding(installationId: string): Promise<{
    installationId: string;
    onboardingUrl: string;
    expiresAt: number;
  }>;
};

describe("managed account to Kernel integration", () => {
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

  it("lets a capability holder create the installation-owned login", async () => {
    const account = harness.getWorker<AccountEnv>("gsv-accounts-integration");
    const gateway = harness.getWorker("gsv-managed-account");
    const accountEnv = await account.getEnv();
    const suffix = randomUUID().slice(0, 8);
    const principalId = `principal_onboarding_e2e_${suffix}`;
    const accountToken = `gsvsession_${randomUUID()}${randomUUID()}`;
    const handle = `claim-${suffix}`;
    const now = Date.now();
    await accountEnv.ACCOUNT_DB.batch([
      accountEnv.ACCOUNT_DB.prepare(
        `INSERT INTO principals (
           id, primary_email, primary_email_normalized, display_name,
           email_verified_at, state, created_at, updated_at
         ) VALUES (?, ?, ?, 'Onboarding Owner', ?, 'active', ?, ?)`,
      ).bind(
        principalId,
        `onboarding-${suffix}@example.com`,
        `onboarding-${suffix}@example.com`,
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
    const reservation = await account.fetch(
      "https://accounts.gsv.space/api/installations",
      {
        method: "POST",
        headers: accountHeaders(accountCookie),
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          handle,
          ownerUsername: "platform-placeholder",
        }),
      },
    );
    expect(reservation.status, await reservation.clone().text()).toBe(201);
    const installationId = ((await reservation.json()) as {
      installation: { installationId: string };
    }).installation.installationId;
    const accountApi = await account.getExport() as unknown as AccountExport;
    await accountApi.projectEntitlement({
      installationId,
      state: "trialing",
      planKey: "integration-onboarding",
      inferenceBudgetMicrounits: 5_000_000,
      inferencePeriodStartsAt: now,
      inferencePeriodEndsAt: now + 30 * 24 * 60 * 60_000,
      storageLimitBytes: 10_000_000_000,
      effectiveAt: now,
      version: 1,
    });
    const onboarding = await accountApi.createInstallationOnboarding(installationId);
    expect(onboarding.onboardingUrl).toMatch(
      new RegExp(`^https://${handle}\\.gsv\\.space/onboarding#onboard_`),
    );
    const onboardingToken = new URL(onboarding.onboardingUrl).hash.slice(1);

    const shell = await gateway.fetch(`https://${handle}.gsv.space/onboarding`);
    expect(shell.status).toBe(200);
    const hiddenStorage = await gateway.fetch(
      `https://${handle}.gsv.space/public/not-for-onboarding.txt`,
    );
    expect(hiddenStorage.status).toBe(404);

    const setupSocketResponse = await gateway.fetch(
      `https://${handle}.gsv.space/ws`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(setupSocketResponse.status).toBe(101);
    const setupSocket = setupSocketResponse.webSocket;
    if (!setupSocket) throw new Error("Managed setup WebSocket was not created");
    setupSocket.accept();

    const unauthorized = await expectManagedRpc(
      setupSocket,
      "managed-setup-without-capability",
      "sys.setup",
      { username: "alice", password: "correct-horse-battery-staple" },
    );
    expect(unauthorized).toMatchObject({
      ok: false,
      error: {
        code: 401,
        message: "Installation setup link is invalid or expired",
      },
    });
    const setup = await expectManagedRpcOk(
      setupSocket,
      "managed-setup-with-capability",
      "sys.setup",
      {
        username: "alice",
        password: "correct-horse-battery-staple",
        onboardingToken,
        timezone: "Europe/Amsterdam",
      },
    );
    expect(setup.data).toMatchObject({
      user: { uid: 1000, username: "alice" },
    });
    setupSocket.close(1000, "setup complete");

    const installation = await accountEnv.ACCOUNT_DB.prepare(
      `SELECT i.state, m.local_uid, m.state AS membership_state
       FROM installations i
       JOIN memberships m ON m.installation_id = i.id
       WHERE i.id = ?`,
    ).bind(installationId).first<{
      state: string;
      local_uid: number | null;
      membership_state: string;
    }>();
    expect(installation).toEqual({
      state: "trialing",
      local_uid: null,
      membership_state: "pending",
    });
    const platformHandoff = await account.fetch(
      "https://accounts.gsv.space/api/installations/handoff",
      {
        method: "POST",
        headers: accountHeaders(accountCookie),
        body: JSON.stringify({ installationId }),
      },
    );
    expect(platformHandoff.status).toBe(400);

    const loginSocketResponse = await gateway.fetch(
      `https://${handle}.gsv.space/ws`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(loginSocketResponse.status).toBe(101);
    const loginSocket = loginSocketResponse.webSocket;
    if (!loginSocket) throw new Error("Managed login WebSocket was not created");
    loginSocket.accept();
    const connected = await expectManagedRpcOk(
      loginSocket,
      "managed-local-login",
      "sys.connect",
      {
        protocol: 2,
        client: {
          id: "managed-local-login",
          version: "1.0.0",
          platform: "integration",
          role: "user",
        },
        auth: {
          username: "alice",
          password: "correct-horse-battery-staple",
        },
      },
    );
    expect(connected.data).toMatchObject({
      identity: { process: { username: "alice" } },
    });
    loginSocket.close(1000, "test complete");
  });

  it("reserves, grants, provisions, leaves, and re-enters one real Kernel", async () => {
    const account = harness.getWorker<AccountEnv>("gsv-accounts-integration");
    const gateway = harness.getWorker("gsv-managed-account");
    const accountEnv = await account.getEnv();
    const suffix = randomUUID().slice(0, 8);
    const principalId = `principal_e2e_${suffix}`;
    const accountToken = `gsvsession_${randomUUID()}${randomUUID()}`;
    const now = Date.now();
    await accountEnv.ACCOUNT_DB.batch([
      accountEnv.ACCOUNT_DB.prepare(
        `INSERT INTO principals (
           id, primary_email, primary_email_normalized, display_name,
           email_verified_at, state, created_at, updated_at
         ) VALUES (?, ?, ?, 'E2E Owner', ?, 'active', ?, ?)`,
      ).bind(
        principalId,
        `e2e-${suffix}@example.com`,
        `e2e-${suffix}@example.com`,
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
    const handle = `e2e-${suffix}`;
    const kernelIdsBeforeReservation = await gateway.listDurableObjectIds("KERNEL");

    const reservation = await account.fetch("https://accounts.gsv.space/api/installations", {
      method: "POST",
      headers: accountHeaders(accountCookie),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        handle,
        ownerUsername: "owner",
        agentName: "companion",
        timezone: "Europe/Amsterdam",
      }),
    });
    expect(reservation.status, await reservation.clone().text()).toBe(201);
    const reservationBody = await reservation.json() as {
      installation: { installationId: string; state: string };
    };
    expect(reservationBody.installation.state).toBe("reserved");
    expect(await gateway.listDurableObjectIds("KERNEL")).toEqual(
      kernelIdsBeforeReservation,
    );
    const beforeGrant = await gateway.fetch(
      `https://${handle}.gsv.space/.well-known/oauth-client/gsv.json`,
    );
    expect(beforeGrant.status).toBe(404);
    expect(await gateway.listDurableObjectIds("KERNEL")).toEqual(
      kernelIdsBeforeReservation,
    );

    const accountApi = await account.getExport() as unknown as AccountExport;
    await accountApi.projectEntitlement({
      installationId: reservationBody.installation.installationId,
      state: "trialing",
      planKey: "integration-trial",
      inferenceBudgetMicrounits: 5_000_000,
      inferencePeriodStartsAt: Date.now(),
      inferencePeriodEndsAt: Date.now() + 30 * 24 * 60 * 60_000,
      storageLimitBytes: 10_000_000_000,
      effectiveAt: Date.now(),
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
    await expect(provision.json()).resolves.toMatchObject({
      installation: {
        installationId: reservationBody.installation.installationId,
        state: "trialing",
        operationState: "complete",
      },
    });
    expect(await gateway.listDurableObjectIds("KERNEL")).toHaveLength(
      kernelIdsBeforeReservation.length + 1,
    );

    const inference = await harness
      .getWorker("gsv-inference-integration")
      .getExport() as unknown as ManagedInferenceService;
    const inferenceResponse = await inference.run({
      version: 1,
      installationId: reservationBody.installation.installationId,
      logicalRequestId: `usage_${suffix}`,
      actor: { localUid: 1000, processId: "process_usage", runId: "run_usage" },
      model: MANAGED_INFERENCE_PRODUCT_MODEL,
      capability: "text",
      messages: [{ role: "user", content: "integration usage check" }],
      maxOutputTokens: 128,
      timeoutMs: 1_000,
    });
    expect(inferenceResponse.status).toBe(200);
    await inferenceResponse.text();
    const usage = await account.fetch(
      `https://accounts.gsv.space/api/installations/${reservationBody.installation.installationId}/usage`,
      { headers: { Cookie: accountCookie } },
    );
    expect(usage.status, await usage.clone().text()).toBe(200);
    const usageText = await usage.text();
    expect(usageText).not.toContain("Microunits");
    expect(usageText).not.toContain("provider");
    expect(JSON.parse(usageText)).toMatchObject({
      usage: {
        level: "normal",
        usedPercent: 0,
      },
    });

    const firstCookie = await enterInstallation(
      account,
      gateway,
      accountCookie,
      reservationBody.installation.installationId,
      handle,
    );
    await connectAsManagedOwner(gateway, handle, firstCookie, "first-entry", true);

    const logout = await gateway.fetch(`https://${handle}.gsv.space/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: firstCookie,
        Origin: `https://${handle}.gsv.space`,
      },
    });
    expect(logout.status).toBe(204);

    const secondCookie = await enterInstallation(
      account,
      gateway,
      accountCookie,
      reservationBody.installation.installationId,
      handle,
    );
    expect(secondCookie).not.toBe(firstCookie);
    const socket = await openManagedOwnerSocket(
      gateway,
      handle,
      secondCookie,
      "second-entry",
    );
    try {
      const added = await expectManagedRpcOk(socket, "schedule-add", "sched.add", {
        name: "managed lifecycle check",
        expression: { kind: "after", afterMs: 60_000 },
        target: { kind: "process.spawn", prompt: "Run the lifecycle check." },
      });
      const scheduleId = (added.data as { schedule: { id: string } }).schedule.id;

      await accountApi.projectEntitlement({
        installationId: reservationBody.installation.installationId,
        state: "restricted",
        planKey: "integration-trial",
        inferenceBudgetMicrounits: 0,
        inferencePeriodStartsAt: Date.now(),
        inferencePeriodEndsAt: Date.now() + 30 * 24 * 60 * 60_000,
        storageLimitBytes: 10_000_000_000,
        effectiveAt: Date.now(),
        version: 2,
      });

      const restrictedRun = await expectManagedRpcOk(
        socket,
        "schedule-restricted-run",
        "sched.run",
        { id: scheduleId, mode: "force" },
      );
      expect(restrictedRun.data).toMatchObject({
        ran: 0,
        results: [{
          status: "skipped",
          error: "installation entitlement does not allow scheduled work",
        }],
      });
      await expect(expectManagedRpc(
        socket,
        "schedule-restricted-add",
        "sched.add",
        {
          name: "blocked schedule",
          expression: { kind: "after", afterMs: 60_000 },
          target: { kind: "process.spawn", prompt: "Do not run." },
        },
      )).resolves.toMatchObject({
        ok: false,
        error: { message: "installation entitlement does not allow scheduled work" },
      });

      await accountApi.projectEntitlement({
        installationId: reservationBody.installation.installationId,
        state: "active",
        planKey: "integration-trial",
        inferenceBudgetMicrounits: 5_000_000,
        inferencePeriodStartsAt: Date.now(),
        inferencePeriodEndsAt: Date.now() + 30 * 24 * 60 * 60_000,
        storageLimitBytes: 10_000_000_000,
        effectiveAt: Date.now(),
        version: 3,
      });
      const restoredRun = await expectManagedRpcOk(
        socket,
        "schedule-restored-run",
        "sched.run",
        { id: scheduleId, mode: "force" },
      );
      expect(restoredRun.data).toMatchObject({
        ran: 1,
        results: [{ status: "ok" }],
      });
      const restoredResult = (restoredRun.data as {
        results: Array<{ summary?: string }>;
      }).results[0];
      const spawnedPid = restoredResult?.summary?.replace(/^spawned process /, "");
      if (!spawnedPid || spawnedPid === restoredResult?.summary) {
        throw new Error("Restored schedule did not report its process");
      }
      await expectManagedRpcOk(socket, "schedule-process-kill", "proc.kill", {
        pid: spawnedPid,
        archive: false,
      });
      await expectManagedRpcOk(socket, "schedule-remove", "sched.remove", {
        id: scheduleId,
      });
    } finally {
      socket.close(1000, "test complete");
    }
  });

  it("isolates hostile installations that deliberately reuse local identifiers", async () => {
    const account = harness.getWorker<AccountEnv>("gsv-accounts-integration");
    const gateway = harness.getWorker("gsv-managed-account");
    const accountEnv = await account.getEnv();
    const accountApi = await account.getExport() as unknown as AccountExport;
    const suffix = randomUUID().slice(0, 8);
    const first = await provisionIsolationFixture(
      account,
      accountEnv,
      accountApi,
      `isolation-a-${suffix}`,
    );
    const second = await provisionIsolationFixture(
      account,
      accountEnv,
      accountApi,
      `isolation-b-${suffix}`,
    );

    const firstList = await account.fetch(
      "https://accounts.gsv.space/api/installations",
      { headers: { Cookie: first.accountCookie } },
    );
    await expect(firstList.json()).resolves.toMatchObject({
      installations: [{ installationId: first.installationId }],
    });
    const foreignHandoff = await account.fetch(
      "https://accounts.gsv.space/api/installations/handoff",
      {
        method: "POST",
        headers: accountHeaders(first.accountCookie),
        body: JSON.stringify({ installationId: second.installationId }),
      },
    );
    expect(foreignHandoff.status).toBe(400);
    await expect(foreignHandoff.json()).resolves.toEqual({
      error: "Authentication failed",
    });

    const firstCookie = await enterInstallation(
      account,
      gateway,
      first.accountCookie,
      first.installationId,
      first.handle,
    );
    const secondCookie = await enterInstallation(
      account,
      gateway,
      second.accountCookie,
      second.installationId,
      second.handle,
    );
    const firstSocket = await openManagedOwnerSocket(
      gateway,
      first.handle,
      firstCookie,
      `isolation-first-${suffix}`,
    );
    const secondSocket = await openManagedOwnerSocket(
      gateway,
      second.handle,
      secondCookie,
      `isolation-second-${suffix}`,
    );
    try {
      const commonPath = "/tmp/isolation-proof.txt";
      await expectManagedRpcOk(firstSocket, "isolation-write-first", "fs.write", {
        path: commonPath,
        content: `isolation-proof first-${suffix}`,
      });
      await expectManagedRpcOk(secondSocket, "isolation-write-second", "fs.write", {
        path: commonPath,
        content: `isolation-proof second-${suffix}`,
      });
      const firstSearch = await expectManagedRpcOk(
        firstSocket,
        "isolation-search-first",
        "fs.search",
        { path: "/tmp", query: "isolation-proof" },
      );
      const secondSearch = await expectManagedRpcOk(
        secondSocket,
        "isolation-search-second",
        "fs.search",
        { path: "/tmp", query: "isolation-proof" },
      );
      expect(JSON.stringify(firstSearch.data)).toContain(`first-${suffix}`);
      expect(JSON.stringify(firstSearch.data)).not.toContain(`second-${suffix}`);
      expect(JSON.stringify(secondSearch.data)).toContain(`second-${suffix}`);
      expect(JSON.stringify(secondSearch.data)).not.toContain(`first-${suffix}`);

      const firstSpawn = await expectManagedRpcOk(
        firstSocket,
        "isolation-spawn-first",
        "proc.spawn",
        { label: "same local process", interactive: true },
      );
      const secondSpawn = await expectManagedRpcOk(
        secondSocket,
        "isolation-spawn-second",
        "proc.spawn",
        { label: "same local process", interactive: true },
      );
      const firstPid = (firstSpawn.data as { pid: string }).pid;
      const secondPid = (secondSpawn.data as { pid: string }).pid;
      const firstProcesses = await expectManagedRpcOk(
        firstSocket,
        "isolation-list-first",
        "proc.list",
        {},
      );
      const secondProcesses = await expectManagedRpcOk(
        secondSocket,
        "isolation-list-second",
        "proc.list",
        {},
      );
      expect(firstProcesses.data).toMatchObject({
        processes: [expect.objectContaining({
          pid: firstPid,
          uid: 1000,
          username: "companion",
          label: "same local process",
        })],
      });
      expect(JSON.stringify(firstProcesses.data)).not.toContain(secondPid);
      expect(secondProcesses.data).toMatchObject({
        processes: [expect.objectContaining({
          pid: secondPid,
          uid: 1000,
          username: "companion",
          label: "same local process",
        })],
      });
      expect(JSON.stringify(secondProcesses.data)).not.toContain(firstPid);

      await expect(expectManagedRpc(
        secondSocket,
        "isolation-foreign-process",
        "proc.history",
        { pid: firstPid },
      )).resolves.toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("not found") },
      });

      const crossHost = await gateway.fetch(
        `https://${second.handle}.gsv.space/ws`,
        {
          headers: { Upgrade: "websocket", Cookie: firstCookie },
        },
      );
      expect(crossHost.status).toBe(101);
      const crossSocket = crossHost.webSocket;
      if (!crossSocket) throw new Error("Cross-host WebSocket was not created");
      crossSocket.accept();
      await expect(expectManagedRpc(
        crossSocket,
        "isolation-cross-host-session",
        "sys.connect",
        {
          protocol: 2,
          client: {
            id: "isolation-cross-host",
            version: "1.0.0",
            platform: "integration",
            role: "user",
          },
        },
      )).resolves.toMatchObject({
        ok: false,
        error: { code: 401, message: "Authentication required" },
      });
      crossSocket.close(1000, "cross-host rejection complete");

      await expectManagedRpcOk(firstSocket, "isolation-kill-first", "proc.kill", {
        pid: firstPid,
        archive: false,
      });
      await expectManagedRpcOk(secondSocket, "isolation-kill-second", "proc.kill", {
        pid: secondPid,
        archive: false,
      });
    } finally {
      firstSocket.close(1000, "test complete");
      secondSocket.close(1000, "test complete");
    }
  });
});

async function provisionIsolationFixture(
  account: FetchWorker,
  accountEnv: AccountEnv,
  accountApi: AccountExport,
  handle: string,
): Promise<{
  accountCookie: string;
  installationId: string;
  handle: string;
}> {
  const principalId = `principal_${handle}`;
  const token = `gsvsession_${randomUUID()}${randomUUID()}`;
  const now = Date.now();
  await accountEnv.ACCOUNT_DB.batch([
    accountEnv.ACCOUNT_DB.prepare(
      `INSERT INTO principals (
         id, primary_email, primary_email_normalized, display_name,
         email_verified_at, state, created_at, updated_at
       ) VALUES (?, ?, ?, 'Isolation owner', ?, 'active', ?, ?)`,
    ).bind(
      principalId,
      `${handle}@example.com`,
      `${handle}@example.com`,
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
      sha256Hex(token),
      principalId,
      now,
      now + 30 * 24 * 60 * 60_000,
      now,
    ),
  ]);
  const accountCookie = `__Host-gsv-account-session=${encodeURIComponent(token)}`;
  const reservation = await account.fetch(
    "https://accounts.gsv.space/api/installations",
    {
      method: "POST",
      headers: accountHeaders(accountCookie),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        handle,
        ownerUsername: "owner",
        agentName: "companion",
        timezone: "Europe/Amsterdam",
      }),
    },
  );
  expect(reservation.status, await reservation.clone().text()).toBe(201);
  const installationId = ((await reservation.json()) as {
    installation: { installationId: string };
  }).installation.installationId;
  await accountApi.projectEntitlement({
    installationId,
    state: "active",
    planKey: "integration-isolation",
    inferenceBudgetMicrounits: 5_000_000,
    inferencePeriodStartsAt: now,
    inferencePeriodEndsAt: now + 30 * 24 * 60 * 60_000,
    storageLimitBytes: 10_000_000_000,
    effectiveAt: now,
    version: 1,
  });
  const provision = await account.fetch(
    `https://accounts.gsv.space/api/installations/${installationId}/provision`,
    {
      method: "POST",
      headers: accountHeaders(accountCookie),
      body: "{}",
    },
  );
  expect(provision.status, await provision.clone().text()).toBe(200);
  return { accountCookie, installationId, handle };
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
  expect(handoffBody.action).toBe(`https://${handle}.gsv.space/auth/handoff`);

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
  expect(setCookie).toContain("__Host-gsv-session=");
  if (!setCookie) throw new Error("Managed handoff did not set a session cookie");
  return setCookie.split(";", 1)[0]!;
}

async function connectAsManagedOwner(
  gateway: FetchWorker,
  handle: string,
  cookie: string,
  id: string,
  runInference = false,
): Promise<void> {
  const socket = await openManagedOwnerSocket(gateway, handle, cookie, id);
  if (runInference) {
    await runManagedInference(socket);
  }
  socket.close(1000, "test complete");
}

async function openManagedOwnerSocket(
  gateway: FetchWorker,
  handle: string,
  cookie: string,
  id: string,
): Promise<HarnessWebSocket> {
  const response = await gateway.fetch(`https://${handle}.gsv.space/ws`, {
    headers: {
      Upgrade: "websocket",
      Cookie: cookie,
    },
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

async function runManagedInference(socket: HarnessWebSocket): Promise<void> {
  const spawned = await expectManagedRpcOk(socket, "managed-proc-spawn", "proc.spawn", {
    label: "managed inference integration",
    interactive: true,
  });
  const pid = (spawned.data as { pid: string }).pid;

  const signals: Array<{ signal: string; payload?: Record<string, unknown> }> = [];
  const eventSocket = socket as unknown as {
    addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
    removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  };
  const onMessage = (event: { data: unknown }) => {
    if (typeof event.data !== "string") return;
    const frame = JSON.parse(event.data) as {
      type?: string;
      signal?: string;
      payload?: Record<string, unknown>;
    };
    if (frame.type === "sig" && typeof frame.signal === "string") {
      signals.push({ signal: frame.signal, payload: frame.payload });
    }
  };
  eventSocket.addEventListener("message", onMessage);
  try {
    const sent = await expectManagedRpcOk(socket, "managed-proc-send", "proc.send", {
      pid,
      message: "answer through bundled intelligence",
    });
    const runId = (sent.data as { runId: string }).runId;
    await vi.waitFor(() => {
      expect(signals.some((signal) =>
        signal.signal === "proc.run.retrying" && signal.payload?.runId === runId
      )).toBe(true);
      expect(signals.some((signal) =>
        signal.signal === "proc.run.finished"
        && signal.payload?.runId === runId
        && signal.payload?.status === "ok"
      )).toBe(true);
    }, { timeout: 5_000 });

    const history = await expectManagedRpcOk(
      socket,
      "managed-proc-history",
      "proc.history",
      { pid },
    );
    expect(history.data).toMatchObject({
      ok: true,
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: "synthetic managed response",
          metadata: expect.objectContaining({
            provider: expect.objectContaining({
              provider: "gsv",
              model: "gsv/default",
            }),
          }),
        }),
      ]),
    });
  } finally {
    eventSocket.removeEventListener("message", onMessage);
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
