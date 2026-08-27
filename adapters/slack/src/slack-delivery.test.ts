import { describe, expect, it, vi } from "vitest";
import { DeliveryLedger } from "../../shared/src/delivery-ledger";
import { binaryBodyFromOwnedBytes } from "../../shared/src/media-body";
import type { AdapterOutboundMessage } from "./types";
import { deliverSlackMessage } from "./slack-delivery";

type StoredValue = object | string | number | null | undefined;

class MemoryTransaction {
  constructor(private readonly values: Map<string, StoredValue>) {}

  async get<T>(key: string): Promise<T | undefined> {
    // SAFETY: the fixture returns the value stored under the requested key.
    return this.values.get(key) as T | undefined;
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const entries = [...this.values.entries()]
      .filter(([key]) => !options?.prefix || key.startsWith(options.prefix));
    // SAFETY: the fixture implements the generic storage list contract used by the ledger.
    return new Map(entries) as Map<string, T>;
  }

  async put<T>(key: string, value: T): Promise<void> {
    // SAFETY: DeliveryLedger writes only storage-compatible values in this fixture.
    this.values.set(key, value as StoredValue);
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      return key.reduce((count, item) => count + (this.values.delete(item) ? 1 : 0), 0);
    }
    return this.values.delete(key);
  }
}

class MemoryStorage {
  private readonly values = new Map<string, StoredValue>();

  async transaction<T>(closure: (txn: MemoryTransaction) => Promise<T>): Promise<T> {
    return await closure(new MemoryTransaction(this.values));
  }
}

function ledger(): DeliveryLedger {
  // SAFETY: this in-memory fixture implements the storage methods exercised by DeliveryLedger.
  return new DeliveryLedger(new MemoryStorage() as MemoryStorage & DurableObjectStorage);
}

const publicMessage: AdapterOutboundMessage = {
  deliveryId: "slack-public-1",
  surface: {
    kind: "channel",
    id: "CGENERAL1",
    threadId: "1700000000.000100",
  },
  actorId: "UALICE01",
  text: "The answer is 42.",
};

describe("Slack delivery", () => {
  it("attributes shared-channel output to the linked Slack actor", async () => {
    const provider = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer xoxb-valid-token-value" });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        channel: "CGENERAL1",
        thread_ts: "1700000000.000100",
        text: "*From <@UALICE01>'s GSV:*\nThe answer is 42.",
      });
      return Response.json({ ok: true, channel: "CGENERAL1", ts: "1700000001.000200" });
    });
    const deliveries = ledger();
    await expect(deliverSlackMessage(
      deliveries,
      "xoxb-valid-token-value",
      publicMessage,
      undefined,
      { attributedActorId: "UALICE01", slackFetch: provider },
    )).resolves.toEqual({ ok: true, messageId: "1700000001.000200" });
    await expect(deliverSlackMessage(
      deliveries,
      "xoxb-valid-token-value",
      publicMessage,
      undefined,
      { attributedActorId: "UALICE01", slackFetch: provider },
    )).resolves.toEqual({
      ok: true,
      messageId: "1700000001.000200",
      deduplicated: true,
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("does not prefix private output", async () => {
    const provider = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).text).toBe("Private answer");
      return Response.json({ ok: true, channel: "DALICE01", ts: "1700000001.000201" });
    });
    await expect(deliverSlackMessage(
      ledger(),
      "xoxb-valid-token-value",
      {
        deliveryId: "slack-private-1",
        surface: { kind: "dm", id: "DALICE01" },
        actorId: "UALICE01",
        text: "Private answer",
      },
      undefined,
      { slackFetch: provider },
    )).resolves.toMatchObject({ ok: true });
  });

  it("rejects a public delivery attributed to another actor", async () => {
    const provider = vi.fn();
    await expect(deliverSlackMessage(
      ledger(),
      "xoxb-valid-token-value",
      publicMessage,
      undefined,
      { attributedActorId: "UBOB0001", slackFetch: provider },
    )).resolves.toMatchObject({ ok: false, error: expect.stringContaining("attribution") });
    expect(provider).not.toHaveBeenCalled();
  });

  it("uploads GSV resource bytes once and attributes media-only channel output", async () => {
    const bytes = new TextEncoder().encode("resource bytes");
    const provider = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/files.getUploadURLExternal")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          filename: "report.txt",
          length: bytes.byteLength,
        });
        return Response.json({
          ok: true,
          upload_url: "https://files.slack.com/upload/v1/report",
          file_id: "FREPORT1",
        });
      }
      if (url.pathname === "/upload/v1/report") {
        await expect(new Response(init?.body).text()).resolves.toBe("resource bytes");
        return new Response("OK");
      }
      expect(url.pathname).toMatch(/files\.completeUploadExternal$/);
      expect(JSON.parse(String(init?.body))).toEqual({
        channel_id: "CGENERAL1",
        files: [{ id: "FREPORT1" }],
        initial_comment: "*From <@UALICE01>'s GSV:*",
        thread_ts: "1700000000.000100",
      });
      return Response.json({ ok: true, files: [{ id: "FREPORT1" }] });
    });
    const message: AdapterOutboundMessage = {
      ...publicMessage,
      deliveryId: "slack-public-file-1",
      text: "",
      media: [{
        type: "document",
        mimeType: "text/plain",
        filename: "report.txt",
        body: { offset: 0, length: bytes.byteLength },
      }],
    };
    const deliveries = ledger();
    const first = await deliverSlackMessage(
      deliveries,
      "xoxb-valid-token-value",
      message,
      binaryBodyFromOwnedBytes(bytes.slice()),
      { attributedActorId: "UALICE01", slackFetch: provider },
    );
    expect(first).toEqual({ ok: true, messageId: "FREPORT1" });
    const replay = await deliverSlackMessage(
      deliveries,
      "xoxb-valid-token-value",
      message,
      binaryBodyFromOwnedBytes(bytes.slice()),
      { attributedActorId: "UALICE01", slackFetch: provider },
    );
    expect(replay).toEqual({ ok: true, messageId: "FREPORT1", deduplicated: true });
    expect(provider).toHaveBeenCalledTimes(3);
  });
});
