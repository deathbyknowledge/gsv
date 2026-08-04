import { env } from "cloudflare:workers";
import type {
  ManagedGatewayTelegramInterface,
  ManagedTelegramClaim,
  ManagedTelegramClaimInspection,
  ManagedTelegramControlInterface,
} from "@humansandmachines/gsv/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformSession } from "../auth/store";
import { AccountStore } from "../store";
import {
  ManagedTelegramControlUnavailableError,
  ManagedTelegramLinkService,
} from "./service";
import { ManagedTelegramLinkOperationStore } from "./store";

const CLAIM_TOKEN = `gsvtg1.${"a".repeat(64)}.claim_1234567890abcdef.1800000000000.${"b".repeat(43)}`;

beforeEach(async () => {
  await env.ACCOUNT_DB.prepare(
    "DELETE FROM managed_telegram_link_operations",
  ).run();
});

describe("managed Telegram account linking", () => {
  it("shows only the signed-in principal's active installations", async () => {
    const owner = await principalFixture("inspect_owner");
    const other = await principalFixture("inspect_other");
    const mine = await activeMembership(owner.principalId, "mine", 1000);
    await activeMembership(other.principalId, "other", 2000);
    const fixture = serviceFixture(owner.session, claim());

    await expect(fixture.service.inspect({
      sessionToken: "session-owner",
      claimToken: CLAIM_TOKEN,
    })).resolves.toEqual({
      ok: true,
      claim: {
        claimId: "claim_1234567890abcdef",
        actorName: "Telegram Person",
        actorHandle: "@telegram_person",
        expiresAt: 1_800_000_000_000,
        linked: true,
      },
      installations: [{
        installationId: mine.installationId,
        handle: mine.handle,
        canonicalOrigin: mine.canonicalOrigin,
        state: "active",
        role: "owner",
      }],
    });
  });

  it("suspends, unlinks, links, and activates without storing the bearer", async () => {
    const owner = await principalFixture("link_owner");
    const target = await activeMembership(owner.principalId, "link-target", 2000);
    const fixture = serviceFixture(owner.session, claim());
    const idempotencyKey = crypto.randomUUID();

    await expect(fixture.service.confirm({
      sessionToken: "session-owner",
      claimToken: CLAIM_TOKEN,
      installationId: target.installationId,
      idempotencyKey,
    })).resolves.toMatchObject({
      state: "active",
      actorId: "123456",
      installation: { installationId: target.installationId },
    });

    expect(fixture.telegram.suspendManagedTelegramClaim).toHaveBeenCalledTimes(1);
    expect(fixture.gateway.unlinkManagedTelegramActor).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "inst_previous",
        actorId: "123456",
        expectedLocalUid: 3000,
      }),
    );
    expect(fixture.gateway.linkManagedTelegramActor).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: target.installationId,
        principalId: owner.principalId,
        localUid: 2000,
      }),
    );
    expect(fixture.telegram.activateManagedTelegramClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: target.installationId,
        canonicalOrigin: target.canonicalOrigin,
      }),
    );

    const row = await env.ACCOUNT_DB.prepare(
      `SELECT operation_id, claim_id, claim_token_hash, state, last_error_code
       FROM managed_telegram_link_operations
       WHERE principal_id = ?`,
    ).bind(owner.principalId).first<Record<string, unknown>>();
    expect(row).toMatchObject({
      claim_id: "claim_1234567890abcdef",
      state: "complete",
      last_error_code: null,
    });
    expect(JSON.stringify(row)).not.toContain(CLAIM_TOKEN);
    await expect(env.ACCOUNT_DB.prepare(
      `SELECT action FROM audit_events
       WHERE principal_id = ? AND action = 'telegram.managed_linked'`,
    ).bind(owner.principalId).first()).resolves.toMatchObject({
      action: "telegram.managed_linked",
    });
  });

  it("resumes after suspension without inspecting or unlinking twice", async () => {
    const owner = await principalFixture("resume_owner");
    const target = await activeMembership(owner.principalId, "resume-target", 2000);
    const fixture = serviceFixture(owner.session, claim());
    fixture.gateway.unlinkManagedTelegramActor
      .mockRejectedValueOnce(new Error("gateway unavailable"));
    const request = {
      sessionToken: "session-owner",
      claimToken: CLAIM_TOKEN,
      installationId: target.installationId,
      idempotencyKey: crypto.randomUUID(),
    };

    await expect(fixture.service.confirm(request)).rejects.toBeInstanceOf(
      ManagedTelegramControlUnavailableError,
    );
    const suspended = await new ManagedTelegramLinkOperationStore(
      env.ACCOUNT_DB,
    ).findByTokenHash(await claimHash(CLAIM_TOKEN));
    expect(suspended?.state).toBe("route_suspended");

    fixture.telegram.inspectManagedTelegramClaim.mockResolvedValue({
      ok: false,
      reason: "expired",
    } satisfies ManagedTelegramClaimInspection);
    await expect(fixture.service.confirm(request)).resolves.toMatchObject({
      state: "active",
    });
    expect(fixture.telegram.inspectManagedTelegramClaim).toHaveBeenCalledTimes(1);
    expect(fixture.telegram.suspendManagedTelegramClaim).toHaveBeenCalledTimes(1);
    expect(fixture.gateway.unlinkManagedTelegramActor).toHaveBeenCalledTimes(2);

    await expect(fixture.service.confirm(request)).resolves.toMatchObject({
      state: "active",
    });
    expect(fixture.gateway.linkManagedTelegramActor).toHaveBeenCalledTimes(1);
    expect(fixture.telegram.activateManagedTelegramClaim).toHaveBeenCalledTimes(1);
  });

  it("does not mutate routing for an installation outside the membership list", async () => {
    const owner = await principalFixture("scope_owner");
    const other = await principalFixture("scope_other");
    const target = await activeMembership(other.principalId, "scope-target", 2000);
    const fixture = serviceFixture(owner.session, claim());

    await expect(fixture.service.confirm({
      sessionToken: "session-owner",
      claimToken: CLAIM_TOKEN,
      installationId: target.installationId,
      idempotencyKey: crypto.randomUUID(),
    })).rejects.toThrow("membership is unavailable");
    expect(fixture.telegram.suspendManagedTelegramClaim).not.toHaveBeenCalled();
    expect(fixture.gateway.unlinkManagedTelegramActor).not.toHaveBeenCalled();
    expect(fixture.gateway.linkManagedTelegramActor).not.toHaveBeenCalled();
  });
});

