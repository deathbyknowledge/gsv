import { describe, expect, it } from "vitest";
import type { ConsoleAdapter, ConsoleAdapterAccount } from "../domain/consoleModels";
import {
  SUPPORTED_MESSENGER_ADAPTERS,
  actionableAdapterError,
  adapterDetailSections,
  adapterLabel,
  canDisconnectAdapter,
  iconForAdapterName,
  messengerAccountNoun,
  messengerFamilies,
} from "./messengerPresentation";

const whatsappAccount: ConsoleAdapterAccount = {
  adapter: "whatsapp",
  accountId: "default",
  connected: true,
  authenticated: true,
  mode: "websocket",
  lastActivity: 1_800_000_000_000,
  error: "",
  extra: {
    selfE164: "+31612345678",
    selfJid: "31612345678:1@s.whatsapp.net",
    lastConnectedAt: 1_800_000_000_000,
  },
};

describe("messenger presentation", () => {
  it("treats WhatsApp as a supported account-based messenger", () => {
    expect(SUPPORTED_MESSENGER_ADAPTERS).toContain("whatsapp");
    expect(messengerAccountNoun("whatsapp", 1)).toBe("account");
    expect(messengerAccountNoun("whatsapp", 2)).toBe("accounts");
    expect(messengerAccountNoun("telegram", 1)).toBe("bot");
    expect(iconForAdapterName("whatsapp")).toBe("doticons/whatsapp");
  });

  it("prefers the paired phone number and does not expose the raw JID", () => {
    expect(adapterLabel(whatsappAccount)).toBe("+31612345678");
    const rowValues = adapterDetailSections(whatsappAccount)
      .flatMap((section) => section.rows.map((row) => row.sub));
    expect(rowValues).toContain("+31612345678");
    expect(rowValues).not.toContain("31612345678:1@s.whatsapp.net");
  });

  it("turns common WhatsApp failures into recovery guidance", () => {
    expect(actionableAdapterError("whatsapp", "connection closed with status 401"))
      .toContain("fresh QR code");
    expect(actionableAdapterError("whatsapp", "rate_limit: 429"))
      .toContain("Wait a few minutes");
    expect(actionableAdapterError("whatsapp", "connection closed with status 515"))
      .toContain("connection restart");
    expect(actionableAdapterError("whatsapp", "connection replaced with status 440"))
      .toContain("another linked device");
    expect(actionableAdapterError("telegram", "raw provider error"))
      .toBe("raw provider error");
  });

  it("keeps logout available only for accounts that may still hold credentials", () => {
    expect(canDisconnectAdapter({ ...whatsappAccount, connected: false, authenticated: true })).toBe(true);
    expect(canDisconnectAdapter({ ...whatsappAccount, connected: false, authenticated: false })).toBe(false);
    expect(canDisconnectAdapter({
      ...whatsappAccount,
      adapter: "telegram",
      connected: false,
      authenticated: true,
    })).toBe(false);
  });

  it("distinguishes omitted inventory from an absent adapter binding", () => {
    expect(messengerFamilies([], undefined).find(({ adapter }) => adapter === "whatsapp")?.status)
      .toMatchObject({ label: "NOT ENABLED", tone: "idle" });

    const inventory: ConsoleAdapter[] = [];
    expect(messengerFamilies([], inventory).find(({ adapter }) => adapter === "whatsapp")?.status)
      .toMatchObject({ label: "UNAVAILABLE", tone: "warn" });
  });
});
