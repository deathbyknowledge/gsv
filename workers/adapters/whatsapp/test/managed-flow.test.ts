import * as deployedAdapter from "../src/managed";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { binaryBodyFromOwnedBytes } from "../../shared/src/media-body";
import type { ManagedWhatsAppPeer } from "../src/managed-peer";
import type { ManagedWhatsAppPeerState } from "../src/managed-peer-state";

const APP_SECRET = "test_app_secret_0123456789";
const PHONE_NUMBER_ID = "111222333444555";
const ACTOR = "34611111189";
const STATE_KEY = "managed_whatsapp_peer:v1:state";

type ReplyButton = { type: "reply"; reply: { id: string; title: string } };
type GraphRecord = {
  kind: "message" | "read" | "upload";
  phoneNumberId?: string;
  body: {
    to?: string;
    type?: string;
    text?: { body: string };
    audio?: { id?: string; link?: string };
    image?: { id?: string; link?: string; caption?: string };
    interactive?: { type: string; body: { text: string }; action: { buttons: ReplyButton[] } };
    template?: {
      name: string;
      language: { code: string };
      components: Array<{
        type: string;
        sub_type?: string;
        index?: string;
        parameters: Array<{ type: string; text?: string; payload?: string }>;
      }>;
    };
    context?: { message_id: string };
    status?: string;
    message_id?: string;
    typing_indicator?: { type: string };
    file?: { name: string; type: string; bytes: number[] };
  };
  result: { id?: string; success?: boolean };
};
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
    actorName?: string;
    actorHandle?: string;
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
      replyToId?: string;
      media?: Array<{
        type: "audio" | "image";
        mimeType: string;
        filename?: string;
        size?: number;
        url?: string;
        body?: { offset: number; length: number };
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
  ): Promise<{ ok: boolean; messageId?: string; error?: string }>;
  setTyping(
    installationId: string,
    surface: { kind: "dm"; id: string },
    actorId: string,
    routeGeneration: string,
    active: boolean,
  ): Promise<{ accepted: boolean }>;
};

type RejectedRecord = {
  kind: string;
  status: number;
  body: { to?: string; text?: { body: string }; context?: { message_id: string } };
};
type MessageContent =
  | { type: "text"; text: { body: string } }
  | { type: "audio"; audio: { id: string; mime_type: string; voice: boolean } }
  | { type: "image"; image: { id: string; mime_type: string } }
  | { type: "reaction"; reaction: { message_id: string; emoji: string } }
  | { type: "interactive"; context: { from: string; id: string }; interactive: { type: "button_reply"; button_reply: { id: string; title: string } } }
  | { type: "button"; context: { from: string; id: string }; button: { payload: string; text: string } };

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function notification(
  messageId: string,
  content: MessageContent,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<Request> {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: "9876543210",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "34600000000", phone_number_id: PHONE_NUMBER_ID },
          contacts: [{ profile: { name: "Hank Human" }, wa_id: ACTOR }],
          messages: [{ from: ACTOR, id: messageId, timestamp: String(timestamp), ...content }],
        },
      }],
    }],
  });
  return new Request("https://whatsapp.test/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Hub-Signature-256": await sign(body) },
    body,
  });
}

function text(messageId: string, body: string): Promise<Request> {
  return notification(messageId, { type: "text", text: { body } });
}

async function graphRecords(): Promise<GraphRecord[]> {
  // SAFETY: The Cloudflare test environment declares WHATSAPP_API as a Fetcher binding.
  const binding = env.WHATSAPP_API as Fetcher;
  return await (await binding.fetch("https://graph.test/records")).json();
}

async function sentMessages(): Promise<GraphRecord[]> {
  return (await graphRecords()).filter((record) => record.kind === "message");
}

async function templateMessages(): Promise<GraphRecord[]> {
  return (await sentMessages()).filter((record) => record.body.type === "template");
}

function templateParameter(record: GraphRecord | undefined): string | undefined {
  return record?.body.template?.components.find((component) => component.type === "body")?.parameters[0]?.text;
}

/** Sends the fake Graph API refused on purpose, so an attempt can be told from a delivery. */
async function rejectedSends(): Promise<RejectedRecord[]> {
  // SAFETY: The Cloudflare test environment declares WHATSAPP_API as a Fetcher binding.
  const binding = env.WHATSAPP_API as Fetcher;
  return await (await binding.fetch("https://graph.test/rejected")).json();
}

