import * as deployedAdapter from "../src/managed";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { binaryBodyFromOwnedBytes } from "../../shared/src/media-body";

type TelegramApiMessage = {
  method: string;
  body: {
    chat_id?: string;
    text?: string;
    caption?: string;
    audio?: { bytes?: number[] };
    message_id?: string | number;
    reply_parameters?: { message_id: number };
    reply_markup?: {
      inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>>;
    };
  };
  result: { ok?: boolean; message_id?: number } | boolean;
};

type TelegramUpdateContent = { text?: string; voice?: { file_id: string; file_size: number; duration: number; mime_type: string } };
type GatewayCall = {
  installation?: { installationId?: string };
  linkedContext?: {
    accountId?: string;
    actorId?: string;
    routeGeneration?: string;
    interactionId?: string;
  };
  call?: string;
  args?: {
    routeGeneration?: string;
    message?: { text?: string; media?: Array<{ type: string }> };
    pid?: string;
    requestId?: string;
    decision?: string;
    remember?: boolean;
  };
  input?: { accountId?: string; actorId?: string; expectedGeneration?: string };
  bodyBytes?: number[];
};
type ManagedOperationResult = { ok?: boolean };

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
  }): Promise<ManagedOperationResult>;
  finalize(input: {
    code: string;
    operationId: string;
    route: { installationId: string; localUid: number; generation: string };
    canonicalOrigin: string;
  }): Promise<ManagedOperationResult>;
};

type ManagedPeerStub = {
  sendMessage(
    installationId: string,
    message: {
      deliveryId: string;
      surface: { kind: "dm"; id: string };
      actorId: string;
      routeGeneration: string;
      text: string;
      media?: Array<{
        type: "audio";
        mimeType: string;
        filename: string;
        size: number;
        body: { offset: number; length: number };
      }>;
    },
    body?: ReturnType<typeof binaryBodyFromOwnedBytes>,
    context?: {
      deliveryId: string;
      accountId: string;
      actorId: string;
      surface: { kind: "dm"; id: string };
      routeGeneration: string;
      processId: string;
      runId: string;
      processMode: "ship";
      hil: {
        pid: string;
        requestId: string;
        runId: string;
        callId: string;
        toolName: string;
        syscall: string;
        target: string;
        args: { input: string };
        createdAt: number;
      };
    },
  ): Promise<{ ok: boolean; messageId?: string; error?: string; retryable?: boolean }>;
  setTyping(
    installationId: string,
    surface: { kind: "dm"; id: string },
    actorId: string,
    routeGeneration: string,
    active: boolean,
  ): Promise<{ accepted: boolean }>;
};

function update(updateId: number, messageId: number, text: string): Request {
  return messageUpdate(updateId, messageId, { text });
}

function messageUpdate(
  updateId: number,
  messageId: number,
  content: TelegramUpdateContent,
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

function approvalUpdate(
  updateId: number,
  callbackQueryId: string,
  messageId: number,
  data: string,
): Request {
  return new Request("https://telegram.test/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "test_webhook_secret_123",
    },
    body: JSON.stringify({
      update_id: updateId,
      callback_query: {
        id: callbackQueryId,
        from: { id: 12345, is_bot: false, first_name: "Hank" },
        message: {
          message_id: messageId,
          chat: { id: 12345, type: "private" },
        },
        data,
      },
    }),
  });
}

async function telegramMessages(): Promise<TelegramApiMessage[]> {
  // SAFETY: The Cloudflare test environment declares TELEGRAM_API as a Fetcher binding.
  const binding = env.TELEGRAM_API as Fetcher;
  return await (await binding.fetch("https://telegram-api.test/messages")).json();
}

async function gatewayCalls(): Promise<GatewayCall[]> {
  // SAFETY: The Cloudflare test environment declares GATEWAY as a Fetcher binding.
  const binding = env.GATEWAY as Fetcher;
  return await (await binding.fetch("https://gateway.test/calls")).json();
}

