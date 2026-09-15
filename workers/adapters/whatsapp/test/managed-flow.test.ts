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

type MessageContent =
  | { type: "text"; text: { body: string } }
  | { type: "audio"; audio: { id: string; mime_type: string; voice: boolean } }
  | { type: "interactive"; context: { from: string; id: string }; interactive: { type: "button_reply"; button_reply: { id: string; title: string } } };

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

  it("refuses free-form sends once the 24-hour customer service window has closed", async () => {
    // SAFETY: The test environment exposes the declared Durable Object namespace binding.
    const peers = env.MANAGED_WHATSAPP_PEER as DurableObjectNamespace<ManagedWhatsAppPeer>;
    const stub = peers.get(peers.idFromName(`managed:${ACTOR}`));
    const peer = typedStub<ManagedPeerStub>(stub);
    const state = await runInDurableObject(stub, async (_instance, context) => (
      (await context.storage.get<ManagedWhatsAppPeerState>(STATE_KEY))!
    ));
    const route = state.activeRoute!;
    const sentBefore = (await sentMessages()).length;

    await runInDurableObject(stub, async (_instance, context) => {
      await context.storage.put(STATE_KEY, { ...state, lastInboundAt: Date.now() - 25 * 60 * 60 * 1000 });
    });
    await expect(peer.sendMessage(route.installationId, {
      deliveryId: "outbound-outside-window",
      surface: { kind: "dm", id: ACTOR },
      actorId: ACTOR,
      routeGeneration: route.generation,
      text: "late follow-up",
    })).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("customer service window is closed"),
    });
    expect((await sentMessages()).length).toBe(sentBefore);
    await expect(peer.sendMessage(route.installationId, {
      deliveryId: "outbound-outside-window",
      surface: { kind: "dm", id: ACTOR },
      actorId: ACTOR,
      routeGeneration: route.generation,
      text: "late follow-up",
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("template messages are not implemented") });

    // The next message from the person reopens the window.
    expect((await SELF.fetch(await text("wamid.in.8", "back again", Math.floor(Date.now() / 1000)))).status).toBe(200);
    await vi.waitFor(async () => {
      expect(await sentMessages()).toContainEqual(expect.objectContaining({
        body: expect.objectContaining({ context: { message_id: "wamid.in.8" } }),
      }));
    });
    await expect(peer.sendMessage(route.installationId, {
      deliveryId: "outbound-inside-window",
      surface: { kind: "dm", id: ACTOR },
      actorId: ACTOR,
      routeGeneration: route.generation,
      text: "welcome back",
    })).resolves.toMatchObject({ ok: true });
  });
});

it("does not export the retired linked-device entrypoints", async () => {
  expect(deployedAdapter).not.toHaveProperty("WhatsAppChannel");
  expect(deployedAdapter).not.toHaveProperty("WhatsAppAccount");
  expect(deployedAdapter).not.toHaveProperty("WhatsAppChannelEntrypoint");
  expect((await SELF.fetch("https://fixture/webhook/default", { method: "POST", body: "{}" })).status).toBe(404);
});
