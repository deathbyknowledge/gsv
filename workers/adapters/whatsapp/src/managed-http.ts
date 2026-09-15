import {
  managedWhatsAppConfigured,
  validManagedWhatsAppGraphId,
  validManagedWhatsAppVerifyToken,
  type ManagedWhatsAppConfigEnv,
} from "./managed-config";
import {
  answerWhatsAppVerification,
  normalizeWhatsAppWebhook,
  validWhatsAppSignatureHeader,
  verifyWhatsAppSignature,
  type ManagedWhatsAppPeerEvent,
} from "./whatsapp-webhook";

type ManagedWhatsAppPeerStub = DurableObjectStub & {
  handleWebhook(event: ManagedWhatsAppPeerEvent): Promise<{ ok: true }>;
};

export type ManagedWhatsAppHttpEnv = ManagedWhatsAppConfigEnv & {
  MANAGED_WHATSAPP_PEER: Pick<DurableObjectNamespace, "idFromName" | "get">;
  WHATSAPP_ALLOWED_ACTOR_IDS?: string;
};

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

export async function handleManagedWhatsAppRequest(
  request: Request,
  env: ManagedWhatsAppHttpEnv,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    return Response.json({
      service: "gsv-managed-whatsapp",
      status: "ok",
      configured: managedWhatsAppConfigured(env),
    });
  }
  if (url.pathname !== "/webhook") {
    return new Response("Not Found", { status: 404 });
  }
  if (request.method === "GET") {
    const verifyToken = env.WHATSAPP_VERIFY_TOKEN?.trim() ?? "";
    if (!validManagedWhatsAppVerifyToken(verifyToken)) {
      return Response.json({ ok: false, error: "Webhook is not configured" }, { status: 503 });
    }
    return answerWhatsAppVerification(url, verifyToken);
  }
  if (request.method !== "POST") {
    return new Response("Not Found", { status: 404 });
  }

  const appSecret = env.WHATSAPP_APP_SECRET?.trim() ?? "";
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim() ?? "";
  if (appSecret.length < 16 || !validManagedWhatsAppGraphId(phoneNumberId)) {
    await request.body?.cancel("Webhook is not configured").catch(() => undefined);
    return Response.json({ ok: false, error: "Webhook is not configured" }, { status: 503 });
  }
  const signature = request.headers.get("X-Hub-Signature-256");
  if (!validWhatsAppSignatureHeader(signature)) {
    await request.body?.cancel("Forbidden").catch(() => undefined);
    return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  let raw: Uint8Array;
  try {
    raw = await readBoundedRequestBytes(request, MAX_WEBHOOK_BODY_BYTES);
  } catch (error) {
    const status = error instanceof ManagedWhatsAppBodyTooLargeError ? 413 : 400;
    return Response.json({ ok: false, error: "Invalid WhatsApp notification" }, { status });
  }
  if (!await verifyWhatsAppSignature(signature, raw, appSecret)) {
    return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw));
  } catch {
    return Response.json({ ok: false, error: "Invalid WhatsApp notification" }, { status: 400 });
  }
  const normalized = normalizeWhatsAppWebhook(payload, phoneNumberId);
  if (normalized.kind === "invalid") {
    return Response.json({ ok: false, error: "Invalid WhatsApp notification" }, { status: 400 });
  }
  if (normalized.kind === "ignored") return Response.json({ ok: true });

  const allowlist = allowedActorIds(env.WHATSAPP_ALLOWED_ACTOR_IDS);
  let rejected = 0;
  for (const event of normalized.events) {
    const actorId = event.kind === "approval" ? event.reply.actorId : event.inbound.actorId;
    const surfaceId = event.kind === "approval" ? event.reply.surfaceId : event.inbound.surfaceId;
    if (allowlist && !allowlist.has(actorId)) continue;
    const id = env.MANAGED_WHATSAPP_PEER.idFromName(`managed:${surfaceId}`);
    // SAFETY: the managed peer namespace is owned by this worker and exposes the handleWebhook RPC.
    const peer = env.MANAGED_WHATSAPP_PEER.get(id) as ManagedWhatsAppPeerStub;
    try {
      await peer.handleWebhook(event);
    } catch {
      rejected += 1;
      console.warn(JSON.stringify({
        component: "managed_whatsapp",
        event: "inbound_backlog_rejected",
      }));
    }
  }
  if (rejected > 0) {
    return Response.json(
      { ok: false, error: "WhatsApp notification could not be accepted" },
      { status: 503 },
    );
  }
  return Response.json({ ok: true });
}

function allowedActorIds(value: string | undefined): Set<string> | null {
  if (!value?.trim()) return null;
  const ids = value.split(",").map((id) => id.trim()).filter(Boolean);
  if (ids.some((id) => !/^[1-9][0-9]{4,14}$/.test(id))) {
    throw new Error("Managed WhatsApp actor allowlist is invalid");
  }
  return new Set(ids);
}

async function readBoundedRequestBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("Content-Length");
  if (declared && (/^[0-9]+$/.test(declared) ? Number(declared) : Infinity) > maxBytes) {
    await request.body?.cancel("WhatsApp webhook body exceeds limit").catch(() => undefined);
    throw new ManagedWhatsAppBodyTooLargeError();
  }
  if (!request.body) throw new Error("WhatsApp webhook body is required");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel("WhatsApp webhook body exceeds limit").catch(() => undefined);
        throw new ManagedWhatsAppBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

class ManagedWhatsAppBodyTooLargeError extends Error {}
