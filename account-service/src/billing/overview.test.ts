import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { PlatformSession } from "../auth/store";
import { ACCOUNT_SESSION_COOKIE } from "../auth/session-cookie";
import { sha256Hex } from "../security/tokens";
import { AccountStore } from "../store";
import { BillingOverviewService } from "./overview";
import { BillingStore } from "./store";

describe("billing overview", () => {
  it("shows only installations owned by the authenticated principal", async () => {
    const suffix = crypto.randomUUID();
    const accounts = new AccountStore(env.ACCOUNT_DB, "gsv.space");
    const ownerId = `principal_overview_owner_${suffix}`;
    const otherId = `principal_overview_other_${suffix}`;
    await accounts.createPrincipal({
      principalId: ownerId,
      email: `overview-owner-${suffix}@example.com`,
      displayName: "Overview owner",
      verified: true,
    });
    await accounts.createPrincipal({
      principalId: otherId,
      email: `overview-other-${suffix}@example.com`,
      displayName: "Other owner",
      verified: true,
    });
    const owned = await accounts.reserveInstallation({
      principalId: ownerId,
      operationId: `operation_overview_owned_${suffix}`,
      handle: `owned-${suffix.slice(0, 8)}`,
      ownerUsername: "owner",
    });
    const shared = await accounts.reserveInstallation({
      principalId: otherId,
      operationId: `operation_overview_shared_${suffix}`,
      handle: `shared-${suffix.slice(0, 8)}`,
      ownerUsername: "owner",
    });
    await env.ACCOUNT_DB.prepare(
      `INSERT INTO memberships (
         installation_id, principal_id, local_uid, role, state, created_at
       ) VALUES (?, ?, NULL, 'member', 'pending', ?)`,
    ).bind(shared.installationId, ownerId, Date.now()).run();
    const session = {
      principal: {
        id: ownerId,
        email: `overview-owner-${suffix}@example.com`,
        displayName: "Overview owner",
        state: "active" as const,
      },
      authMethod: "passkey" as const,
      recentAuthAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    } as PlatformSession;
    const auth = { authenticateSession: vi.fn(async () => session) };
    const service = new BillingOverviewService(
      accounts,
      new BillingStore(env.ACCOUNT_DB),
      auth,
    );

    await expect(service.get("session-token")).resolves.toEqual([{
      installationId: owned.installationId,
      handle: owned.handle,
      canonicalOrigin: owned.canonicalOrigin,
      installationState: "reserved",
      operationState: "reserved",
      subscription: null,
    }]);
  });

  it("is available through the account route without Stripe credentials", async () => {
    const suffix = crypto.randomUUID();
    const principalId = `principal_overview_http_${suffix}`;
    const accounts = new AccountStore(env.ACCOUNT_DB, "gsv.space");
    await accounts.createPrincipal({
      principalId,
      email: `overview-http-${suffix}@example.com`,
      displayName: "HTTP owner",
      verified: true,
    });
    const installation = await accounts.reserveInstallation({
      principalId,
      operationId: `operation_overview_http_${suffix}`,
      handle: `billing-${suffix.slice(0, 8)}`,
      ownerUsername: "owner",
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
      now + 60_000,
      now,
    ).run();

    const response = await SELF.fetch("https://accounts.gsv.space/api/billing", {
      headers: {
        Cookie: `${ACCOUNT_SESSION_COOKIE}=${encodeURIComponent(token)}`,
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      offer: {
        planKey: "founding-monthly",
        currency: "usd",
        monthlyPriceMinor: 2_000,
      },
      installations: [{
        installationId: installation.installationId,
        subscription: null,
      }],
    });
  });
});
