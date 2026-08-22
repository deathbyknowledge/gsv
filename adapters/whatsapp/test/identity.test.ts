import type { WAMessage } from "@whiskeysockets/baileys";
import { describe, expect, it } from "vitest";

import {
  actorIdFromJid,
  legacyWhatsAppInboundDeliveryId,
  messageTimestampMs,
  normalizeOutboundWhatsAppJid,
  preferredOutboundWhatsAppJid,
  selectInboundUpsertMessages,
  WhatsAppIdentityStore,
  whatsAppDeliverySessionEpoch,
  whatsAppInboundDeliveryId,
  whatsAppInboundDeliveryIdForSession,
  whatsAppSessionScopedDeliveryId,
} from "../src/identity";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  transactionCount = 0;

  async get<T>(key: string): Promise<T | undefined> {
    // SAFETY: Fixture storage returns the generic value requested by the caller.
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    // SAFETY: The fixture map is converted to the generic list contract requested by the test.
    return new Map([...this.values.entries()]
      .filter(([key]) => !options?.prefix || key.startsWith(options.prefix))) as Map<string, T>;
  }

  async delete(key: string | string[]): Promise<boolean> {
    if (Array.isArray(key)) {
      return key.every((item) => this.values.delete(item));
    }
    return this.values.delete(key);
  }

  async transaction<T>(operation: (txn: MemoryStorage) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    return await operation(this);
  }
}

function message(id: string, timestampSeconds: number): WAMessage {
  // SAFETY: Fixture supplies the WAMessage key and timestamp consumed by identity normalization.
  return {
    key: { id, remoteJid: "12025550123@s.whatsapp.net" },
    messageTimestamp: timestampSeconds,
  } as WAMessage;
}