function serviceFixture(session: PlatformSession, telegramClaim: ManagedTelegramClaim) {
  const telegram = {
    inspectManagedTelegramClaim: vi.fn<
      ManagedTelegramControlInterface["inspectManagedTelegramClaim"]
    >(async () => ({ ok: true, claim: telegramClaim })),
    suspendManagedTelegramClaim: vi.fn(async () => ({
      claim: telegramClaim,
      previousRoute: telegramClaim.activeRoute,
    })),
    activateManagedTelegramClaim: vi.fn(async (input) => ({
      state: "active" as const,
      claimId: telegramClaim.claimId,
      actorId: telegramClaim.actorId,
      surfaceId: telegramClaim.surfaceId,
      route: {
        installationId: input.installationId,
        localUid: input.localUid,
        canonicalOrigin: input.canonicalOrigin,
        linkedAt: Date.now(),
      },
    })),
  } satisfies ManagedTelegramControlInterface;
  const gateway = {
    linkManagedTelegramActor: vi.fn(async (input) => ({
      state: "linked" as const,
      installationId: input.installationId,
      actorId: input.actorId,
      surfaceId: input.surfaceId,
      localUid: input.localUid,
    })),
    unlinkManagedTelegramActor: vi.fn(async (input) => ({
      state: "unlinked" as const,
      installationId: input.installationId,
      actorId: input.actorId,
      surfaceId: input.surfaceId,
      localUid: input.expectedLocalUid,
      removed: true,
    })),
  } satisfies ManagedGatewayTelegramInterface;
  const auth = {
    authenticateSession: vi.fn(async () => session),
    requireRecentPasskeySession: vi.fn(async () => session),
  };
  return {
    telegram,
    gateway,
    service: new ManagedTelegramLinkService(
      new AccountStore(env.ACCOUNT_DB, "gsv.space"),
      new ManagedTelegramLinkOperationStore(env.ACCOUNT_DB),
      auth,
      telegram,
      gateway,
    ),
  };
}

async function principalFixture(label: string): Promise<{
  principalId: string;
  session: PlatformSession;
}> {
  const suffix = crypto.randomUUID();
  const principal = await new AccountStore(
    env.ACCOUNT_DB,
    "gsv.space",
  ).createPrincipal({
    principalId: `principal_${label}_${suffix}`,
    email: `${label}-${suffix}@example.com`,
    displayName: label,
    verified: true,
  });
  return {
    principalId: principal.id,
    session: {
      principal: {
        id: principal.id,
        email: principal.email,
        displayName: label,
        state: "active",
        emailVerifiedAt: principal.emailVerifiedAt,
      },
      sessionHash: `session_hash_${suffix}`,
      authMethod: "passkey",
      recentAuthAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    },
  };
}

async function activeMembership(
  principalId: string,
  handle: string,
  localUid: number,
) {
  const installationId = `inst_${crypto.randomUUID()}`;
  const canonicalOrigin = `https://${handle}.gsv.space`;
  const now = Date.now();
  await env.ACCOUNT_DB.batch([
    env.ACCOUNT_DB.prepare(
      `INSERT INTO installations (
         id, owner_principal_id, handle, canonical_origin, state,
         provision_version, reservation_expires_at, created_at, activated_at
       ) VALUES (?, ?, ?, ?, 'active', 1, NULL, ?, ?)`,
    ).bind(installationId, principalId, handle, canonicalOrigin, now, now),
    env.ACCOUNT_DB.prepare(
      `INSERT INTO memberships (
         installation_id, principal_id, local_uid, role, state, created_at
       ) VALUES (?, ?, ?, 'owner', 'active', ?)`,
    ).bind(installationId, principalId, localUid, now),
  ]);
  return { installationId, handle, canonicalOrigin };
}

function claim(): ManagedTelegramClaim {
  return {
    claimId: "claim_1234567890abcdef",
    actorId: "123456",
    surfaceId: "123456",
    actorName: "Telegram Person",
    actorHandle: "@telegram_person",
    expiresAt: 1_800_000_000_000,
    activeRoute: {
      installationId: "inst_previous",
      localUid: 3000,
      canonicalOrigin: "https://previous.gsv.space",
      linkedAt: 1_700_000_000_000,
    },
  };
}

async function claimHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`gsv-managed-telegram-claim:${token}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
