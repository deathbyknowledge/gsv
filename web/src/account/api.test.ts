import { describe, expect, it, vi } from "vitest";
import { AccountApi } from "./api";

describe("account API", () => {
  it("parses public browser configuration without secret material", async () => {
    const api = new AccountApi(vi.fn(async () => Response.json({
      turnstileSiteKey: "1x00000000000000000000AA",
      telegramBotUsername: "GsvSpaceBot",
    })));
    await expect(api.publicConfig()).resolves.toEqual({
      turnstileSiteKey: "1x00000000000000000000AA",
      telegramBotUsername: "GsvSpaceBot",
    });
  });

  it("uses Telegram's complete public bot username boundary", async () => {
    const shortest = new AccountApi(vi.fn(async () => Response.json({
      turnstileSiteKey: null,
      telegramBotUsername: "a_bot",
    })));
    await expect(shortest.publicConfig()).resolves.toMatchObject({
      telegramBotUsername: "a_bot",
    });

    const tooLong = new AccountApi(vi.fn(async () => Response.json({
      turnstileSiteKey: null,
      telegramBotUsername: `${"a".repeat(30)}bot`,
    })));
    await expect(tooLong.publicConfig()).rejects.toThrow(
      "invalid public configuration",
    );
  });

  it("parses the billing-safe overview and requests same-origin credentials", async () => {
    const request = vi.fn(async () => Response.json({
      offer: {
        planKey: "founding-monthly",
        currency: "usd",
        monthlyPriceMinor: 2_000,
      },
      installations: [{
        installationId: "inst_fixture",
        handle: "hank",
        canonicalOrigin: "https://hank.gsv.space",
        installationState: "past_due",
        operationState: "complete",
        subscription: {
          planKey: "founding-monthly",
          state: "past_due",
          currentPeriodEndsAt: 1_800_000_000_000,
          cancelAtPeriodEnd: false,
          paidThrough: null,
          graceEndsAt: 1_800_100_000_000,
          retentionEndsAt: null,
        },
      }],
    }));

    await expect(new AccountApi(request).billingOverview()).resolves
      .toMatchObject({
        offer: { monthlyPriceMinor: 2_000 },
        installations: [{
          handle: "hank",
          subscription: { state: "past_due" },
        }],
      });
    expect(request).toHaveBeenCalledWith("/api/billing", expect.objectContaining({
      credentials: "same-origin",
    }));
  });

  it("rejects a non-HTTPS hosted billing destination", async () => {
    const api = new AccountApi(vi.fn(async () => Response.json({
      session: { url: "http://checkout.example.test/session" },
    })));
    await expect(api.createBillingCheckout({
      installationId: "inst_fixture",
      planKey: "founding-monthly",
      idempotencyKey: crypto.randomUUID(),
    })).rejects.toThrow("invalid billing destination");
  });

  it("parses the installation control-plane view without exposing operation IDs", async () => {
    const api = new AccountApi(vi.fn(async () => Response.json({
      installations: [{
        installationId: "inst_fixture",
        handle: "hank",
        canonicalOrigin: "https://hank.gsv.space",
        state: "active",
        operationState: "complete",
        ownerUsername: "hank",
        agentName: "GSV",
        timezone: "Europe/Amsterdam",
        reservationExpiresAt: null,
        entitlement: {
          state: "active",
          planKey: "founding-monthly",
          effectiveAt: 1_800_000_000_000,
        },
      }],
    })));
    await expect(api.installations()).resolves.toEqual([expect.objectContaining({
      installationId: "inst_fixture",
      handle: "hank",
      entitlement: { state: "active", planKey: "founding-monthly", effectiveAt: 1_800_000_000_000 },
    })]);
  });

  it("accepts handoff posts only to a managed GSV hostname", async () => {
    const valid = new AccountApi(vi.fn(async () => Response.json({
      action: "https://hank.gsv.space/auth/handoff",
      token: "handoff_secret",
      expiresAt: 1_900_000_000_000,
    })));
    await expect(valid.createInstallationHandoff("inst_fixture")).resolves
      .toMatchObject({ action: "https://hank.gsv.space/auth/handoff" });

    const external = new AccountApi(vi.fn(async () => Response.json({
      action: "https://attacker.example/auth/handoff",
      token: "handoff_secret",
      expiresAt: 1_900_000_000_000,
    })));
    await expect(external.createInstallationHandoff("inst_fixture")).rejects
      .toThrow("invalid GSV handoff");
  });

  it("validates enrollment options and returns recovery codes only from verification", async () => {
    const responses = [
      Response.json({
        challengeId: "challenge_fixture",
        options: {
          challenge: "AQID",
          rp: { id: "accounts.gsv.space", name: "GSV" },
          user: {
            id: "BAUG",
            name: "person@example.com",
            displayName: "Person",
          },
          pubKeyCredParams: [{ alg: -7, type: "public-key" }],
        },
      }),
      Response.json({
        verified: true,
        recoveryCodes: ["AAAA-BBBB", "CCCC-DDDD"],
        expiresAt: 1_900_000_000_000,
      }),
    ];
    const request = vi.fn(async () => responses.shift()!);
    const api = new AccountApi(request);
    await expect(api.beginPasskeyRegistration()).resolves.toMatchObject({
      challengeId: "challenge_fixture",
      options: { rp: { id: "accounts.gsv.space" } },
    });
    await expect(api.finishPasskeyRegistration({
      challengeId: "challenge_fixture",
      response: {
        id: "credential_fixture",
        rawId: "AQID",
        response: { clientDataJSON: "AQ", attestationObject: "Ag" },
        clientExtensionResults: {},
        type: "public-key",
      },
    })).resolves.toEqual({
      recoveryCodes: ["AAAA-BBBB", "CCCC-DDDD"],
      expiresAt: 1_900_000_000_000,
    });
  });

  it("keeps an installation export as a stream and accepts only the versioned archive", async () => {
    const api = new AccountApi(vi.fn(async () => new Response("archive", {
      headers: {
        "content-type": "application/x-tar",
        "content-disposition": "attachment; filename=\"gsv-hank-20260805.tar\"",
        "x-gsv-export-format": "1",
      },
    })));
    const archive = await api.requestInstallationExport("inst_fixture");
    expect(archive.filename).toBe("gsv-hank-20260805.tar");
    await expect(archive.response.text()).resolves.toBe("archive");
  });

  it("parses only provider-neutral GSV Intelligence usage", async () => {
    const api = new AccountApi(vi.fn(async () => Response.json({
      usage: {
        level: "critical",
        usedPercent: 97,
        periodEndsAt: 1_900_000_000_000,
      },
    })));
    await expect(api.installationUsage("inst_fixture")).resolves.toEqual({
      level: "critical",
      usedPercent: 97,
      periodEndsAt: 1_900_000_000_000,
    });
  });
});
