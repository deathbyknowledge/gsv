import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailPolicy } from "../src/policy";

const values = {
  "mail.inbound.enabled": true, "mail.inbound.max_message_bytes": 1_000,
  "mail.inbound.daily_messages": 2, "mail.inbound.daily_bytes": 10_000,
  "mail.daily_summarizations": 1, "mail.outbound.enabled": true,
  "mail.outbound.max_text_bytes": 1000, "mail.outbound.daily_messages": 2,
  "mail.outbound.daily_bytes": 10_000,
};

afterEach(() => vi.restoreAllMocks());

describe("mail plan allowance", () => {
  it("caches per space, applies overrides after five minutes and never falls back on an outage", async () => {
    const now = Date.now();
    let time = now;
    vi.spyOn(Date, "now").mockImplementation(() => time);
    const getEntitlements = vi.fn(async () => ({ version: 1 as const, installationId: "space-a", revision: "one",
      values, issuedAt: time, refreshAfter: time + 300_000, expiresAt: time + 300_000 }));
    const policy = new MailPolicy({ ...env, ENTITLEMENTS: { getEntitlements } }, "space-a");
    expect((await policy.limits()).dailyInboundMessages).toBe(2);
    getEntitlements.mockImplementation(async () => ({ version: 1, installationId: "space-a", revision: "two",
      values: { ...values, "mail.inbound.daily_messages": 5 }, issuedAt: time, refreshAfter: time + 300_000, expiresAt: time + 300_000 }));
    time += 299_999;
    expect((await policy.limits()).dailyInboundMessages).toBe(2);
    time++;
    expect((await policy.limits()).dailyInboundMessages).toBe(5);
    expect(getEntitlements).toHaveBeenCalledTimes(2);
    time += 300_000;
    getEntitlements.mockRejectedValue(new Error("outage"));
    await expect(policy.limits()).rejects.toThrow("unavailable");
  });

  it("keeps the operational stop switch independent of cached plan enablement", async () => {
    const now = Date.now();
    const config: ConstructorParameters<typeof MailPolicy>[0] = { ...env, MAIL_OUTBOUND_ENABLED: true, ENTITLEMENTS: { getEntitlements: async () => ({
      version: 1 as const, installationId: "space-a", revision: "one", values,
      issuedAt: now, refreshAfter: now + 300_000, expiresAt: now + 300_000,
    }) } };
    const policy = new MailPolicy(config, "space-a");
    expect((await policy.limits()).outboundEnabled).toBe(true);
    config.MAIL_OUTBOUND_ENABLED = false;
    expect((await policy.limits()).outboundEnabled).toBe(false);
  });
});