/** Makes the fake Graph API answer 429 to texts carrying `marker`; an empty marker lifts it. */
async function throttle(marker: string): Promise<void> {
  // SAFETY: The Cloudflare test environment declares WHATSAPP_API as a Fetcher binding.
  const binding = env.WHATSAPP_API as Fetcher;
  await binding.fetch("https://graph.test/throttle", { method: "POST", body: marker });
}

async function heldKeys(stub: DurableObjectStub<ManagedWhatsAppPeer>): Promise<string[]> {
  return await runInDurableObject(stub, async (_instance, context) => (
    [...(await context.storage.list({ prefix: "managed_whatsapp_peer:v1:held:" })).keys()]
  ));
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

describe("managed WhatsApp clean-instance flow", () => {
  it("pairs a number-first identity and routes later messages to the selected installation", async () => {
    expect((await SELF.fetch(await text("wamid.in.1", "hello"))).status).toBe(200);
    await vi.waitFor(async () => {
      expect(await sentMessages()).toHaveLength(1);
    });
    const pairingMessage = (await sentMessages())[0]!;
    expect(pairingMessage.body.to).toBe(ACTOR);
    expect(pairingMessage.body.context).toEqual({ message_id: "wamid.in.1" });
    const pairingText = pairingMessage.body.text?.body ?? "";
    expect(pairingText).toContain("Settings → Messengers → WhatsApp");
    const code = pairingText.match(/[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){2}/)?.[0];
    expect(code).toBeTruthy();
    const normalizedCode = code!.replaceAll("-", "");
    // SAFETY: The test environment exposes the declared Durable Object namespace binding.
    const namespace = env.MANAGED_WHATSAPP_PAIRING as DurableObjectNamespace;
    const pairing = typedStub<ManagedPairingStub>(namespace.get(
      namespace.idFromName(`pair:${normalizedCode}`),
    ));

    await expect(pairing.inspect()).resolves.toMatchObject({
      actorId: ACTOR,
      surfaceId: ACTOR,
      actorName: "Hank Human",
      actorHandle: "+34•••••••89",
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
    await vi.waitFor(async () => {
      expect(await sentMessages()).toContainEqual(expect.objectContaining({
        body: expect.objectContaining({ text: { preview_url: false, body: "Connected to https://test.gsv.space" } }),
      }));
    });

    expect((await SELF.fetch(await text("wamid.in.2", "what is new?"))).status).toBe(200);
    await vi.waitFor(async () => {
      expect(await gatewayCalls()).toContainEqual(expect.objectContaining({
        installation: { installationId: "installation_test" },
        call: "adapter.inbound",
        args: expect.objectContaining({ adapter: "whatsapp", accountId: "managed", routeGeneration: firstGeneration }),
      }));
      expect(await sentMessages()).toContainEqual(expect.objectContaining({
        body: expect.objectContaining({
          text: expect.objectContaining({ body: expect.stringContaining("Personal received") }),
          context: { message_id: "wamid.in.2" },
        }),
      }));
      expect(await graphRecords()).toContainEqual(expect.objectContaining({
        kind: "read",
        body: { messaging_product: "whatsapp", status: "read", message_id: "wamid.in.2" },
      }));
    });

    // The targeted send carries the exact HIL request as reply buttons, and the
    // pressed button returns through the ordinary linked-human proc.hil path.
    // SAFETY: The test environment exposes the declared Durable Object namespace binding.
    const peers = env.MANAGED_WHATSAPP_PEER as DurableObjectNamespace;
    const peer = typedStub<ManagedPeerStub>(peers.get(peers.idFromName(`managed:${ACTOR}`)));
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
      actorId: ACTOR,
      surface: { kind: "dm" as const, id: ACTOR },
      routeGeneration: firstGeneration,
      processId: "proc-approval",
      runId: "run-approval",
      processMode: "ship" as const,
      hil,
    };
    await expect(peer.sendMessage(
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
    )).resolves.toMatchObject({ ok: true });
    const approvalMessage = (await sentMessages()).findLast((record) => record.body.type === "interactive");
    expect(approvalMessage).toBeDefined();
    const buttons = approvalMessage!.body.interactive!.action.buttons;
    expect(approvalMessage!.body.interactive!.body.text).toContain("Requested action: run \"date\".");
    expect(buttons.map((button) => button.reply.title)).toEqual(["Approve once", "Always approve", "Deny"]);
    const approveAlways = buttons[1]!.reply.id;
    expect(approveAlways).toMatch(/^gsvh:[A-Za-z0-9_-]{16}:a$/);
    const approvalMessageId = approvalMessage!.result.id!;

    expect((await SELF.fetch(await notification("wamid.in.3", {
      type: "interactive",
      context: { from: "34600000000", id: approvalMessageId },
      interactive: { type: "button_reply", button_reply: { id: approveAlways, title: "Always approve" } },
    }))).status).toBe(200);
    await vi.waitFor(async () => {
      expect(await gatewayCalls()).toContainEqual(expect.objectContaining({
        installation: { installationId: "installation_test" },
        linkedContext: expect.objectContaining({
          accountId: "managed",
          actorId: ACTOR,
          routeGeneration: firstGeneration,
          interactionId: "wamid.in.3",
        }),
        call: "proc.hil",
        args: {
          pid: "proc-approval",
          requestId: "request-approval",
          decision: "approve",
          remember: true,
        },
      }));
      expect(await sentMessages()).toContainEqual(expect.objectContaining({
        body: expect.objectContaining({
          text: expect.objectContaining({ body: expect.stringContaining("Approved for this conversation.") }),
          context: { message_id: approvalMessageId },
        }),
      }));
    });
    const resolution = (await sentMessages()).findLast((record) => record.body.context?.message_id === approvalMessageId);
    expect(resolution?.body.text?.body).toContain("Requested action: run \"date\".");
    expect(resolution?.body.text?.body).not.toContain("I need your confirmation");
    expect(resolution?.body.text?.body).not.toContain("hil[");

    const approvalCalls = (await gatewayCalls()).filter((call) => call.call === "proc.hil");
    const statusCount = (await sentMessages()).filter((record) => record.body.context?.message_id === approvalMessageId).length;
    expect((await SELF.fetch(await notification("wamid.in.4", {
      type: "interactive",
      context: { from: "34600000000", id: approvalMessageId },
      interactive: { type: "button_reply", button_reply: { id: approveAlways, title: "Always approve" } },
    }))).status).toBe(200);
    await vi.waitFor(async () => {
      expect((await sentMessages()).filter((record) => record.body.context?.message_id === approvalMessageId))
        .toHaveLength(statusCount + 1);
    });
    expect((await gatewayCalls()).filter((call) => call.call === "proc.hil")).toHaveLength(approvalCalls.length);

    expect((await SELF.fetch(await notification("wamid.in.5", {
      type: "audio",
      audio: { id: "5005", mime_type: "audio/ogg; codecs=opus", voice: true },
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
              filename: "whatsapp-audio-5005.ogg",
              size: 4,
              body: { offset: 0, length: 4 },
            }],
          }),
        }),
        bodyBytes: [1, 2, 3, 4],
      }));
    });

    // Media Meta no longer serves, whether the lookup or the download says so,
    // is answered with the unavailable notice and completes, so the person's
    // later messages are not stuck behind it.
    expect((await SELF.fetch(await notification("wamid.in.5b", {
      type: "audio",
      audio: { id: "gone", mime_type: "audio/ogg", voice: true },
    }))).status).toBe(200);
    expect((await SELF.fetch(await notification("wamid.in.5c", {
      type: "image",
      image: { id: "vanished", mime_type: "image/jpeg" },
    }))).status).toBe(200);
    await vi.waitFor(async () => {
      const unavailable = (await sentMessages())
        .filter((record) => record.body.text?.body.includes("could not receive that attachment"));
      expect(unavailable.map((record) => record.body.context?.message_id)).toEqual(["wamid.in.5b", "wamid.in.5c"]);
    });
    expect((await gatewayCalls()).some((call) => call.args?.message?.media?.some((media) => media.type === "image"))).toBe(false);

    expect((await SELF.fetch(await text("wamid.in.6", "__gateway_unavailable__"))).status).toBe(200);
    await vi.waitFor(async () => {
      expect(await gatewayCalls()).toContainEqual(expect.objectContaining({
        args: expect.objectContaining({
          message: expect.objectContaining({ text: "__gateway_unavailable__" }),
        }),
      }));
    });

    const messagesBeforePairCommand = (await sentMessages()).length;
    expect((await SELF.fetch(await text("wamid.in.7", "/link"))).status).toBe(200);
    await vi.waitFor(async () => {
      const messages = await sentMessages();
      expect(messages.length).toBeGreaterThan(messagesBeforePairCommand);
      expect(messages.at(-1)?.body.text?.body).toContain("Pairing code:");
    });
    const relinkText = (await sentMessages()).at(-1)?.body.text?.body ?? "";
    const relinkCode = relinkText.match(/[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){2}/)?.[0];
    expect(relinkCode).toBeTruthy();
    const normalizedRelinkCode = relinkCode!.replaceAll("-", "");
    const relinking = typedStub<ManagedPairingStub>(namespace.get(
      namespace.idFromName(`pair:${normalizedRelinkCode}`),
    ));
    await expect(relinking.inspect()).resolves.toMatchObject({ actorId: ACTOR, linked: true });
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
          actorId: ACTOR,
          expectedGeneration: firstGeneration,
        }),
      }));
    });

    await expect(peer.setTyping("installation_test", { kind: "dm", id: ACTOR }, ACTOR, firstGeneration, true))
      .resolves.toEqual({ accepted: false });
    await expect(peer.setTyping("installation_test", { kind: "dm", id: ACTOR }, ACTOR, relinked.route.generation, true))
      .resolves.toEqual({ accepted: true });
    expect(await graphRecords()).toContainEqual(expect.objectContaining({
      kind: "read",
      body: { messaging_product: "whatsapp", status: "read", message_id: "wamid.in.7", typing_indicator: { type: "text" } },
    }));
    await expect(peer.sendMessage("installation_test", {
      deliveryId: "stale-after-relink",
      surface: { kind: "dm", id: ACTOR },
      actorId: ACTOR,
      routeGeneration: firstGeneration,
      text: "stale output",
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("route changed"),
    });
    expect((await sentMessages()).some((record) => record.body.text?.body === "stale output")).toBe(false);

    // Long text is rendered from Markdown and split at Meta's 4096 character limit.
    await expect(peer.sendMessage("installation_test", {
      deliveryId: "outbound-long-1",
      surface: { kind: "dm", id: ACTOR },
      actorId: ACTOR,
      routeGeneration: relinked.route.generation,
      text: `**Report**\n\n${"word ".repeat(1_000)}`,
      replyToId: "wamid.in.7",
    })).resolves.toMatchObject({ ok: true, messageId: expect.stringMatching(/^wamid\.out\./) });
    const longChunks = (await sentMessages()).filter((record) => record.body.text?.body.startsWith("*Report*") || record.body.text?.body.startsWith("word word"));
    expect(longChunks).toHaveLength(2);
    expect(longChunks[0]!.body.context).toEqual({ message_id: "wamid.in.7" });
    expect(longChunks[1]!.body.context).toBeUndefined();
    expect(longChunks.every((record) => [...record.body.text!.body].length <= 4096)).toBe(true);

    // A long reply goes out as paragraph messages in order: the greeting and
    // intro stay with the paragraph they introduce, the closing question is its
    // own message, only the first quotes the inbound, and the typing indicator
    // rides a read receipt between messages.
    const recordsBeforeParagraphs = (await graphRecords()).length;
    await expect(peer.sendMessage("installation_test", {
      deliveryId: "outbound-paragraphs-1",
      surface: { kind: "dm", id: ACTOR },
      actorId: ACTOR,
      routeGeneration: relinked.route.generation,
      text: `Hi Hank!\n\nHere is the **report**.\n\n${"word ".repeat(1_000).trimEnd()}\n\nAnything else?`,
      replyToId: "wamid.in.7",
    })).resolves.toMatchObject({ ok: true, messageId: expect.stringMatching(/^wamid\.out\./) });
    const paragraphRecords = (await graphRecords()).slice(recordsBeforeParagraphs);
    expect(paragraphRecords.map((record) => record.kind)).toEqual(["message", "read", "message", "read", "message"]);
    const paragraphMessages = paragraphRecords.filter((record) => record.kind === "message");
    expect(paragraphMessages.map((record) => record.body.text?.body)).toEqual([
      expect.stringMatching(/^Hi Hank!\n\nHere is the \*report\*\.\n\nword word/),
      expect.stringMatching(/^word word/),
      "Anything else?",
    ]);
    expect(paragraphMessages.every((record) => [...record.body.text!.body].length <= 4096)).toBe(true);
    expect(paragraphMessages[0]!.body.context).toEqual({ message_id: "wamid.in.7" });
    expect(paragraphMessages[1]!.body.context).toBeUndefined();
    expect(paragraphMessages[2]!.body.context).toBeUndefined();
    expect(paragraphRecords[1]!.body).toMatchObject({
      status: "read",
      message_id: "wamid.in.7",
      typing_indicator: { type: "text" },
    });

    // Binary audio is uploaded first and sent by media id; audio carries no caption,
    // so the text goes out as its own message beforehand.
    await expect(peer.sendMessage("installation_test", {
      deliveryId: "outbound-audio-1",
      surface: { kind: "dm", id: ACTOR },
      actorId: ACTOR,
      routeGeneration: relinked.route.generation,
      text: "audio reply",
      media: [{
        type: "audio",
        mimeType: "audio/ogg",
        filename: "reply.ogg",
        size: 4,
        body: { offset: 0, length: 4 },
      }],
    }, binaryBodyFromOwnedBytes(new Uint8Array([5, 6, 7, 8])))).resolves.toMatchObject({ ok: true });
    const upload = (await graphRecords()).find((record) => record.kind === "upload");
    expect(upload?.body.file).toEqual({ name: "reply.ogg", type: "audio/ogg", bytes: [5, 6, 7, 8] });
    expect(await sentMessages()).toContainEqual(expect.objectContaining({
      body: expect.objectContaining({ to: ACTOR, type: "audio", audio: { id: upload!.result.id } }),
    }));
    expect(await sentMessages()).toContainEqual(expect.objectContaining({
      body: expect.objectContaining({ type: "text", text: { preview_url: false, body: "audio reply" } }),
    }));
    const sentAudioCount = (await sentMessages()).filter((record) => record.body.type === "audio").length;
    await expect(peer.sendMessage("installation_test", {
      deliveryId: "outbound-audio-1",
      surface: { kind: "dm", id: ACTOR },
      actorId: ACTOR,
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
    expect((await sentMessages()).filter((record) => record.body.type === "audio")).toHaveLength(sentAudioCount);

    // A URL image carries the text as its caption.
    await expect(peer.sendMessage("installation_test", {
      deliveryId: "outbound-image-1",
      surface: { kind: "dm", id: ACTOR },
      actorId: ACTOR,
      routeGeneration: relinked.route.generation,
      text: "look at **this**",
      media: [{ type: "image", mimeType: "image/png", url: "https://example.com/a.png" }],
    })).resolves.toMatchObject({ ok: true });
    expect(await sentMessages()).toContainEqual(expect.objectContaining({
      body: expect.objectContaining({ type: "image", image: { link: "https://example.com/a.png", caption: "look at *this*" } }),
    }));

    // A Meta rejection surfaces as a permanent, specific failure.
    await expect(peer.sendMessage("installation_test", {
      deliveryId: "outbound-rejected-1",
      surface: { kind: "dm", id: ACTOR },
      actorId: ACTOR,
      routeGeneration: relinked.route.generation,
      text: "graph rejects this",
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("code 131026") });
  });

  it("sends the template when Meta refuses a free-form message and lets the person's reply clear it", async () => {
    // SAFETY: The test environment exposes the declared Durable Object namespace binding.
    const peers = env.MANAGED_WHATSAPP_PEER as DurableObjectNamespace<ManagedWhatsAppPeer>;
    const stub = peers.get(peers.idFromName(`managed:${ACTOR}`));
    const peer = typedStub<ManagedPeerStub>(stub);
    const route = (await runInDurableObject(stub, async (_instance, context) => (
      (await context.storage.get<ManagedWhatsAppPeerState>(STATE_KEY))!
    ))).activeRoute!;
    const templatesBefore = (await templateMessages()).length;

    // The local receipt still says the window is open, but Meta answers 131047.
    await expect(peer.sendMessage(route.installationId, {
      deliveryId: "outbound-meta-closed",
      surface: { kind: "dm", id: ACTOR },
      actorId: ACTOR,
      routeGeneration: route.generation,
      text: "outside window marker quick note",
    })).resolves.toMatchObject({ ok: true, messageId: expect.stringMatching(/^wamid\.out\./) });
    const templates = await templateMessages();
    expect(templates).toHaveLength(templatesBefore + 1);
    expect(templates.at(-1)!.body.to).toBe(ACTOR);
    expect(templates.at(-1)!.body.template).toEqual({
      name: "gsv_message",
      language: { code: "en" },
      components: [
        { type: "body", parameters: [{ type: "text", text: "outside window marker quick note" }] },
        { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: "gsvt:show" }] },
      ],
    });
    expect((await sentMessages()).some((record) => record.body.text?.body === "outside window marker quick note")).toBe(false);
    const pending = await runInDurableObject(stub, async (_instance, context) => (
      (await context.storage.get<ManagedWhatsAppPeerState>(STATE_KEY))!.pendingTemplate
    ));
    expect(pending).toMatchObject({ messageId: templates.at(-1)!.result.id });

    // The person's next message answers the template and reopens the window.
    expect((await SELF.fetch(await text("wamid.in.8", "back again"))).status).toBe(200);
    await vi.waitFor(async () => {
      expect(await sentMessages()).toContainEqual(expect.objectContaining({
        body: expect.objectContaining({ context: { message_id: "wamid.in.8" } }),
      }));
    });
    expect(await runInDurableObject(stub, async (_instance, context) => (
      (await context.storage.get<ManagedWhatsAppPeerState>(STATE_KEY))!.pendingTemplate
    ))).toBeUndefined();
  });

  it("holds longer replies and approvals behind one template until the person taps or writes back", async () => {
    // SAFETY: The test environment exposes the declared Durable Object namespace binding.
    const peers = env.MANAGED_WHATSAPP_PEER as DurableObjectNamespace<ManagedWhatsAppPeer>;
    const stub = peers.get(peers.idFromName(`managed:${ACTOR}`));
    const peer = typedStub<ManagedPeerStub>(stub);
    const state = await runInDurableObject(stub, async (_instance, context) => (
      (await context.storage.get<ManagedWhatsAppPeerState>(STATE_KEY))!
    ));
    const route = state.activeRoute!;
    const surface = { kind: "dm" as const, id: ACTOR };
    await runInDurableObject(stub, async (_instance, context) => {
      await context.storage.put(STATE_KEY, { ...state, lastInboundAt: Date.now() - 25 * 60 * 60 * 1000 });
    });
    const templatesBefore = (await templateMessages()).length;
    const interactiveBefore = (await sentMessages()).filter((record) => record.body.type === "interactive").length;

    // Two short replies racing after the window closed both fit the template's
    // parameter, but the pending template is claimed durably before Meta is
    // called: one delivery sends it and the other waits behind it. Both carry
    // the marker that makes the fake Graph API fail their free-form release
    // with a server error, so the waiting one later meets an unknown outcome.
    const racing = ["first late note (graph fails ambiguously)", "second late note (graph fails ambiguously)"];
    const raceResults = await Promise.all(racing.map((raceText, index) => peer.sendMessage(route.installationId, {
      deliveryId: `outbound-closed-race-${index}`,
      surface,
      actorId: ACTOR,
      routeGeneration: route.generation,
      text: raceText,
    })));
    expect(raceResults.every((result) => result.ok)).toBe(true);
    expect(await templateMessages()).toHaveLength(templatesBefore + 1);
    const template = (await templateMessages()).at(-1)!;
    const winner = racing.findIndex((raceText) => templateParameter(template) === raceText);
    expect(winner).toBeGreaterThanOrEqual(0);
    const heldRaceIndex = 1 - winner;
    expect(raceResults[winner]).toMatchObject({ ok: true, messageId: template.result.id });
    expect(raceResults[heldRaceIndex]).toEqual({ ok: true });
    expect(await heldKeys(stub)).toEqual([
      `managed_whatsapp_peer:v1:held:${encodeURIComponent(`outbound-closed-race-${heldRaceIndex}`)}`,
    ]);

    // A longer reply waits behind the pending template instead of sending another.
    const sentBeforeHolding = (await sentMessages()).length;
    const longText = `**Report**\n\n${"word ".repeat(300).trimEnd()}\n\nAnything else?`;
    const longDelivery = {
      deliveryId: "outbound-closed-long",
      surface,
      actorId: ACTOR,
      routeGeneration: route.generation,
      text: longText,
    };
    await expect(peer.sendMessage(route.installationId, longDelivery)).resolves.toEqual({ ok: true });
    expect(await templateMessages()).toHaveLength(templatesBefore + 1);
    expect((await sentMessages()).length).toBe(sentBeforeHolding);

    // An approval prompt waits too: the template cannot carry its buttons.
    const lateHil = {
      pid: "proc-late",
      requestId: "request-late",
      runId: "run-late",
      callId: "call-late",
      toolName: "Shell",
      syscall: "shell.exec",
      target: "gsv",
      args: { input: "uptime" },
      createdAt: 1_700_000_200_000,
    };
    const lateContext = {
      deliveryId: "run-late:hil:request-late",
      accountId: "managed",
      actorId: ACTOR,
      surface,
      routeGeneration: route.generation,
      processId: "proc-late",
      runId: "run-late",
      processMode: "ship" as const,
      hil: lateHil,
    };
    await expect(peer.sendMessage(route.installationId, {
      deliveryId: lateContext.deliveryId,
      surface,
      actorId: ACTOR,
      routeGeneration: route.generation,
      text: "",
    }, undefined, lateContext)).resolves.toEqual({ ok: true });
    expect(await templateMessages()).toHaveLength(templatesBefore + 1);
    expect((await sentMessages()).filter((record) => record.body.type === "interactive")).toHaveLength(interactiveBefore);

    // The Kernel's retry of a held delivery is deduplicated by the ledger.
    await expect(peer.sendMessage(route.installationId, longDelivery)).resolves.toMatchObject({ ok: true });
    expect(await templateMessages()).toHaveLength(templatesBefore + 1);

    // Tapping the button reopens the window and releases the held messages in
    // order through the free-form path, paragraph by paragraph, without
    // relaying the tap to the Process.
    const recordsBeforeTap = (await graphRecords()).length;
    expect((await SELF.fetch(await notification("wamid.in.10", {
      type: "button",
      context: { from: "34600000000", id: template.result.id! },
      button: { payload: "gsvt:show", text: "Show me" },
    }))).status).toBe(200);
    await vi.waitFor(async () => {
      const released = (await graphRecords()).slice(recordsBeforeTap).filter((record) => record.kind === "message");
      expect(released.map((record) => record.body.type)).toEqual(["text", "text", "interactive"]);
    });
    const released = (await graphRecords()).slice(recordsBeforeTap).filter((record) => record.kind === "message");
    expect(released[0]!.body.text?.body).toMatch(/^\*Report\*\n\nword word/);
    expect(released[1]!.body.text?.body).toBe("Anything else?");
    expect(released[2]!.body.interactive?.body.text).toContain("Requested action: run \"uptime\".");
    expect(released[2]!.body.interactive?.action.buttons.map((button) => button.reply.title))
      .toEqual(["Approve once", "Always approve", "Deny"]);
    expect((await gatewayCalls()).some((call) => call.call === "adapter.inbound" && call.args?.message?.text === "Show me")).toBe(false);
    expect(await graphRecords()).toContainEqual(expect.objectContaining({
      kind: "read",
      body: expect.objectContaining({ status: "read", message_id: "wamid.in.10" }),
    }));
    // The waiting racer's release met a server failure: its outcome is unknown,
    // so its record is kept rather than resent or dropped, while the messages
    // held after it still went out.
    const ambiguousReleases = async (): Promise<RejectedRecord[]> => (await rejectedSends())
      .filter((record) => record.status === 500 && record.body.text?.body === racing[heldRaceIndex]);
    expect(await ambiguousReleases()).toHaveLength(1);
    expect(await heldKeys(stub)).toEqual([
      `managed_whatsapp_peer:v1:held:${encodeURIComponent(`outbound-closed-race-${heldRaceIndex}`)}`,
    ]);

    // The released prompt resolves through proc.hil like any other.
    const approveOnce = released[2]!.body.interactive!.action.buttons[0]!.reply.id;
    expect(approveOnce).toMatch(/^gsvh:[A-Za-z0-9_-]{16}:o$/);
    expect((await SELF.fetch(await notification("wamid.in.11", {
      type: "interactive",
      context: { from: "34600000000", id: released[2]!.result.id! },
      interactive: { type: "button_reply", button_reply: { id: approveOnce, title: "Approve once" } },
    }))).status).toBe(200);
    await vi.waitFor(async () => {
      expect(await gatewayCalls()).toContainEqual(expect.objectContaining({
        call: "proc.hil",
        args: { pid: "proc-late", requestId: "request-late", decision: "approve", remember: false },
      }));
    });

    // A later message from the person tries the release again: the ledger
    // remembers the unknown outcome, so nothing is resent and the record stays.
    expect((await SELF.fetch(await text("wamid.in.12", "still here"))).status).toBe(200);
    await vi.waitFor(async () => {
      expect(await sentMessages()).toContainEqual(expect.objectContaining({
        body: expect.objectContaining({ context: { message_id: "wamid.in.12" } }),
      }));
    });
    expect(await ambiguousReleases()).toHaveLength(1);
    expect(await heldKeys(stub)).toHaveLength(1);

    // With the window open again, replies are free-form and nothing new is held.
    await expect(peer.sendMessage(route.installationId, {
      deliveryId: "outbound-inside-window",
      surface,
      actorId: ACTOR,
      routeGeneration: route.generation,
      text: "welcome back",
    })).resolves.toMatchObject({ ok: true });
    expect(await sentMessages()).toContainEqual(expect.objectContaining({
      body: expect.objectContaining({ type: "text", text: { preview_url: false, body: "welcome back" } }),
    }));
    expect(await templateMessages()).toHaveLength(templatesBefore + 1);
  });

  it("drops a reply whose route changed before it could be delivered", async () => {
    // SAFETY: The test environment exposes the declared Durable Object namespace binding.
    const peers = env.MANAGED_WHATSAPP_PEER as DurableObjectNamespace<ManagedWhatsAppPeer>;
    const stub = peers.get(peers.idFromName(`managed:${ACTOR}`));
    const previous = (await runInDurableObject(stub, async (_instance, context) => (
      (await context.storage.get<ManagedWhatsAppPeerState>(STATE_KEY))!
    ))).activeRoute!;

    // The reply a linked person's message earns is bound to the route that
    // admitted it. Throttle it so it is still pending when the person relinks.
    await throttle("could not receive that message type");
    expect((await SELF.fetch(await notification("wamid.in.13", {
      type: "reaction",
      reaction: { message_id: "wamid.in.12", emoji: "👍" },
    }))).status).toBe(200);
    await vi.waitFor(async () => {
      expect((await rejectedSends()).some((record) => record.status === 429 && record.body.context?.message_id === "wamid.in.13")).toBe(true);
    });

    // A pair command is attempted ahead of the queue, so the pending reply does not hold it up.
    expect((await SELF.fetch(await text("wamid.in.14", "/link"))).status).toBe(200);
    await vi.waitFor(async () => {
      expect((await sentMessages()).at(-1)?.body.text?.body).toContain("Pairing code:");
    });
    const code = ((await sentMessages()).at(-1)?.body.text?.body ?? "").match(/[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){2}/)?.[0];
    expect(code).toBeTruthy();
    // SAFETY: The test environment exposes the declared Durable Object namespace binding.
    const namespace = env.MANAGED_WHATSAPP_PAIRING as DurableObjectNamespace;
    const pairing = typedStub<ManagedPairingStub>(namespace.get(namespace.idFromName(`pair:${code!.replaceAll("-", "")}`)));
    const operation = {
      code: code!.replaceAll("-", ""),
      installationId: previous.installationId,
      localUid: 1000,
      operationId: "operation_relink_2",
      canonicalOrigin: "https://test.gsv.space",
    };
    const prepared = await pairing.prepare(operation);
    await pairing.activate({ code: operation.code, operationId: operation.operationId, route: prepared.route, canonicalOrigin: operation.canonicalOrigin });
    await pairing.finalize({ code: operation.code, operationId: operation.operationId, route: prepared.route, canonicalOrigin: operation.canonicalOrigin });
    expect(prepared.route.generation).not.toBe(previous.generation);
    await vi.waitFor(async () => {
      expect(await gatewayCalls()).toContainEqual(expect.objectContaining({
        call: "unlinkAdapterIdentity",
        input: expect.objectContaining({ expectedGeneration: previous.generation }),
      }));
    });

    // Once the throttle lifts, the reply bound to the old route is dropped for
    // good rather than delivered on the new one, and it no longer stands in
    // front of later inbound messages.
    await throttle("");
    await runInDurableObject(stub, async (instance) => { await instance.alarm(); });
    expect((await sentMessages()).some((record) => record.body.context?.message_id === "wamid.in.13")).toBe(false);
    await runInDurableObject(stub, async (_instance, context) => {
      const records = [...(await context.storage.list<{ state: string }>({ prefix: "managed_whatsapp_peer:v1:inbound:" })).values()];
      expect(records.filter((record) => record.state !== "completed")).toEqual([]);
    });

    // An unsupported message on the new route is answered as usual.
    expect((await SELF.fetch(await notification("wamid.in.15", {
      type: "reaction",
      reaction: { message_id: "wamid.in.14", emoji: "👍" },
    }))).status).toBe(200);
    await vi.waitFor(async () => {
      expect(await sentMessages()).toContainEqual(expect.objectContaining({
        body: expect.objectContaining({
          text: expect.objectContaining({ body: expect.stringContaining("could not receive that message type") }),
          context: { message_id: "wamid.in.15" },
        }),
      }));
    });
    expect((await sentMessages()).some((record) => record.body.context?.message_id === "wamid.in.13")).toBe(false);
  });
});

it("does not export the retired linked-device entrypoints", async () => {
  expect(deployedAdapter).not.toHaveProperty("WhatsAppChannel");
  expect(deployedAdapter).not.toHaveProperty("WhatsAppAccount");
  expect(deployedAdapter).not.toHaveProperty("WhatsAppChannelEntrypoint");
  expect((await SELF.fetch("https://fixture/webhook/default", { method: "POST", body: "{}" })).status).toBe(404);
});
