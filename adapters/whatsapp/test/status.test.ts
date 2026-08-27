import { describe, expect, it, vi } from "vitest";

import { WhatsAppChannelEntrypoint } from "../src/index";

describe("WhatsApp status queries", () => {
  it("propagates account RPC failures instead of reporting authentication loss", async () => {
    const getAccountStatus = vi.fn(async () => {
      throw new Error("temporary account RPC failure");
    });
    const getByName = vi.fn(() => ({ getAccountStatus }));
    // SAFETY: the entrypoint fixture provides the constructor context and exact
    // binding used by adapterStatus while preserving the class's private brand.
    const entrypoint = Reflect.construct(WhatsAppChannelEntrypoint, [
      {},
      { WHATSAPP_ACCOUNT: { getByName } },
    ]) as WhatsAppChannelEntrypoint;

    await expect(entrypoint.adapterStatus("primary"))
      .rejects.toThrow("temporary account RPC failure");
    expect(getByName).toHaveBeenCalledTimes(1);
  });
});
