import * as deployedAdapter from "../src/managed";
import { createExecutionContext, env, runInDurableObject, SELF } from "cloudflare:test";
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
    reaction?: { message_id: string; emoji: string };
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
        purpose?: string;
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
    runId?: string,
  ): Promise<{ accepted: boolean }>;
};
type LinkedPeerFixture = {
  stub: DurableObjectStub<ManagedWhatsAppPeer>;
  peer: ManagedPeerStub;
  route: NonNullable<ManagedWhatsAppPeerState["activeRoute"]>;
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

async function linkedPeer(window: "open" | "closed"): Promise<LinkedPeerFixture> {
  // SAFETY: The test environment exposes the declared Durable Object namespace binding.
  const peers = env.MANAGED_WHATSAPP_PEER as DurableObjectNamespace<ManagedWhatsAppPeer>;
  const stub = peers.get(peers.idFromName(`managed:${ACTOR}`));
  const route = await runInDurableObject(stub, async (_instance, context) => {
    const state = await context.storage.get<ManagedWhatsAppPeerState>(STATE_KEY);
    if (!state?.activeRoute) throw new Error("The managed flow must pair the peer first");
    await context.storage.put(STATE_KEY, {
      ...state,
      lastInboundAt: Date.now() - (window === "closed" ? 25 * 60 * 60 * 1000 : 1_000),
    });
    return state.activeRoute;
  });
  return { stub, peer: typedStub<ManagedPeerStub>(stub), route };
}

async function pauseGraphSend(kind: "template" | "window-rejection"): Promise<void> {
  // SAFETY: The Cloudflare test environment declares WHATSAPP_API as a Fetcher binding.
  const binding = env.WHATSAPP_API as Fetcher;
  await binding.fetch("https://graph.test/pause-send", { method: "POST", body: kind });
}

async function pausedGraphSend(): Promise<GraphRecord["body"] | null> {
  // SAFETY: The Cloudflare test environment declares WHATSAPP_API as a Fetcher binding.
  const binding = env.WHATSAPP_API as Fetcher;
  return await (await binding.fetch("https://graph.test/paused-send")).json();
}

async function resumeGraphSend(): Promise<void> {
  // SAFETY: The Cloudflare test environment declares WHATSAPP_API as a Fetcher binding.
  const binding = env.WHATSAPP_API as Fetcher;
  await binding.fetch("https://graph.test/resume-send", { method: "POST" });
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
      expect(await sentMessages()).toHaveLength(2);
    });
    const pairingMessage = (await sentMessages())[0]!;
    expect(pairingMessage.body.to).toBe(ACTOR);
    expect(pairingMessage.body.context).toEqual({ message_id: "wamid.in.1" });
    const pairingText = pairingMessage.body.text?.body ?? "";
    expect(pairingText).toContain("Settings → Messengers → WhatsApp");
    const code = (await sentMessages())[1]!.body.text?.body;
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){2}$/);
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
      purpose: "check the current time",
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
    expect(approvalMessage!.body.interactive!.body.text).toContain("Check the current time.");
    expect(approvalMessage!.body.interactive!.body.text).not.toContain("\"date\"");
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
    expect(resolution?.body.text?.body).toContain("Check the current time.");
    expect(resolution?.body.text?.body).not.toContain("\"date\"");
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
      expect(messages.at(-1)?.body.text?.body).toMatch(/^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){2}$/);
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
    // Ship is working on the old link when the person relinks.
    await expect(peer.setTyping("installation_test", { kind: "dm", id: ACTOR }, ACTOR, firstGeneration, true, "run-old-link"))
      .resolves.toEqual({ accepted: true });
    expect(await graphRecords()).toContainEqual(expect.objectContaining({
      kind: "message", body: expect.objectContaining({ type: "reaction", reaction: { message_id: "wamid.in.7", emoji: "👀" } }),
    }));
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
    // The old link's stop is refused, so the relink itself clears its 👀.
    expect(await graphRecords()).toContainEqual(expect.objectContaining({
      kind: "message", body: expect.objectContaining({ type: "reaction", reaction: { message_id: "wamid.in.7", emoji: "" } }),
    }));
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
      text: `# Report\n\n${"word ".repeat(1_000)}`,
      replyToId: "wamid.in.7",
    })).resolves.toMatchObject({ ok: true, messageId: expect.stringMatching(/^wamid\.out\./) });
    const longChunks = (await sentMessages()).filter((record) => record.body.text?.body.startsWith("*Report*") || record.body.text?.body.startsWith("word word"));
    expect(longChunks).toHaveLength(2);
    expect(longChunks[0]!.body.context).toEqual({ message_id: "wamid.in.7" });
    expect(longChunks[1]!.body.context).toBeUndefined();
    expect(longChunks.every((record) => [...record.body.text!.body].length <= 4096)).toBe(true);

    // Each prose paragraph is a message. An oversized paragraph is split,
    // only the first quotes the inbound, and typing rides a read receipt between messages.
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
    expect(paragraphRecords.map((record) => record.kind)).toEqual(["message", "read", "message", "read", "message", "read", "message", "read", "message"]);
    const paragraphMessages = paragraphRecords.filter((record) => record.kind === "message");
    expect(paragraphMessages.map((record) => record.body.text?.body)).toEqual([
      "Hi Hank!",
      "Here is the *report*.",
      expect.stringMatching(/^word word/),
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

  it("keeps an incomplete successful send ambiguous without replaying it", async () => {
    const { peer, route } = await linkedPeer("open");
    const delivery = {
      deliveryId: "outbound-incomplete-response",
      surface: { kind: "dm" as const, id: ACTOR },
      actorId: ACTOR,
      routeGeneration: route.generation,
      text: "graph omits message id",
    };
    await expect(peer.sendMessage(route.installationId, delivery)).resolves.toMatchObject({
      ok: false,
      ambiguous: true,
      error: "WhatsApp Graph API returned an invalid response",
    });
    await expect(peer.sendMessage(route.installationId, delivery)).resolves.toMatchObject({
      ok: false,
      ambiguous: true,
    });
    expect((await graphRecords()).filter((record) => record.kind === "incomplete"
      && record.body.text?.body === delivery.text)).toHaveLength(1);
  });

  it("sends actual text when Meta rejects free-form delivery without replaying it later", async () => {
    const { stub, peer, route } = await linkedPeer("open");
    const templatesBefore = (await templateMessages()).length;
    await expect(peer.sendMessage(route.installationId, {
      deliveryId: "outbound-meta-closed", surface: { kind: "dm", id: ACTOR },
      actorId: ACTOR, routeGeneration: route.generation, text: "outside window marker quick note",
    })).resolves.toMatchObject({ ok: true, messageId: expect.any(String) });
    const templates = await templateMessages();
    expect(templates).toHaveLength(templatesBefore + 1);
    expect(templates.at(-1)!.body.template).toEqual({
      name: "gsv_message", language: { code: "en" },
      components: [
        { type: "body", parameters: [{ type: "text", text: "outside window marker quick note" }] },
        { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: "gsvt:show" }] },
      ],
    });
    expect((await SELF.fetch(await text("wamid.in.8", "back again"))).status).toBe(200);
    await vi.waitFor(async () => {
      expect((await sentMessages()).at(-1)?.body.text?.body).toBe("Personal received back again");
    });
    expect((await sentMessages()).some((record) => record.body.text?.body === "outside window marker quick note")).toBe(false);
    expect(await heldKeys(stub)).toEqual([]);
  });

  it("delivers each closed-window message or preview and forwards button replies once to Ship", async () => {
    const { stub, peer, route } = await linkedPeer("closed");
    const templatesBefore = (await templateMessages()).length;
    const surface = { kind: "dm" as const, id: ACTOR };
    const texts = ["First late note", "Second late note", "long reply ".repeat(300).trimEnd()];
    const deliveries = texts.map((text, index) => ({
      deliveryId: `outbound-late-${index}`, surface, actorId: ACTOR, routeGeneration: route.generation, text,
    }));
    for (const delivery of deliveries) {
      await expect(peer.sendMessage(route.installationId, delivery)).resolves.toMatchObject({ ok: true });
    }
    const templates = (await templateMessages()).slice(templatesBefore);
    expect(templates).toHaveLength(3);
    expect(templates[0]!.body.template?.components[0]?.parameters[0]?.text).toBe(texts[0]);
    expect(templates[1]!.body.template?.components[0]?.parameters[0]?.text).toBe(texts[1]);
    expect(templates[2]!.body.template?.components[0]?.parameters[0]?.text).toMatch(/… Open GSV for the full message\.$/);
    expect(await heldKeys(stub)).toEqual([]);
    await expect(peer.sendMessage(route.installationId, deliveries[2]!)).resolves.toMatchObject({ ok: true });
    expect(await templateMessages()).toHaveLength(templatesBefore + 3);

    const tap = { type: "button", button: { payload: "gsvt:show", text: "Show me" }, context: { id: templates[2]!.result.id! } };
    const callsBefore = (await gatewayCalls()).length;
    expect((await SELF.fetch(await notification("wamid.in.tap", tap))).status).toBe(200);
    await vi.waitFor(async () => {
      expect((await sentMessages()).at(-1)?.body.text?.body).toBe("Personal received Show me");
    });
    expect((await SELF.fetch(await notification("wamid.in.tap", tap))).status).toBe(200);
    await runInDurableObject(stub, async (instance) => { await instance.alarm(); });
    expect((await gatewayCalls()).slice(callsBefore).filter((call) => call.args?.message?.text === "Show me")).toHaveLength(1);
    expect((await sentMessages()).some((record) => texts.includes(record.body.text?.body ?? ""))).toBe(false);
  });

  it("directs a closed-window approval to GSV without assigning its buttons to a template", async () => {
    const { stub, peer, route } = await linkedPeer("closed");
    const surface = { kind: "dm" as const, id: ACTOR };
    const context = {
      deliveryId: "run-late:hil:request-late", accountId: "managed", actorId: ACTOR,
      surface, routeGeneration: route.generation, processId: "proc-late", runId: "run-late", processMode: "ship" as const,
      hil: {
        pid: "proc-late", requestId: "request-late", runId: "run-late", callId: "call-late",
        toolName: "Shell", syscall: "shell.exec", target: "gsv", args: { input: "uptime" },
        purpose: "check uptime", createdAt: Date.now(),
      },
    };
    await expect(peer.sendMessage(route.installationId, {
      deliveryId: context.deliveryId, surface, actorId: ACTOR, routeGeneration: route.generation, text: "",
    }, undefined, context)).resolves.toMatchObject({ ok: true, messageId: undefined });
    expect((await templateMessages()).at(-1)?.body.template?.components[0]?.parameters[0]?.text)
      .toBe("An action needs your approval. Open GSV to review it.");
    expect(await heldKeys(stub)).toEqual([]);
    // The next message goes to Ship; there is no deferred approval replay.
    const interactiveBefore = (await sentMessages()).filter((record) => record.body.type === "interactive").length;
    expect((await SELF.fetch(await text("wamid.in.after-approval", "hello"))).status).toBe(200);
    await vi.waitFor(async () => {
      expect((await sentMessages()).at(-1)?.body.text?.body).toBe("Personal received hello");
    });
    expect((await sentMessages()).filter((record) => record.body.type === "interactive")).toHaveLength(interactiveBefore);
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
      expect((await sentMessages()).at(-1)?.body.text?.body).toMatch(/^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){2}$/);
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

  it("does not replay an ambiguous template and allows later deliveries and replies", async () => {
    const { stub, peer, route } = await linkedPeer("closed");
    // SAFETY: The managed test configuration declares this Fetcher binding.
    const api = env.WHATSAPP_API as Fetcher;
    await api.fetch("https://graph.test/fail-next-template", { method: "POST" });
    const message = {
      deliveryId: "ambiguous-template", surface: { kind: "dm" as const, id: ACTOR },
      actorId: ACTOR, routeGeneration: route.generation, text: "Uncertain notification",
    };
    await expect(peer.sendMessage(route.installationId, message)).resolves.toMatchObject({ ok: false, ambiguous: true });
    const rejectedBefore = (await rejectedSends()).length;
    await expect(peer.sendMessage(route.installationId, message)).resolves.toMatchObject({ ok: false, ambiguous: true });
    expect(await rejectedSends()).toHaveLength(rejectedBefore);
    await expect(peer.sendMessage(route.installationId, { ...message, deliveryId: "later-template", text: "Later note" })).resolves.toMatchObject({ ok: true });
    expect((await SELF.fetch(await text("wamid.in.after-ambiguous", "What did you say?"))).status).toBe(200);
    await vi.waitFor(async () => {
      expect((await sentMessages()).at(-1)?.body.text?.body).toBe("Personal received What did you say?");
    });
    expect(await heldKeys(stub)).toEqual([]);
  });

  it("forwards inbound replies without waiting for an outbound template to settle", async () => {
    const { peer, route } = await linkedPeer("closed");
    await pauseGraphSend("template");
    const sending = peer.sendMessage(route.installationId, {
      deliveryId: "outbound-template-in-flight", surface: { kind: "dm", id: ACTOR },
      actorId: ACTOR, routeGeneration: route.generation, text: "Notification in flight",
    });
    try {
      await vi.waitFor(async () => { expect(await pausedGraphSend()).toMatchObject({ type: "template" }); });
      expect((await SELF.fetch(await text("wamid.in.template-in-flight", "hello while sending"))).status).toBe(200);
      await vi.waitFor(async () => {
        expect((await sentMessages()).at(-1)?.body.text?.body).toBe("Personal received hello while sending");
      });
    } finally {
      await resumeGraphSend();
    }
    await expect(sending).resolves.toMatchObject({ ok: true });
    expect((await sentMessages()).filter((record) => record.body.text?.body === "Notification in flight")).toHaveLength(0);
  });

  it("delivers once even if a reply reopens the window while Meta rejects the earlier send", async () => {
    const { peer, route } = await linkedPeer("open");
    await pauseGraphSend("window-rejection");
    const message = {
      deliveryId: "outbound-reopening-window", surface: { kind: "dm" as const, id: ACTOR },
      actorId: ACTOR, routeGeneration: route.generation, text: "reopen before template admission",
    };
    const before = (await templateMessages()).length;
    const sending = peer.sendMessage(route.installationId, message);
    try {
      await vi.waitFor(async () => { expect(await pausedGraphSend()).toMatchObject({ type: "text" }); });
      expect((await SELF.fetch(await text("wamid.in.window-reopened", "hello again"))).status).toBe(200);
      await vi.waitFor(async () => { expect((await sentMessages()).at(-1)?.body.text?.body).toBe("Personal received hello again"); });
    } finally {
      await resumeGraphSend();
    }
    await expect(sending).resolves.toMatchObject({ ok: true });
    await expect(peer.sendMessage(route.installationId, message)).resolves.toMatchObject({ ok: true });
    expect(await templateMessages()).toHaveLength(before + 1);
  });

  it("marks the message Ship is working on with 👀 until the run stops", async () => {
    const { route } = await linkedPeer("open");
    const channel = new deployedAdapter.ManagedWhatsAppChannel(createExecutionContext(),
      typedStub<ConstructorParameters<typeof deployedAdapter.ManagedWhatsAppChannel>[1]>(env));
    const installation = { installationId: route.installationId };
    const surface = { kind: "dm" as const, id: ACTOR };
    const activity = (active: boolean) => channel.adapterSetActivity(
      installation, "managed", surface, { kind: "typing", active, routeGeneration: route.generation },
    );
    const reactions = async () => (await sentMessages())
      .filter((record) => record.body.type === "reaction")
      .map((record) => record.body.reaction);

    expect((await SELF.fetch(await text("wamid.in.working.1", "first question"))).status).toBe(200);
    await vi.waitFor(async () => { expect((await sentMessages()).at(-1)?.body.text?.body).toBe("Personal received first question"); });
    // Earlier runs in this flow may still hold a reaction; stopping clears it.
    await expect(activity(false)).resolves.toEqual({ ok: true });
    const before = (await reactions()).length;

    await expect(activity(true)).resolves.toEqual({ ok: true });
    expect((await reactions()).slice(before)).toEqual([{ message_id: "wamid.in.working.1", emoji: "👀" }]);

    // A run for a newer message moves the reaction instead of leaving the old one behind.
    expect((await SELF.fetch(await text("wamid.in.working.2", "second question"))).status).toBe(200);
    await vi.waitFor(async () => { expect((await sentMessages()).at(-1)?.body.text?.body).toBe("Personal received second question"); });
    await expect(activity(true)).resolves.toEqual({ ok: true });
    expect((await reactions()).slice(before + 1)).toEqual([
      { message_id: "wamid.in.working.1", emoji: "" },
      { message_id: "wamid.in.working.2", emoji: "👀" },
    ]);

    await expect(activity(false)).resolves.toEqual({ ok: true });
    await expect(activity(false)).resolves.toEqual({ ok: true });
    expect((await reactions()).slice(before + 3)).toEqual([{ message_id: "wamid.in.working.2", emoji: "" }]);
  });

  it("ignores a stop from a superseded run that arrives after its successor started", async () => {
    const { route } = await linkedPeer("open");
    const channel = new deployedAdapter.ManagedWhatsAppChannel(createExecutionContext(),
      typedStub<ConstructorParameters<typeof deployedAdapter.ManagedWhatsAppChannel>[1]>(env));
    const installation = { installationId: route.installationId };
    const surface = { kind: "dm" as const, id: ACTOR };
    const activity = (active: boolean, runId: string) => channel.adapterSetActivity(
      installation, "managed", surface, { kind: "typing", active, routeGeneration: route.generation, runId },
    );
    const reactions = async () => (await sentMessages())
      .filter((record) => record.body.type === "reaction")
      .map((record) => record.body.reaction);

    expect((await SELF.fetch(await text("wamid.in.superseded.1", "first part"))).status).toBe(200);
    await vi.waitFor(async () => { expect((await sentMessages()).at(-1)?.body.text?.body).toBe("Personal received first part"); });
    await expect(activity(false, "run-earlier")).resolves.toEqual({ ok: true });
    const before = (await reactions()).length;
    await expect(activity(true, "run-1")).resolves.toEqual({ ok: true });

    expect((await SELF.fetch(await text("wamid.in.superseded.2", "second part"))).status).toBe(200);
    await vi.waitFor(async () => { expect((await sentMessages()).at(-1)?.body.text?.body).toBe("Personal received second part"); });
    await expect(activity(true, "run-2")).resolves.toEqual({ ok: true });
    // The superseded run's stop arrives late; run 2 is still working.
    await expect(activity(false, "run-1")).resolves.toEqual({ ok: true });
    expect((await reactions()).slice(before)).toEqual([
      { message_id: "wamid.in.superseded.1", emoji: "👀" },
      { message_id: "wamid.in.superseded.1", emoji: "" },
      { message_id: "wamid.in.superseded.2", emoji: "👀" },
    ]);

    await expect(activity(false, "run-2")).resolves.toEqual({ ok: true });
    expect((await reactions()).slice(before + 3)).toEqual([{ message_id: "wamid.in.superseded.2", emoji: "" }]);
  });

  it("clears a 👀 whose addition had an unknown outcome, but not one Meta rejected", async () => {
    const { route } = await linkedPeer("open");
    const channel = new deployedAdapter.ManagedWhatsAppChannel(createExecutionContext(),
      typedStub<ConstructorParameters<typeof deployedAdapter.ManagedWhatsAppChannel>[1]>(env));
    const installation = { installationId: route.installationId };
    const surface = { kind: "dm" as const, id: ACTOR };
    const activity = (active: boolean, runId: string) => channel.adapterSetActivity(
      installation, "managed", surface, { kind: "typing", active, routeGeneration: route.generation, runId },
    );
    const reactions = async () => (await sentMessages())
      .filter((record) => record.body.type === "reaction")
      .map((record) => record.body.reaction);
    // SAFETY: The Cloudflare test environment declares WHATSAPP_API as a Fetcher binding.
    const graph = env.WHATSAPP_API as Fetcher;
    const warn = vi.spyOn(console, "warn");

    expect((await SELF.fetch(await text("wamid.in.ambiguous.1", "unknown outcome"))).status).toBe(200);
    await vi.waitFor(async () => { expect((await sentMessages()).at(-1)?.body.text?.body).toBe("Personal received unknown outcome"); });
    await expect(activity(false, "run-earlier")).resolves.toEqual({ ok: true });
    const before = (await reactions()).length;
    // Meta may have applied 👀 before answering 500, so the stop still removes it.
    await graph.fetch("https://graph.test/fail-next-reaction", { method: "POST" });
    await expect(activity(true, "run-ambiguous")).resolves.toEqual({ ok: true });
    await expect(activity(false, "run-ambiguous")).resolves.toEqual({ ok: true });
    expect((await reactions()).slice(before)).toEqual([{ message_id: "wamid.in.ambiguous.1", emoji: "" }]);
    // The failure keeps Meta's answer for diagnosis, without the person's number or message.
    const failure = warn.mock.calls.map(([line]) => String(line)).find((line) => line.includes("reaction_delivery_failed"));
    expect(JSON.parse(failure ?? "{}")).toMatchObject({
      component: "managed_whatsapp", event: "reaction_delivery_failed", outcome: "ambiguous",
      diagnostics: { providerStatusCode: 500, errorCode: "2", providerRequestId: "trace-reaction" },
    });
    expect(failure).not.toContain(ACTOR);
    expect(failure).not.toContain("wamid.in.ambiguous.1");
    warn.mockRestore();

    expect((await SELF.fetch(await text("wamid.in.ambiguous.2", "rejected outright"))).status).toBe(200);
    await vi.waitFor(async () => { expect((await sentMessages()).at(-1)?.body.text?.body).toBe("Personal received rejected outright"); });
    const afterAmbiguous = (await reactions()).length;
    await graph.fetch("https://graph.test/fail-next-reaction", { method: "POST", body: "rejected" });
    await expect(activity(true, "run-rejected")).resolves.toEqual({ ok: true });
    await expect(activity(false, "run-rejected")).resolves.toEqual({ ok: true });
    expect((await reactions()).slice(afterAmbiguous)).toEqual([]);
  });

  it("keeps retrying a 👀 removal that failed instead of stranding it", async () => {
    const { route } = await linkedPeer("open");
    const channel = new deployedAdapter.ManagedWhatsAppChannel(createExecutionContext(),
      typedStub<ConstructorParameters<typeof deployedAdapter.ManagedWhatsAppChannel>[1]>(env));
    const installation = { installationId: route.installationId };
    const surface = { kind: "dm" as const, id: ACTOR };
    const activity = (active: boolean, runId: string) => channel.adapterSetActivity(
      installation, "managed", surface, { kind: "typing", active, routeGeneration: route.generation, runId },
    );
    const reactions = async () => (await sentMessages())
      .filter((record) => record.body.type === "reaction")
      .map((record) => record.body.reaction);
    // SAFETY: The Cloudflare test environment declares WHATSAPP_API as a Fetcher binding.
    const graph = env.WHATSAPP_API as Fetcher;

    expect((await SELF.fetch(await text("wamid.in.stranded.1", "first ask"))).status).toBe(200);
    await vi.waitFor(async () => { expect((await sentMessages()).at(-1)?.body.text?.body).toBe("Personal received first ask"); });
    await expect(activity(false, "run-earlier")).resolves.toEqual({ ok: true });
    const before = (await reactions()).length;
    await expect(activity(true, "run-a")).resolves.toEqual({ ok: true });

    expect((await SELF.fetch(await text("wamid.in.stranded.2", "second ask"))).status).toBe(200);
    await vi.waitFor(async () => { expect((await sentMessages()).at(-1)?.body.text?.body).toBe("Personal received second ask"); });
    await graph.fetch("https://graph.test/fail-next-reaction", { method: "POST" });
    // Removing 👀 from the first message fails, so it stays the one to clear.
    await expect(activity(true, "run-b")).resolves.toEqual({ ok: true });
    await expect(activity(false, "run-b")).resolves.toEqual({ ok: true });

    expect((await reactions()).slice(before)).toEqual([
      { message_id: "wamid.in.stranded.1", emoji: "👀" },
      { message_id: "wamid.in.stranded.1", emoji: "" },
    ]);
  });

});

it("does not export the retired linked-device entrypoints", async () => {
  expect(deployedAdapter).not.toHaveProperty("WhatsAppChannel");
  expect(deployedAdapter).not.toHaveProperty("WhatsAppAccount");
  expect(deployedAdapter).not.toHaveProperty("WhatsAppChannelEntrypoint");
  expect((await SELF.fetch("https://fixture/webhook/default", { method: "POST", body: "{}" })).status).toBe(404);
});
