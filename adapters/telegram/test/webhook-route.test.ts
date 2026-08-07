import { describe, expect, it } from "vitest";
import { LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID } from "../../shared/src/installation";
import {
  buildTelegramWebhookPath,
  parseTelegramWebhookPath,
} from "../src/webhook-route";

describe("Telegram webhook routing", () => {
  it("preserves the standalone account route exactly", () => {
    const accountId = "a".repeat(64);
    const path = buildTelegramWebhookPath(
      LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
      accountId,
    );

    expect(path).toBe(`/webhook/${accountId}`);
    expect(parseTelegramWebhookPath(path)).toEqual({
      kind: "legacy",
      accountId,
    });
  });

  it("uses an opaque Durable Object route for managed installations", () => {
    const durableObjectId = "b".repeat(64);
    const path = buildTelegramWebhookPath("inst_alice", durableObjectId);

    expect(path).toBe(`/webhook/managed/${durableObjectId}`);
    expect(parseTelegramWebhookPath(path)).toEqual({
      kind: "opaque",
      durableObjectId,
    });
  });

  it("rejects malformed managed routes", () => {
    expect(parseTelegramWebhookPath("/webhook/managed/not-an-id")).toBeNull();
    expect(parseTelegramWebhookPath("/webhook/managed/aa/extra")).toBeNull();
  });
});
