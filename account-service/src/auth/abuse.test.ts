import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  AuthAbuseProtection,
  RateLimitExceededError,
  TestBotVerifier,
  TurnstileBotVerifier,
} from "./abuse";

describe("account authentication abuse protection", () => {
  it("enforces an atomic request limit without storing the raw key", async () => {
    const abuse = new AuthAbuseProtection(env.ACCOUNT_DB, new TestBotVerifier());
    const rawIpHash = `ip-${crypto.randomUUID()}`;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await abuse.check({ operation: "signup", ipHash: rawIpHash });
    }
    await expect(abuse.check({ operation: "signup", ipHash: rawIpHash }))
      .rejects.toBeInstanceOf(RateLimitExceededError);

    const buckets = await env.ACCOUNT_DB.prepare(
      "SELECT bucket_key, count FROM rate_limit_buckets WHERE count > 0",
    ).all<{ bucket_key: string; count: number }>();
    expect(buckets.results).toHaveLength(1);
    expect(buckets.results[0]?.count).toBe(11);
    expect(buckets.results[0]?.bucket_key).not.toContain(rawIpHash);
  });

  it("enforces a separate subject limit", async () => {
    const abuse = new AuthAbuseProtection(env.ACCOUNT_DB, new TestBotVerifier());
    const subject = `person-${crypto.randomUUID()}@example.com`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await abuse.check({
        operation: "signup",
        ipHash: `ip-${crypto.randomUUID()}`,
        subject,
      });
    }
    await expect(abuse.check({
      operation: "signup",
      ipHash: `ip-${crypto.randomUUID()}`,
      subject,
    })).rejects.toBeInstanceOf(RateLimitExceededError);
  });

  it("deletes expired rate-limit state without touching active buckets", async () => {
    const abuse = new AuthAbuseProtection(env.ACCOUNT_DB, new TestBotVerifier());
    const now = Date.now();
    await env.ACCOUNT_DB.batch([
      env.ACCOUNT_DB.prepare(
        "INSERT INTO rate_limit_buckets VALUES ('expired', ?, 1, ?)",
      ).bind(now - 2_000, now - 1_000),
      env.ACCOUNT_DB.prepare(
        "INSERT INTO rate_limit_buckets VALUES ('active', ?, 1, ?)",
      ).bind(now, now + 1_000),
    ]);

    await expect(abuse.deleteExpiredBuckets(now)).resolves.toBe(1);
    const remaining = await env.ACCOUNT_DB.prepare(
      `SELECT bucket_key FROM rate_limit_buckets
       WHERE bucket_key IN ('expired', 'active')
       ORDER BY bucket_key`,
    ).all<{ bucket_key: string }>();
    expect(remaining.results).toEqual([{ bucket_key: "active" }]);
  });

  it("fails closed when Turnstile is unconfigured", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const verifier = new TurnstileBotVerifier(undefined, "accounts.gsv.space", fetcher);
    await expect(verifier.verify({
      token: "token",
      action: "signup",
    })).resolves.toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires Turnstile hostname and action to match", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      success: true,
      hostname: "accounts.gsv.space",
      action: "signup",
    }));
    const verifier = new TurnstileBotVerifier(
      "test-secret",
      "accounts.gsv.space",
      fetcher,
    );
    await expect(verifier.verify({
      token: "token",
      action: "signup",
      remoteIp: "192.0.2.1",
    })).resolves.toBe(true);
    await expect(verifier.verify({
      token: "token",
      action: "recovery",
    })).resolves.toBe(false);
  });
});
