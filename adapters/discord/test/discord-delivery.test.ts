import { afterEach, describe, expect, it, vi } from "vitest";

import { DeliveryLedger } from "../../shared/src/delivery-ledger";
import { deliverDiscordMessage } from "../src/discord-delivery";
import type { AdapterOutboundMessage } from "../../shared/src/types";

class MemoryTransaction {
  constructor(private readonly values: Map<string, StoredValue>) {}

  async get<T>(key: string): Promise<T | undefined> {
    // SAFETY: The fixture returns the value previously stored under this key.
    return this.values.get(key) as T | undefined;
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const entries = [...this.values.entries()]
      .filter(([key]) => !options?.prefix || key.startsWith(options.prefix));
    // SAFETY: The fixture list is requested through the generic storage API.
    return new Map(entries) as Map<string, T>;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      return key.reduce(
        (deleted, item) => deleted + (this.values.delete(item) ? 1 : 0),
        0,
      );
    }
    return this.values.delete(key);
  }
}

class MemoryStorage {
  private readonly values = new Map<string, StoredValue>();

  async transaction<T>(
    closure: (txn: MemoryTransaction) => Promise<T>,
  ): Promise<T> {
    return await closure(new MemoryTransaction(this.values));
  }
}

type StoredValue = object | string | number | null | undefined;
type DiscordRequestPayload = {
  content?: string;
  enforce_nonce?: boolean;
  message_reference?: { message_id?: string };
  nonce?: string;
};

function memoryLedger(): DeliveryLedger {
  return new DeliveryLedger(
    storageFixture(new MemoryStorage()),
  );
}

function storageFixture<T>(value: T): DurableObjectStorage {
  // SAFETY: The in-memory fixture implements the DurableObjectStorage methods exercised here.
  return value as DurableObjectStorage & T;
}

const message: AdapterOutboundMessage = {
  deliveryId: "immediate-command-1",
  surface: { kind: "dm", id: "discord-channel-1" },
  actorId: "discord:user:1",
  text: "Command result",
  replyToId: "discord-inbound-1",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deliverDiscordMessage", () => {
  it("deduplicates replayed immediate replies before provider I/O", async () => {
    const provider = vi.fn(async (_url: string, init?: RequestInit) => {
      // SAFETY: Discord request payload is constructed by the delivery owner above.
      const payload = JSON.parse(String(init?.body)) as DiscordRequestPayload;
      expect(payload).toMatchObject({
        content: "Command result",
        enforce_nonce: true,
        message_reference: { message_id: "discord-inbound-1" },
      });
      expect(payload.nonce).toMatch(/^[0-9a-f]{24}$/);
      return Response.json({ id: "discord-outbound-1" });
    });
    vi.stubGlobal("fetch", provider);
    const ledger = memoryLedger();

    await expect(
      deliverDiscordMessage(ledger, "bot-token", message),
    ).resolves.toEqual({ ok: true, messageId: "discord-outbound-1" });
    await expect(
      deliverDiscordMessage(ledger, "bot-token", message),
    ).resolves.toEqual({
      ok: true,
      messageId: "discord-outbound-1",
      deduplicated: true,
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("rejects changed content under an already-recorded delivery id", async () => {
    const provider = vi.fn(async () => Response.json({ id: "discord-outbound-bound" }));
    vi.stubGlobal("fetch", provider);
    const ledger = memoryLedger();

    await expect(
      deliverDiscordMessage(ledger, "bot-token", message),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      deliverDiscordMessage(ledger, "bot-token", {
        ...message,
        text: "Different command result",
      }),
    ).resolves.toEqual({
      ok: false,
      error: "deliveryId is already bound to a different outbound destination or content",
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("releases definite rate-limit rejections for the same-id retry", async () => {
    const provider = vi
      .fn<(_url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(Response.json({ id: "discord-outbound-2" }));
    vi.stubGlobal("fetch", provider);
    const ledger = memoryLedger();

    await expect(
      deliverDiscordMessage(ledger, "bot-token", message),
    ).resolves.toMatchObject({ ok: false, retryable: true });
    await expect(
      deliverDiscordMessage(ledger, "bot-token", message),
    ).resolves.toEqual({ ok: true, messageId: "discord-outbound-2" });
    expect(provider).toHaveBeenCalledTimes(2);
  });
});
