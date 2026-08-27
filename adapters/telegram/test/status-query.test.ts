import { describe, expect, it, vi } from "vitest";

import { TelegramChannel } from "../src/index";

describe("Telegram status queries", () => {
  it("propagates account RPC failures instead of reporting authentication loss", async () => {
    const getStatus = vi.fn(async () => {
      throw new Error("temporary account RPC failure");
    });
    const durableObjectId = { toString: () => "account-do-id" };
    const idFromName = vi.fn(() => durableObjectId);
    const get = vi.fn(() => ({ getStatus }));
    // SAFETY: the entrypoint fixture provides the constructor context and exact
    // binding used by adapterStatus while preserving the class's private brand.
    const entrypoint = Reflect.construct(TelegramChannel, [
      {},
      { TELEGRAM_ACCOUNT: { idFromName, get } },
    ]) as TelegramChannel;

    await expect(entrypoint.adapterStatus("primary"))
      .rejects.toThrow("temporary account RPC failure");
    expect(idFromName).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(durableObjectId);
  });
});
