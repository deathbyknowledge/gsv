import { describe, expect, it, vi } from "vitest";
import { handleTelegramRequest } from "../../../adapters/telegram/src/index";

describe("Telegram wildcard admission", () => {
  it("rejects a webhook before resolving an account stub while globally fenced", async () => {
    const getAccount = vi.fn();
    const cancel = vi.fn();
    const response = await handleTelegramRequest({
      url: "https://telegram.test/webhook/new-account",
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: new ReadableStream({ cancel }),
    } as Request, {
      TELEGRAM_ACCOUNT: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: getAccount,
      },
      MANAGED_ADMISSION: {
        getByName: () => ({
          acquire: async () => ({ admitted: false, status: "fenced", epoch: 4 }),
        }),
      },
    } as never);

    expect(response.status).toBe(503);
    expect(getAccount).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("leases an admitted webhook and rejects a stale completion", async () => {
    const release = vi.fn(async () => {});
    const handleWebhook = vi.fn(async () => ({ ok: true }));
    const response = await handleTelegramRequest(new Request(
      "https://telegram.test/webhook/account-1",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "secret-token",
        },
        body: '{"update_id":42}',
      },
    ), {
      TELEGRAM_ACCOUNT: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          authorizeWebhook: async () => ({ ok: true, acceptBody: true }),
          handleWebhook,
        }),
      },
      MANAGED_ADMISSION: {
        getByName: () => ({
          acquire: async () => ({
            admitted: true,
            leaseId: "lease-1",
            epoch: 8,
          }),
          renew: async () => {},
          assertCurrent: async () => false,
          release,
        }),
      },
    } as never);

    expect(handleWebhook).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith("lease-1");
    expect(response.status).toBe(503);
  });
});
