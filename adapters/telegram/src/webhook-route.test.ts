import { describe, expect, it, vi } from "vitest";

import {
  reconcileTelegramApprovalWebhook,
  TELEGRAM_APPROVAL_WEBHOOK_VERSION,
} from "./webhook-route";

describe("Telegram webhook upgrades", () => {
  it("re-registers a legacy webhook for approval callbacks", async () => {
    const register = vi.fn(async () => undefined);

    await expect(reconcileTelegramApprovalWebhook(
      0,
      "https://telegram.example/webhook/account",
      "secret",
      register,
    )).resolves.toBe(TELEGRAM_APPROVAL_WEBHOOK_VERSION);
    expect(register).toHaveBeenCalledWith({
      url: "https://telegram.example/webhook/account",
      secret_token: "secret",
      allowed_updates: ["message", "channel_post", "callback_query"],
    });
  });

  it("does not touch a webhook that already supports approval callbacks", async () => {
    const register = vi.fn(async () => undefined);

    await expect(reconcileTelegramApprovalWebhook(
      TELEGRAM_APPROVAL_WEBHOOK_VERSION,
      "https://telegram.example/webhook/account",
      "secret",
      register,
    )).resolves.toBe(TELEGRAM_APPROVAL_WEBHOOK_VERSION);
    expect(register).not.toHaveBeenCalled();
  });
});