describe("WhatsApp identity", () => {
  it("normalizes phone input without leaking transport syntax to callers", () => {
    expect(normalizeOutboundWhatsAppJid("+1 (202) 555-0123"))
      .toBe("12025550123@s.whatsapp.net");
    expect(normalizeOutboundWhatsAppJid("wa:jid:12345@lid")).toBe("12345@lid");
  });

  it("prefers phone-number addressing for direct outbound encryption", () => {
    const pn = "12025550123@s.whatsapp.net";
    const lid = "987654321@lid";

    expect(preferredOutboundWhatsAppJid(pn, lid)).toBe(pn);
    expect(preferredOutboundWhatsAppJid(lid, pn)).toBe(pn);
    expect(preferredOutboundWhatsAppJid(lid)).toBe(lid);
    expect(() => preferredOutboundWhatsAppJid("status@broadcast")).toThrow(
      "Unsupported WhatsApp destination",
    );
  });

  it("imports a legacy LID actor alias before choosing the v2 canonical id", async () => {
    const storage = new MemoryStorage();
    const lid = "987654321@lid";
    const pn = "12025550123@s.whatsapp.net";
    storage.values.set(`actor_alias:${actorIdFromJid(lid)}`, actorIdFromJid(pn));
    const identities = new WhatsAppIdentityStore(
      storage,
    );

    await expect(identities.canonicalJid(lid)).resolves.toBe(pn);
    await expect(identities.pnForLid(lid)).resolves.toBe(pn);
    await expect(identities.lidForPn(pn)).resolves.toBe(lid);
  });

  it("persists both mapping directions when PN and LID arrive together", async () => {
    const storage = new MemoryStorage();
    const identities = new WhatsAppIdentityStore(
      storage,
    );
    const lid = "987654321@lid";
    const pn = "12025550123@s.whatsapp.net";

    await expect(identities.canonicalJid(lid, pn)).resolves.toBe(pn);
    await expect(identities.pnForLid(lid)).resolves.toBe(pn);
    await expect(identities.lidForPn(pn)).resolves.toBe(lid);
  });

  it("binds large history mapping sets in bounded storage transactions", async () => {
    const storage = new MemoryStorage();
    const identities = new WhatsAppIdentityStore(
      storage,
    );
    const mappings = Array.from({ length: 300 }, (_, index) => ({
      lid: `${900000000 + index}@lid`,
      pn: `${12025550000 + index}@s.whatsapp.net`,
    }));

    await identities.bindLidPnMappings(mappings);
    expect(storage.transactionCount).toBe(3);
    await expect(identities.pnForLid(mappings[299].lid))
      .resolves.toBe(mappings[299].pn);
  });

  it("rejects malformed legacy aliases", async () => {
    const storage = new MemoryStorage();
    const lid = "987654321@lid";
    storage.values.set(
      `actor_alias:${actorIdFromJid(lid)}`,
      "wa:jid:12345@g.us",
    );
    const identities = new WhatsAppIdentityStore(
      storage,
    );

    await expect(identities.canonicalJid(lid)).resolves.toBe(lid);
    await expect(identities.pnForLid(lid)).resolves.toBeNull();
  });

  it("keeps the Gateway receipt key unchanged until the provider session changes", async () => {
    const input = {
      remoteCanonicalJid: "12025550123@s.whatsapp.net",
      senderCanonicalJid: "12025550124@s.whatsapp.net",
      legacyRemoteJid: "987654321@lid",
      legacyParticipantJid: "987654322@lid",
      providerMessageId: "provider-cutover",
    };
    const legacyId = legacyWhatsAppInboundDeliveryId(
      input.legacyRemoteJid,
      input.legacyParticipantJid,
      input.providerMessageId,
    );
    expect(legacyId).toBe("987654321@lid:987654322@lid:provider-cutover");
    expect(legacyWhatsAppInboundDeliveryId(
      input.remoteCanonicalJid,
      undefined,
      input.providerMessageId,
    )).toBe("12025550123@s.whatsapp.net::provider-cutover");
    await expect(whatsAppInboundDeliveryId(
      input.remoteCanonicalJid,
      input.senderCanonicalJid,
      input.providerMessageId,
    )).resolves.toMatch(/^wa:[0-9a-f]{64}$/);

    await expect(whatsAppInboundDeliveryIdForSession(0, input))
      .resolves.toBe(legacyId);
    await expect(whatsAppInboundDeliveryIdForSession(0, {
      ...input,
      remoteCanonicalJid: "different-canonical@lid",
      senderCanonicalJid: undefined,
    })).resolves.toBe(legacyId);

    const replacementId = await whatsAppInboundDeliveryIdForSession(1, input);
    expect(replacementId).toMatch(/^wa-session:1:[0-9a-f]{64}$/);
    expect(replacementId).not.toBe(legacyId);
    await expect(whatsAppInboundDeliveryIdForSession(1, {
      ...input,
      senderCanonicalJid: undefined,
    })).resolves.not.toBe(replacementId);
  });

  it("namespaces delivery ledgers after a provider-session replacement", async () => {
    await expect(whatsAppSessionScopedDeliveryId(0, "delivery-1"))
      .resolves.toBe("delivery-1");
    const first = await whatsAppSessionScopedDeliveryId(1, "delivery-1");
    const second = await whatsAppSessionScopedDeliveryId(2, "delivery-1");
    expect(first).toMatch(/^wa-session:1:[0-9a-f]{64}$/);
    expect(second).toMatch(/^wa-session:2:[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
    expect(whatsAppDeliverySessionEpoch(first)).toBe(1);
    expect(whatsAppDeliverySessionEpoch("legacy-delivery")).toBe(0);
  });
});

describe("WhatsApp inbound batch selection", () => {
  it("processes every live notify message", () => {
    const messages = Array.from({ length: 150 }, (_, index) =>
      message(`live-${index}`, 1_700_000_000 + index)
    );
    expect(selectInboundUpsertMessages("notify", messages, 100, 0)).toHaveLength(150);
  });

  it("bounds append catch-up by age and count while preserving order", () => {
    const messages = [
      message("new-3", 300),
      message("old", 50),
      message("new-1", 100),
      message("new-2", 200),
    ];
    expect(selectInboundUpsertMessages("append", messages, 2, 100_000)
      .map((item) => item.key.id)).toEqual(["new-2", "new-3"]);
  });

  it("normalizes second and millisecond timestamps", () => {
    expect(messageTimestampMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(messageTimestampMs(1_700_000_000_123)).toBe(1_700_000_000_123);
    expect(messageTimestampMs("not-a-time")).toBeUndefined();
  });
});
