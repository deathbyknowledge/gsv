import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestHarness } from "wrangler";
import { createManagedAccountTestHarness } from "./harness";
import { expectManagedRpcOk } from "./managed-rpc";

type AccountEnv = {
  ACCOUNT_DB: D1Database;
};

type FetchWorker = {
  fetch: ReturnType<TestHarness["getWorker"]>["fetch"];
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
    expect(await gateway.listDurableObjectIds("KERNEL")).toEqual([]);
    const beforeGrant = await gateway.fetch(
      `https://${handle}.gsv.space/.well-known/oauth-client/gsv.json`,
    );
    expect(beforeGrant.status).toBe(404);
    expect(await gateway.listDurableObjectIds("KERNEL")).toEqual([]);

    const accountApi = await account.getExport() as unknown as {
      projectEntitlement(input: {
        installationId: string;
        state: "trialing";
        planKey: string;
        inferenceBudgetMicrounits: number;
        storageLimitBytes: number;
        effectiveAt: number;
        version: number;
      }): Promise<unknown>;
    };
    await accountApi.projectEntitlement({
      installationId: reservationBody.installation.installationId,
      state: "trialing",
      planKey: "integration-trial",
      inferenceBudgetMicrounits: 5_000_000,
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
    expect(await gateway.listDurableObjectIds("KERNEL")).toHaveLength(1);

    const firstCookie = await enterInstallation(
      account,
      gateway,
      accountCookie,
      reservationBody.installation.installationId,
      handle,
    );
    await connectAsManagedOwner(gateway, handle, firstCookie, "first-entry");

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
    await connectAsManagedOwner(gateway, handle, secondCookie, "second-entry");
  });
});

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
): Promise<void> {
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
  socket.close(1000, "test complete");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
