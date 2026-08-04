import { describe, expect, it, vi } from "vitest";
import type { AuthAbuseProtection } from "../auth/abuse";
import { ACCOUNT_SESSION_COOKIE } from "../auth/session-cookie";
import { ManagedTelegramLinkHttp } from "./http";
import type { ManagedTelegramLinkService } from "./service";

const ACCOUNT_ORIGIN = "https://accounts.gsv.space";
const CLAIM_TOKEN = "opaque-managed-telegram-claim";

describe("managed Telegram HTTP boundary", () => {
  it("inspects a claim without returning its bearer", async () => {
    const fixture = httpFixture();
    const response = await fixture.http.handle(request("inspect", {
      claimToken: CLAIM_TOKEN,
    }));

    expect(response?.status).toBe(200);
    const text = await response!.text();
    expect(text).not.toContain(CLAIM_TOKEN);
    expect(JSON.parse(text)).toMatchObject({
      result: {
        ok: true,
        installations: [{ handle: "hank" }],
      },
    });
    expect(fixture.links.inspect).toHaveBeenCalledWith({
      sessionToken: "session-token",
      claimToken: CLAIM_TOKEN,
    });
  });

  it("confirms only through the exact account origin", async () => {
    const fixture = httpFixture();
    const sibling = request("confirm", {
      claimToken: CLAIM_TOKEN,
      installationId: "inst_hank",
      idempotencyKey: crypto.randomUUID(),
    }, "https://hank.gsv.space");
    const rejected = await fixture.http.handle(sibling);
    expect(rejected?.status).toBe(403);
    expect(fixture.links.confirm).not.toHaveBeenCalled();

    const accepted = await fixture.http.handle(request("confirm", {
      claimToken: CLAIM_TOKEN,
      installationId: "inst_hank",
      idempotencyKey: crypto.randomUUID(),
    }));
    expect(accepted?.status).toBe(200);
    await expect(accepted?.json()).resolves.toMatchObject({
      link: { state: "active", actorId: "123456" },
    });
  });

  it("requires the account session cookie", async () => {
    const fixture = httpFixture();
    const missingCookie = request("inspect", { claimToken: CLAIM_TOKEN });
    missingCookie.headers.delete("Cookie");
    const response = await fixture.http.handle(missingCookie);
    expect(response?.status).toBe(401);
    expect(fixture.links.inspect).not.toHaveBeenCalled();
  });
});

function httpFixture() {
  const links = {
    inspect: vi.fn(async () => ({
      ok: true as const,
      claim: {
        claimId: "claim_id",
        expiresAt: Date.now() + 60_000,
        linked: false,
      },
      installations: [{
        installationId: "inst_hank",
        handle: "hank",
        canonicalOrigin: "https://hank.gsv.space",
        state: "active" as const,
        role: "owner" as const,
      }],
    })),
    confirm: vi.fn(async () => ({
      state: "active" as const,
      claimId: "claim_id",
      actorId: "123456",
      installation: {
        installationId: "inst_hank",
        handle: "hank",
        canonicalOrigin: "https://hank.gsv.space",
        state: "active" as const,
        role: "owner" as const,
      },
    })),
  };
  const abuse = {
    check: vi.fn(async () => undefined),
  };
  return {
    links,
    http: new ManagedTelegramLinkHttp(
      links as unknown as ManagedTelegramLinkService,
      abuse as unknown as AuthAbuseProtection,
      ACCOUNT_ORIGIN,
    ),
  };
}

function request(
  action: "inspect" | "confirm",
  body: Record<string, unknown>,
  origin = ACCOUNT_ORIGIN,
): Request {
  return new Request(`${ACCOUNT_ORIGIN}/api/telegram/claims/${action}`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Cookie: `${ACCOUNT_SESSION_COOKIE}=session-token`,
    },
    body: JSON.stringify(body),
  });
}
