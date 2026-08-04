import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TestHarness } from "wrangler";
import { createManagedTelegramTestHarness } from "./harness";

type AccountEnv = { ACCOUNT_DB: D1Database };
type HarnessWorker = ReturnType<TestHarness["getWorker"]>;
type FetchWorker = { fetch: HarnessWorker["fetch"] };
type ExportWorker = FetchWorker & { getExport(): Promise<unknown> };

type TelegramApiCall = {
  method: string;
  payload: Record<string, unknown>;
  messageId: number;
};

describe("managed Telegram clean-instance integration", () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = createManagedTelegramTestHarness();
    await harness.listen();
    await harness.getWorker<AccountEnv>("gsv-accounts-integration")
      .applyD1Migrations("ACCOUNT_DB");
  });

  afterAll(async () => {
    await harness.close();
  });

  it("links in the browser, routes one DM, and rejects another installation", async () => {
    const account = harness.getWorker<AccountEnv>("gsv-accounts-integration");
    const gateway = harness.getWorker("gsv-managed-telegram-gateway");
    const inference = harness.getWorker("gsv-inference-integration");
    const telegram = harness.getWorker("gsv-managed-telegram-integration");
    const dependencies = harness.getWorker("gsv-test-dependencies");
    const principal = await createAccountSession(await account.getEnv());
    const installation = await provisionInstallation(
      account,
      principal.cookie,
    );
    expect(await inference.listDurableObjectIds("BUDGET_COORDINATOR")).toEqual([]);

    const unlinked = await telegram.fetch("https://telegram.gsv.space/webhook", {
      method: "POST",
      headers: telegramWebhookHeaders(),
      body: JSON.stringify(telegramUpdate(1, "hello before linking")),
    });
    expect(unlinked.status, await unlinked.clone().text()).toBe(200);

    const linkCall = await waitForTelegramCall(
      dependencies,
      (call) => call.method === "sendMessage"
        && getButtonUrl(call.payload) !== null,
    );
    const claimUrl = new URL(getButtonUrl(linkCall.payload)!);
    expect(claimUrl.origin).toBe("https://accounts.gsv.space");
    expect(claimUrl.pathname).toBe("/telegram");
    expect(claimUrl.search).toBe("");
    const claimToken = new URLSearchParams(claimUrl.hash.slice(1)).get("claim");
    expect(claimToken).toBeTruthy();
    expect(await inference.listDurableObjectIds("BUDGET_COORDINATOR")).toEqual([]);
    expect((await telegramApiCalls(dependencies))).toHaveLength(1);

    const inspected = await account.fetch(
      "https://accounts.gsv.space/api/telegram/claims/inspect",
      {
        method: "POST",
        headers: accountHeaders(principal.cookie),
        body: JSON.stringify({ claimToken }),
      },
    );
    expect(inspected.status, await inspected.clone().text()).toBe(200);
    const inspectedText = await inspected.text();
    expect(inspectedText).not.toContain(claimToken!);
    expect(JSON.parse(inspectedText)).toMatchObject({
      result: {
        ok: true,
        claim: { linked: false },
        installations: [{
          installationId: installation.installationId,
          handle: installation.handle,
        }],
      },
    });

    const confirmed = await account.fetch(
      "https://accounts.gsv.space/api/telegram/claims/confirm",
      {
        method: "POST",
        headers: accountHeaders(principal.cookie),
        body: JSON.stringify({
          claimToken,
          installationId: installation.installationId,
          idempotencyKey: randomUUID(),
        }),
      },
    );
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    await expect(confirmed.json()).resolves.toMatchObject({
      link: {
        state: "active",
        actorId: "777001",
        installation: {
          installationId: installation.installationId,
        },
      },
    });
    await waitForTelegramCall(
      dependencies,
      (call) => telegramText(call) === `Connected to ${installation.canonicalOrigin}`,
    );

    const crossInstallation = await dependencies.fetch(
      "https://dependencies.invalid/__test/telegram-send",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          installationId: "inst_not_the_owner",
          accountId: "managed",
          message: {
            deliveryId: "cross-installation-probe",
            surface: { kind: "dm", id: "777001" },
            actorId: "777001",
            text: "must not be delivered",
          },
        }),
      },
    );
    expect(crossInstallation.status).toBe(200);
    await expect(crossInstallation.json()).resolves.toMatchObject({ ok: false });

    const linked = await telegram.fetch("https://telegram.gsv.space/webhook", {
      method: "POST",
      headers: telegramWebhookHeaders(),
      body: JSON.stringify(telegramUpdate(2, "answer through my GSV")),
    });
    expect(linked.status, await linked.clone().text()).toBe(200);
    await waitForTelegramCall(
      dependencies,
      (call) => telegramText(call) === "synthetic managed response",
    );
    expect(await inference.listDurableObjectIds("BUDGET_COORDINATOR"))
      .toHaveLength(1);

    const calls = await telegramApiCalls(dependencies);
    expect(calls.some((call) => telegramText(call) === "must not be delivered"))
      .toBe(false);
    expect(await gateway.listDurableObjectIds("KERNEL")).toHaveLength(1);
  });
});

