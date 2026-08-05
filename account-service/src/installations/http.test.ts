import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ACCOUNT_SESSION_COOKIE } from "../auth/session-cookie";
import { EntitlementStore } from "../entitlements/store";
import { sha256Hex } from "../security/tokens";
import { AccountStore } from "../store";

async function accountSession(label: string): Promise<{
  cookie: string;
  principalId: string;
}> {
  const suffix = crypto.randomUUID();
  const principalId = `principal_${label}_${suffix}`;
  await new AccountStore(env.ACCOUNT_DB, "gsv.space").createPrincipal({
    principalId,
    email: `${label}-${suffix}@example.com`,
    displayName: label,
    verified: true,
  });
  const token = `gsvsession_${crypto.randomUUID()}${crypto.randomUUID()}`;
  const now = Date.now();
  await env.ACCOUNT_DB.prepare(
    `INSERT INTO sessions (
       id_hash, principal_id, created_at, expires_at, recent_auth_at,
       revoked_at, ip_hash, user_agent, auth_method
     ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'test', 'passkey')`,
  ).bind(
    await sha256Hex(token),
    principalId,
    now,
    now + 30 * 24 * 60 * 60_000,
    now,
  ).run();
  return {
    cookie: `${ACCOUNT_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    principalId,
  };
}

function postHeaders(cookie: string): HeadersInit {
  return {
    Origin: "https://accounts.gsv.space",
    "Content-Type": "application/json",
    Cookie: cookie,
  };
}

describe("managed installation HTTP boundary", () => {
  it("reserves idempotently, lists only account installations, and waits for entitlement", async () => {
    const owner = await accountSession("installation_http");
    const suffix = crypto.randomUUID().slice(0, 8);
    const request = {
      idempotencyKey: crypto.randomUUID(),
      handle: `browser-${suffix}`,
      ownerUsername: "owner",
      agentName: "companion",
      timezone: "Europe/Amsterdam",
    };
    const first = await SELF.fetch("https://accounts.gsv.space/api/installations", {
      method: "POST",
      headers: postHeaders(owner.cookie),
      body: JSON.stringify(request),
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json<{
      installation: {
        installationId: string;
        handle: string;
        operationState: string;
        entitlement: unknown;
      };
    }>();
    expect(firstBody.installation).toMatchObject({
      handle: request.handle,
      operationState: "reserved",
      entitlement: null,
    });
    expect(firstBody.installation).not.toHaveProperty("operationId");

    const replay = await SELF.fetch("https://accounts.gsv.space/api/installations", {
      method: "POST",
      headers: postHeaders(owner.cookie),
      body: JSON.stringify(request),
    });
    expect(replay.status).toBe(201);
    await expect(replay.json()).resolves.toMatchObject({
      installation: { installationId: firstBody.installation.installationId },
    });

    const list = await SELF.fetch("https://accounts.gsv.space/api/installations", {
      headers: { Cookie: owner.cookie },
    });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      installations: [{ installationId: firstBody.installation.installationId }],
    });

    const provision = await SELF.fetch(
      `https://accounts.gsv.space/api/installations/${firstBody.installation.installationId}/provision`,
      {
        method: "POST",
        headers: postHeaders(owner.cookie),
        body: "{}",
      },
    );
    expect(provision.status).toBe(409);
    await expect(provision.json()).resolves.toEqual({
      error: "Subscription or trial required",
    });

    await new EntitlementStore(env.ACCOUNT_DB).project({
      installationId: firstBody.installation.installationId,
      state: "trialing",
      planKey: "test",
      inferenceBudgetMicrounits: 5_000_000,
      inferencePeriodStartsAt: Date.now(),
      inferencePeriodEndsAt: Date.now() + 30 * 24 * 60 * 60_000,
      storageLimitBytes: 10_000_000,
      effectiveAt: Date.now(),
      version: 1,
    });
    const unavailable = await SELF.fetch(
      `https://accounts.gsv.space/api/installations/${firstBody.installation.installationId}/provision`,
      {
        method: "POST",
        headers: postHeaders(owner.cookie),
        body: "{}",
      },
    );
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({
      error: "Provisioning temporarily unavailable",
    });
  });

  it("rejects reservation mutations from a sibling origin", async () => {
    const owner = await accountSession("installation_origin");
    const response = await SELF.fetch("https://accounts.gsv.space/api/installations", {
      method: "POST",
      headers: {
        ...postHeaders(owner.cookie),
        Origin: "https://someone.gsv.space",
      },
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        handle: `origin-${crypto.randomUUID().slice(0, 8)}`,
        ownerUsername: "owner",
      }),
    });
    expect(response.status).toBe(403);
  });

  it("does not reveal or provision another principal's reservation", async () => {
    const owner = await accountSession("installation_owner");
    const intruder = await accountSession("installation_intruder");
    const reservation = await SELF.fetch(
      "https://accounts.gsv.space/api/installations",
      {
        method: "POST",
        headers: postHeaders(owner.cookie),
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          handle: `private-${crypto.randomUUID().slice(0, 8)}`,
          ownerUsername: "owner",
        }),
      },
    );
    const body = await reservation.json<{
      installation: { installationId: string };
    }>();

    const list = await SELF.fetch("https://accounts.gsv.space/api/installations", {
      headers: { Cookie: intruder.cookie },
    });
    await expect(list.json()).resolves.toEqual({ installations: [] });
    const provision = await SELF.fetch(
      `https://accounts.gsv.space/api/installations/${body.installation.installationId}/provision`,
      {
        method: "POST",
        headers: postHeaders(intruder.cookie),
        body: "{}",
      },
    );
    expect(provision.status).toBe(404);
    await expect(provision.json()).resolves.toEqual({ error: "Not Found" });

    const foreignUsage = await SELF.fetch(
      `https://accounts.gsv.space/api/installations/${body.installation.installationId}/usage`,
      { headers: { Cookie: intruder.cookie } },
    );
    expect(foreignUsage.status).toBe(404);
    await expect(foreignUsage.json()).resolves.toEqual({ error: "Not Found" });

    const ownerUsage = await SELF.fetch(
      `https://accounts.gsv.space/api/installations/${body.installation.installationId}/usage`,
      { headers: { Cookie: owner.cookie } },
    );
    expect(ownerUsage.status).toBe(200);
    await expect(ownerUsage.json()).resolves.toEqual({ usage: null });
  });
});
