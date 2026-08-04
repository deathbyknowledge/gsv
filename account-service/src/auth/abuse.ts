import { sha256Hex } from "../security/tokens";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITEVERIFY_TIMEOUT_MS = 5_000;

export type BotAction = "signup" | "passkey_login" | "recovery";

export interface BotVerifier {
  verify(input: {
    token: string;
    action: BotAction;
    remoteIp?: string;
  }): Promise<boolean>;
}

export type AuthRateLimitOperation =
  | "signup"
  | "email_verify"
  | "recovery"
  | "passkey_login_options"
  | "passkey_login_verify"
  | "passkey_registration"
  | "installation_reservation"
  | "installation_provision"
  | "installation_handoff"
  | "installation_delete"
  | "installation_recover"
  | "telegram_claim_inspect"
  | "telegram_link_confirm"
  | "billing_checkout"
  | "billing_portal";

type RateLimitPolicy = {
  windowMs: number;
  ipLimit: number;
  subjectLimit?: number;
};

const DEFAULT_RATE_LIMIT_POLICIES: Record<AuthRateLimitOperation, RateLimitPolicy> = {
  signup: { windowMs: 10 * 60_000, ipLimit: 10, subjectLimit: 3 },
  email_verify: { windowMs: 10 * 60_000, ipLimit: 30, subjectLimit: 6 },
  recovery: { windowMs: 15 * 60_000, ipLimit: 10, subjectLimit: 5 },
  passkey_login_options: { windowMs: 60_000, ipLimit: 20 },
  passkey_login_verify: { windowMs: 5 * 60_000, ipLimit: 30, subjectLimit: 10 },
  passkey_registration: { windowMs: 5 * 60_000, ipLimit: 20, subjectLimit: 10 },
  installation_reservation: { windowMs: 30 * 60_000, ipLimit: 10, subjectLimit: 5 },
  installation_provision: { windowMs: 5 * 60_000, ipLimit: 20, subjectLimit: 10 },
  installation_handoff: { windowMs: 5 * 60_000, ipLimit: 30, subjectLimit: 10 },
  installation_delete: { windowMs: 30 * 60_000, ipLimit: 10, subjectLimit: 5 },
  installation_recover: { windowMs: 10 * 60_000, ipLimit: 20, subjectLimit: 10 },
  telegram_claim_inspect: { windowMs: 5 * 60_000, ipLimit: 60, subjectLimit: 30 },
  telegram_link_confirm: { windowMs: 5 * 60_000, ipLimit: 20, subjectLimit: 10 },
  billing_checkout: { windowMs: 10 * 60_000, ipLimit: 20, subjectLimit: 5 },
  billing_portal: { windowMs: 5 * 60_000, ipLimit: 30, subjectLimit: 15 },
};

export class RateLimitExceededError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("rate limit exceeded");
  }
}

export class BotVerificationError extends Error {
  constructor() {
    super("bot verification failed");
  }
}

export class AuthAbuseProtection {
  constructor(
    private readonly db: D1Database,
    private readonly botVerifier: BotVerifier,
    private readonly policies: Record<AuthRateLimitOperation, RateLimitPolicy>
      = DEFAULT_RATE_LIMIT_POLICIES,
  ) {}

  async check(input: {
    operation: AuthRateLimitOperation;
    ipHash?: string;
    subject?: string;
    bot?: {
      token: string;
      action: BotAction;
      remoteIp?: string;
    };
  }): Promise<void> {
    const policy = this.policies[input.operation];
    await this.consumeBucket(
      input.operation,
      "ip",
      input.ipHash ?? "unknown",
      policy.ipLimit,
      policy.windowMs,
    );
    if (input.subject && policy.subjectLimit !== undefined) {
      await this.consumeBucket(
        input.operation,
        "subject",
        input.subject,
        policy.subjectLimit,
        policy.windowMs,
      );
    }
    if (input.bot) {
      const valid = await this.botVerifier.verify(input.bot).catch(() => false);
      if (!valid) throw new BotVerificationError();
    }
  }

  async deleteExpiredBuckets(now = Date.now()): Promise<number> {
    const result = await this.db.prepare(
      "DELETE FROM rate_limit_buckets WHERE expires_at <= ?",
    ).bind(now).run();
    return result.meta.changes ?? 0;
  }

  private async consumeBucket(
    operation: AuthRateLimitOperation,
    dimension: "ip" | "subject",
    value: string,
    limit: number,
    windowMs: number,
  ): Promise<void> {
    const now = Date.now();
    const expiresAt = now + windowMs;
    const bucketKey = await sha256Hex(`gsv-auth-rate:${operation}:${dimension}:${value}`);
    const bucket = await this.db.prepare(
      `INSERT INTO rate_limit_buckets (bucket_key, window_start, count, expires_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET
         window_start = CASE
           WHEN rate_limit_buckets.expires_at <= ? THEN excluded.window_start
           ELSE rate_limit_buckets.window_start
         END,
         count = CASE
           WHEN rate_limit_buckets.expires_at <= ? THEN 1
           ELSE rate_limit_buckets.count + 1
         END,
         expires_at = CASE
           WHEN rate_limit_buckets.expires_at <= ? THEN excluded.expires_at
           ELSE rate_limit_buckets.expires_at
         END
       RETURNING count, expires_at`,
    ).bind(bucketKey, now, expiresAt, now, now, now).first<{
      count: number;
      expires_at: number;
    }>();
    if (!bucket) throw new Error("rate limit state was not committed");
    if (bucket.count > limit) {
      throw new RateLimitExceededError(
        Math.max(1, Math.ceil((bucket.expires_at - now) / 1000)),
      );
    }
  }
}

export class TurnstileBotVerifier implements BotVerifier {
  constructor(
    private readonly secret: string | undefined,
    private readonly expectedHostname: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async verify(input: {
    token: string;
    action: BotAction;
    remoteIp?: string;
  }): Promise<boolean> {
    if (
      !this.secret
      || !input.token
      || input.token.length > 2_048
      || !this.expectedHostname
    ) {
      return false;
    }
    const body = new FormData();
    body.set("secret", this.secret);
    body.set("response", input.token);
    body.set("idempotency_key", crypto.randomUUID());
    if (input.remoteIp) body.set("remoteip", input.remoteIp);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SITEVERIFY_TIMEOUT_MS);
    try {
      const response = await this.fetcher(SITEVERIFY_URL, {
        method: "POST",
        body,
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const result = await response.json() as {
        success?: unknown;
        hostname?: unknown;
        action?: unknown;
      };
      return result.success === true
        && result.hostname === this.expectedHostname
        && result.action === input.action;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class TestBotVerifier implements BotVerifier {
  async verify(input: { token: string }): Promise<boolean> {
    return input.token === "gsv-test-turnstile-token";
  }
}
