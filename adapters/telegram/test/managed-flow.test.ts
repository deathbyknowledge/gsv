import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { binaryBodyFromOwnedBytes } from "../../shared/src/media-body";

type TelegramApiMessage = {
  method: string;
  body: { chat_id?: string; text?: string; [key: string]: unknown };
  result: unknown;
};

type ManagedPairingStub = {
  inspect(): Promise<{
    actorId: string;
    surfaceId: string;
    linked: boolean;
  }>;
  prepare(input: {
    code: string;
    installationId: string;
    localUid: number;
    operationId: string;
    canonicalOrigin: string;
  }): Promise<{ route: { installationId: string; localUid: number; generation: string } }>;
  activate(input: {
    code: string;
    operationId: string;
    route: { installationId: string; localUid: number; generation: string };
    canonicalOrigin: string;
  }): Promise<unknown>;
  finalize(input: {
    code: string;
    operationId: string;
    route: { installationId: string; localUid: number; generation: string };
    canonicalOrigin: string;
  }): Promise<unknown>;
};

type ManagedPeerStub = {
  sendMessage(
    installationId: string,
    message: {
      deliveryId: string;
      surface: { kind: "dm"; id: string };
      actorId: string;
      text: string;
      media: Array<{
        type: "audio";
        mimeType: string;
        filename: string;
        size: number;
        body: { offset: number; length: number };
      }>;
    },
    body: ReturnType<typeof binaryBodyFromOwnedBytes>,
  ): Promise<{ ok: boolean; messageId?: string; error?: string }>;
};

function update(updateId: number, messageId: number, text: string): Request {
  return messageUpdate(updateId, messageId, { text });
}

function messageUpdate(
  updateId: number,
  messageId: number,
  content: Record<string, unknown>,
): Request {
  return new Request("https://telegram.test/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "test_webhook_secret_123",
    },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: messageId,
        date: 1_700_000_000 + updateId,
        ...content,
        chat: { id: 12345, type: "private" },
        from: {
          id: 12345,
          is_bot: false,
          first_name: "Hank",
          username: "hank_test",
        },
      },
    }),
  });
}

async function telegramMessages(): Promise<TelegramApiMessage[]> {
  const binding = env.TELEGRAM_API as Fetcher;
  return await (await binding.fetch("https://telegram-api.test/messages")).json();
}

async function gatewayCalls(): Promise<Array<Record<string, unknown>>> {
  const binding = env.GATEWAY as Fetcher;
  return await (await binding.fetch("https://gateway.test/calls")).json();
}

describe("managed Telegram clean-instance flow", () => {
  it("pairs a bot-first identity and routes later messages to the selected installation", async () => {
    expect((await SELF.fetch(update(1, 1, "hello"))).status).toBe(200);
    await vi.waitFor(async () => {
      expect(await telegramMessages()).toHaveLength(1);
    });
    const pairingText = (await telegramMessages())[0]?.body.text ?? "";
    const code = pairingText.match(/[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){2}/)?.[0];
    expect(code).toBeTruthy();
    const normalizedCode = code!.replaceAll("-", "");
    const namespace = env.MANAGED_TELEGRAM_PAIRING as DurableObjectNamespace;
    const pairing = namespace.get(
      namespace.idFromName(`pair:${normalizedCode}`),
    ) as unknown as ManagedPairingStub;

    await expect(pairing.inspect()).resolves.toMatchObject({
      actorId: "12345",
      surfaceId: "12345",
      linked: false,
    });
    const operation = {
      code: normalizedCode,
      installationId: "installation_test",
      localUid: 1000,
      operationId: "operation_test",
      canonicalOrigin: "https://test.gsv.space",
    };
    const prepared = await pairing.prepare(operation);
    await pairing.activate({
      code: normalizedCode,
      operationId: operation.operationId,
      route: prepared.route,
      canonicalOrigin: operation.canonicalOrigin,
    });
    await pairing.finalize({
      code: normalizedCode,
      operationId: operation.operationId,
      route: prepared.route,
      canonicalOrigin: operation.canonicalOrigin,
    });

    expect((await SELF.fetch(update(2, 2, "what is new?"))).status).toBe(200);
    await vi.waitFor(async () => {
      expect(await gatewayCalls()).toContainEqual(expect.objectContaining({
        installation: { installationId: "installation_test" },
        call: "adapter.inbound",
      }));
      expect(await telegramMessages()).toContainEqual(expect.objectContaining({
        body: expect.objectContaining({ text: expect.stringContaining("Personal received") }),
      }));
    });

    expect((await SELF.fetch(messageUpdate(3, 3, {
      voice: {
        file_id: "voice_file_123",
        file_size: 4,
        duration: 2,
        mime_type: "audio/ogg",
      },
    }))).status).toBe(200);
    await vi.waitFor(async () => {
      expect(await gatewayCalls()).toContainEqual(expect.objectContaining({
        installation: { installationId: "installation_test" },
        call: "adapter.inbound",
        args: expect.objectContaining({
          message: expect.objectContaining({
            text: "[Voice note]",
            media: [{
              type: "audio",
              mimeType: "audio/ogg",
              filename: "telegram-voice-3.ogg",
              size: 4,
              duration: 2,
              body: { offset: 0, length: 4 },
            }],
          }),
        }),
        bodyBytes: [1, 2, 3, 4],
      }));
    });

    const peers = env.MANAGED_TELEGRAM_PEER as DurableObjectNamespace;
    const peer = peers.get(
      peers.idFromName("managed:12345"),
    ) as unknown as ManagedPeerStub;
    await expect(peer.sendMessage("installation_test", {
      deliveryId: "outbound-audio-1",
      surface: { kind: "dm", id: "12345" },
      actorId: "12345",
      text: "audio reply",
      media: [{
        type: "audio",
        mimeType: "audio/ogg",
        filename: "reply.ogg",
        size: 4,
        body: { offset: 0, length: 4 },
      }],
    }, binaryBodyFromOwnedBytes(new Uint8Array([5, 6, 7, 8])))).resolves.toMatchObject({
      ok: true,
    });
    await expect(telegramMessages()).resolves.toContainEqual(expect.objectContaining({
      method: "sendAudio",
      body: expect.objectContaining({
        chat_id: "12345",
        caption: "audio reply",
        audio: expect.objectContaining({ bytes: [5, 6, 7, 8] }),
      }),
    }));
    const sentAudioCount = (await telegramMessages())
      .filter((message) => message.method === "sendAudio").length;
    await expect(peer.sendMessage("installation_test", {
      deliveryId: "outbound-audio-1",
      surface: { kind: "dm", id: "12345" },
      actorId: "12345",
      text: "audio reply",
      media: [{
        type: "audio",
        mimeType: "audio/ogg",
        filename: "reply.ogg",
        size: 4,
        body: { offset: 0, length: 4 },
      }],
    }, binaryBodyFromOwnedBytes(new Uint8Array([8, 7, 6, 5])))).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("deliveryId is already bound"),
    });
    expect((await telegramMessages()).filter(
      (message) => message.method === "sendAudio",
    )).toHaveLength(sentAudioCount);
  });
});