function typedStub<T, V>(value: V): T {
  // SAFETY: Cloudflare test bindings implement the explicitly declared RPC contract.
  return value as T;
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
    // SAFETY: The test environment exposes the declared Durable Object namespace binding.
    const namespace = env.MANAGED_TELEGRAM_PAIRING as DurableObjectNamespace;
    const pairing = typedStub<ManagedPairingStub>(namespace.get(
      namespace.idFromName(`pair:${normalizedCode}`),
    ));

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
    const firstGeneration = prepared.route.generation;
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
        args: expect.objectContaining({ routeGeneration: firstGeneration }),
      }));
      expect(await telegramMessages()).toContainEqual(expect.objectContaining({
        body: expect.objectContaining({ text: expect.stringContaining("Personal received") }),
      }));
    });

    // The targeted send carries the exact HIL request, and the provider callback
    // returns through the ordinary linked-human proc.hil path.
    // SAFETY: The test environment exposes the declared Durable Object namespace binding.
    const peers = env.MANAGED_TELEGRAM_PEER as DurableObjectNamespace;
    const peer = typedStub<ManagedPeerStub>(peers.get(
      peers.idFromName("managed:12345"),
    ));
    const hil = {
      pid: "proc-approval",
      requestId: "request-approval",
      runId: "run-approval",
      callId: "call-approval",
      toolName: "Shell",
      syscall: "shell.exec",
      target: "gsv",
      args: { input: "date" },
      createdAt: 1_700_000_100_000,
    };
    const approvalContext = {
      deliveryId: "run-approval:hil:request-approval",
      accountId: "managed",
      actorId: "12345",
      surface: { kind: "dm" as const, id: "12345" },
      routeGeneration: firstGeneration,
      processId: "proc-approval",
      runId: "run-approval",
      processMode: "ship" as const,
      hil,
    };
    await peer.sendMessage(
      "installation_test",
      {
        deliveryId: approvalContext.deliveryId,
        surface: approvalContext.surface,
        actorId: approvalContext.actorId,
        routeGeneration: approvalContext.routeGeneration,
        text: "",
      },
      undefined,
      approvalContext,
    );
    let approvalMessage: TelegramApiMessage | undefined;
    await vi.waitFor(async () => {
      approvalMessage = (await telegramMessages()).findLast((message) => (
        (message.method === "sendMessage" || message.method === "sendRichMessage")
        && message.body.reply_markup?.inline_keyboard?.length
      ));
      expect(approvalMessage).toBeDefined();
    });
    const approvalResult = approvalMessage?.result;
    const approvalMessageId = approvalResult === undefined
        || approvalResult === true
        || approvalResult === false
      ? undefined
      : approvalResult.message_id;
    const approveAlwaysData = approvalMessage?.body.reply_markup
      ?.inline_keyboard?.[0]?.[1]?.callback_data;
    expect(approvalMessage?.body.text).toContain("Requested action: run \"date\".");
    expect(approvalMessageId).toBeTruthy();
    expect(approveAlwaysData).toMatch(/^gsvh:[A-Za-z0-9_-]{16}:a$/);

    expect((await SELF.fetch(approvalUpdate(
      3,
      "callback-approval",
      approvalMessageId!,
      approveAlwaysData!,
    ))).status).toBe(200);
    await vi.waitFor(async () => {
      expect(await gatewayCalls()).toContainEqual(expect.objectContaining({
        installation: { installationId: "installation_test" },
        linkedContext: expect.objectContaining({
          accountId: "managed",
          actorId: "12345",
          routeGeneration: firstGeneration,
          interactionId: "callback-approval",
        }),
        call: "proc.hil",
        args: {
          pid: "proc-approval",
          requestId: "request-approval",
          decision: "approve",
          remember: true,
        },
      }));
      expect(await telegramMessages()).toContainEqual(expect.objectContaining({
        method: "editMessageText",
        body: expect.objectContaining({
          chat_id: "12345",
          message_id: approvalMessageId,
          text: expect.stringContaining("Approved for this conversation."),
        }),
      }));
    });
    const resolvedApproval = (await telegramMessages()).findLast((message) => (
      message.method === "editMessageText"
      && message.body.message_id === approvalMessageId
    ));
    expect(resolvedApproval?.body.text).toContain("Requested action: run \"date\".");
    expect(resolvedApproval?.body.text).not.toContain("I need your confirmation");
    expect(resolvedApproval?.body.text).not.toContain("hil[");

    const approvalCalls = (await gatewayCalls()).filter((call) => call.call === "proc.hil");
    expect((await SELF.fetch(approvalUpdate(
      100,
      "callback-approval-replay",
      approvalMessageId!,
      approveAlwaysData!,
    ))).status).toBe(200);
    await vi.waitFor(async () => {
      expect((await gatewayCalls()).filter((call) => call.call === "proc.hil"))
        .toHaveLength(approvalCalls.length);
      expect(await telegramMessages()).toContainEqual(expect.objectContaining({
        method: "answerCallbackQuery",
        body: expect.objectContaining({ callback_query_id: "callback-approval-replay" }),
      }));
    });

    expect((await SELF.fetch(messageUpdate(4, 3, {
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

    expect((await SELF.fetch(update(5, 4, "__gateway_unavailable__"))).status).toBe(200);
    await vi.waitFor(async () => {
      expect(await gatewayCalls()).toContainEqual(expect.objectContaining({
        args: expect.objectContaining({
          message: expect.objectContaining({ text: "__gateway_unavailable__" }),
        }),
      }));
    });
    const messagesBeforePairCommand = (await telegramMessages()).length;
    expect((await SELF.fetch(update(6, 5, "/start"))).status).toBe(200);
    await vi.waitFor(async () => {
      const messages = await telegramMessages();
      expect(messages.length).toBeGreaterThan(messagesBeforePairCommand);
      expect(messages.at(-1)?.body.text).toContain("Pairing code:");
    });
    const relinkText = (await telegramMessages()).at(-1)?.body.text ?? "";
    const relinkCode = relinkText.match(/[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){2}/)?.[0];
    expect(relinkCode).toBeTruthy();
    const normalizedRelinkCode = relinkCode!.replaceAll("-", "");
    const relinking = typedStub<ManagedPairingStub>(namespace.get(
      namespace.idFromName(`pair:${normalizedRelinkCode}`),
    ));
    const relinkOperation = {
      code: normalizedRelinkCode,
      installationId: "installation_test",
      localUid: 1000,
      operationId: "operation_relink",
      canonicalOrigin: "https://test.gsv.space",
    };
    const relinked = await relinking.prepare(relinkOperation);
    await relinking.activate({
      code: normalizedRelinkCode,
      operationId: relinkOperation.operationId,
      route: relinked.route,
      canonicalOrigin: relinkOperation.canonicalOrigin,
    });
    await relinking.finalize({
      code: normalizedRelinkCode,
      operationId: relinkOperation.operationId,
      route: relinked.route,
      canonicalOrigin: relinkOperation.canonicalOrigin,
    });
    expect(relinked.route.generation).not.toBe(firstGeneration);
    await vi.waitFor(async () => {
      expect(await gatewayCalls()).toContainEqual(expect.objectContaining({
        installation: { installationId: "installation_test" },
        call: "unlinkAdapterIdentity",
        input: expect.objectContaining({
          accountId: "managed",
          actorId: "12345",
          expectedGeneration: firstGeneration,
        }),
      }));
    });

    await expect(peer.setTyping(
      "installation_test",
      { kind: "dm", id: "12345" },
      "12345",
      firstGeneration,
      true,
    )).resolves.toEqual({ accepted: false });
    await expect(peer.setTyping(
      "installation_test",
      { kind: "dm", id: "12345" },
      "12345",
      relinked.route.generation,
      true,
    )).resolves.toEqual({ accepted: true });
    await expect(peer.sendMessage("installation_test", {
      deliveryId: "stale-after-relink",
      surface: { kind: "dm", id: "12345" },
      actorId: "12345",
      routeGeneration: firstGeneration,
      text: "stale output",
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("route changed"),
    });
    expect((await telegramMessages()).some(
      (message) => message.body.text === "stale output",
    )).toBe(false);

    await expect(peer.sendMessage("installation_test", {
      deliveryId: "outbound-audio-1",
      surface: { kind: "dm", id: "12345" },
      actorId: "12345",
      routeGeneration: relinked.route.generation,
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
      routeGeneration: relinked.route.generation,
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

    // A long reply goes out as paragraph messages in order: the greeting and
    // intro stay with the paragraph they introduce, a paragraph past Telegram's
    // limit is split, only the first message quotes the inbound, and the bot
    // types between messages.
    const isText = (message: TelegramApiMessage): boolean =>
      message.method === "sendMessage" || message.method === "sendRichMessage";
    const recordsBeforeParagraphs = (await telegramMessages()).length;
    const longParagraph = "word ".repeat(1_000).trimEnd();
    await expect(peer.sendMessage("installation_test", {
      deliveryId: "outbound-paragraphs-1",
      surface: { kind: "dm", id: "12345" },
      actorId: "12345",
      routeGeneration: relinked.route.generation,
      text: `Hi Hank!\n\nHere is the report.\n\n${longParagraph}\n\nAnything else?`,
      replyToId: "5",
    })).resolves.toMatchObject({ ok: true, messageId: expect.any(String) });
    const paragraphRecords = (await telegramMessages()).slice(recordsBeforeParagraphs);
    expect(paragraphRecords.map((record) => record.method)).toEqual([
      "sendRichMessage", "sendChatAction", "sendRichMessage", "sendChatAction", "sendRichMessage",
    ]);
    const paragraphMessages = paragraphRecords.filter(isText);
    expect(paragraphMessages.map((message) => message.body.text)).toEqual([
      expect.stringMatching(/^Hi Hank!\n\nHere is the report\.\n\nword word/),
      expect.stringMatching(/^word word/),
      "Anything else?",
    ]);
    expect(paragraphMessages.every((message) => [...message.body.text ?? ""].length <= 4096)).toBe(true);
    expect(paragraphMessages[0]!.body.reply_parameters).toEqual({ message_id: 5 });
    expect(paragraphMessages[1]!.body.reply_parameters).toBeUndefined();
    expect(paragraphMessages[2]!.body.reply_parameters).toBeUndefined();

    // A rate limit on the second message leaves the first delivered, reports a
    // retryable failure, and the retry sends only the messages still missing.
    const partA = "a".repeat(400);
    const partB = `__rate_limit_once__ ${"b".repeat(400)}`;
    const partC = "c".repeat(400);
    const resumed = {
      deliveryId: "outbound-resume-1",
      surface: { kind: "dm" as const, id: "12345" },
      actorId: "12345",
      routeGeneration: relinked.route.generation,
      text: `${partA}\n\n${partB}\n\n${partC}`,
    };
    await expect(peer.sendMessage("installation_test", resumed))
      .resolves.toMatchObject({ ok: false, retryable: true });
    const textsSent = async (): Promise<string[]> =>
      (await telegramMessages()).filter(isText).map((message) => message.body.text ?? "");
    expect((await textsSent()).filter((text) => text === partA)).toHaveLength(1);
    expect((await textsSent()).filter((text) => text === partB)).toHaveLength(0);
    expect((await textsSent()).filter((text) => text === partC)).toHaveLength(0);
    const retry = await peer.sendMessage("installation_test", resumed);
    expect(retry).toMatchObject({ ok: true, messageId: expect.any(String) });
    expect((await textsSent()).filter((text) => text === partA)).toHaveLength(1);
    expect((await textsSent()).filter((text) => text === partB)).toHaveLength(1);
    expect((await textsSent()).filter((text) => text === partC)).toHaveLength(1);
    // The delivery reports the first message's id, sent before the rate limit.
    expect((await telegramMessages()).find((message) => message.body.text === partA))
      .toMatchObject({ result: { message_id: Number(retry.messageId) } });
  });
});

it("does not export the retired per-account deployment entrypoints", async () => {
  expect(deployedAdapter).not.toHaveProperty("TelegramChannel");
  expect(deployedAdapter).not.toHaveProperty("TelegramAccount");
  expect((await SELF.fetch("https://fixture/webhook/default", { method: "POST", body: "{}" })).status).toBe(404);
});