async function createAccountSession(env: AccountEnv): Promise<{
  principalId: string;
  cookie: string;
}> {
  const suffix = randomUUID().slice(0, 8);
  const principalId = `principal_telegram_e2e_${suffix}`;
  const token = `gsvsession_${randomUUID()}${randomUUID()}`;
  const now = Date.now();
  await env.ACCOUNT_DB.batch([
    env.ACCOUNT_DB.prepare(
      `INSERT INTO principals (
         id, primary_email, primary_email_normalized, display_name,
         email_verified_at, state, created_at, updated_at
       ) VALUES (?, ?, ?, 'Telegram Owner', ?, 'active', ?, ?)`,
    ).bind(
      principalId,
      `telegram-${suffix}@example.com`,
      `telegram-${suffix}@example.com`,
      now,
      now,
      now,
    ),
    env.ACCOUNT_DB.prepare(
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
  return {
    principalId,
    cookie: `__Host-gsv-account-session=${encodeURIComponent(token)}`,
  };
}

async function provisionInstallation(
  account: ExportWorker,
  cookie: string,
): Promise<{
  installationId: string;
  handle: string;
  canonicalOrigin: string;
}> {
  const handle = `telegram-${randomUUID().slice(0, 8)}`;
  const reservation = await account.fetch(
    "https://accounts.gsv.space/api/installations",
    {
      method: "POST",
      headers: accountHeaders(cookie),
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
  const reserved = await reservation.json() as {
    installation: {
      installationId: string;
      canonicalOrigin: string;
    };
  };
  const accountApi = await account.getExport() as unknown as {
    projectEntitlement(input: {
      installationId: string;
      state: "trialing";
      planKey: string;
      inferenceBudgetMicrounits: number;
      inferencePeriodStartsAt: number;
      inferencePeriodEndsAt: number;
      storageLimitBytes: number;
      effectiveAt: number;
      version: number;
    }): Promise<unknown>;
  };
  await accountApi.projectEntitlement({
    installationId: reserved.installation.installationId,
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
    `https://accounts.gsv.space/api/installations/${reserved.installation.installationId}/provision`,
    {
      method: "POST",
      headers: accountHeaders(cookie),
      body: "{}",
    },
  );
  expect(provision.status, await provision.clone().text()).toBe(200);
  await expect(provision.json()).resolves.toMatchObject({
    installation: {
      installationId: reserved.installation.installationId,
      operationState: "complete",
    },
  });
  return {
    installationId: reserved.installation.installationId,
    handle,
    canonicalOrigin: reserved.installation.canonicalOrigin,
  };
}

function telegramUpdate(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 777001, type: "private" },
      from: {
        id: 777001,
        is_bot: false,
        first_name: "Telegram",
        username: "telegram_e2e",
      },
      text,
    },
  };
}

function telegramWebhookHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Telegram-Bot-Api-Secret-Token":
      "integration-telegram-webhook-secret",
  };
}

function accountHeaders(cookie: string): Record<string, string> {
  return {
    Cookie: cookie,
    Origin: "https://accounts.gsv.space",
    "Content-Type": "application/json",
  };
}

async function waitForTelegramCall(
  worker: FetchWorker,
  predicate: (call: TelegramApiCall) => boolean,
): Promise<TelegramApiCall> {
  let match: TelegramApiCall | undefined;
  await vi.waitFor(async () => {
    match = (await telegramApiCalls(worker)).find(predicate);
    expect(match).toBeDefined();
  }, { timeout: 10_000, interval: 25 });
  return match!;
}

async function telegramApiCalls(
  worker: FetchWorker,
): Promise<TelegramApiCall[]> {
  const response = await worker.fetch(
    "https://dependencies.invalid/__test/telegram-api",
  );
  expect(response.status).toBe(200);
  return await response.json() as TelegramApiCall[];
}

function getButtonUrl(payload: Record<string, unknown>): string | null {
  const markup = payload.reply_markup as {
    inline_keyboard?: Array<Array<{ url?: unknown }>>;
  } | undefined;
  const url = markup?.inline_keyboard?.[0]?.[0]?.url;
  return typeof url === "string" ? url : null;
}

function telegramText(call: TelegramApiCall): string | null {
  if (typeof call.payload.text === "string") return call.payload.text;
  const rich = call.payload.rich_message as { markdown?: unknown } | undefined;
  return typeof rich?.markdown === "string" ? rich.markdown : null;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
