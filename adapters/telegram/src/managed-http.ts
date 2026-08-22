import {
  managedTelegramConfigured,
  validManagedTelegramWebhookSecret,
} from "./managed-config";
import {
  normalizeManagedTelegramUpdate,
  type ManagedTelegramInbound,
} from "./managed-update";

type ManagedTelegramPeerStub = DurableObjectStub & {
  handleWebhook(inbound: ManagedTelegramInbound): Promise<{ ok: true }>;
};

export type ManagedTelegramHttpEnv = {
  MANAGED_TELEGRAM_PEER: Pick<DurableObjectNamespace, "idFromName" | "get">;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_ALLOWED_ACTOR_IDS?: string;
};

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

export async function handleManagedTelegramRequest(
  request: Request,
  env: ManagedTelegramHttpEnv,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    return Response.json({
      service: "gsv-managed-telegram",
      status: "ok",
      configured: managedTelegramConfigured(env),
    });
  }
  if (request.method !== "POST" || url.pathname !== "/webhook") {
    return new Response("Not Found", { status: 404 });
  }

  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? "";
  if (!validManagedTelegramWebhookSecret(webhookSecret)) {
    return Response.json({ ok: false, error: "Webhook is not configured" }, { status: 503 });
  }
  const presented = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!constantTimeEqual(presented, webhookSecret)) {
    await request.body?.cancel("Forbidden").catch(() => undefined);
    return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await readBoundedRequestText(request, MAX_WEBHOOK_BODY_BYTES));
  } catch (error) {
    const status = error instanceof ManagedTelegramBodyTooLargeError ? 413 : 400;
    return Response.json({ ok: false, error: "Invalid Telegram update" }, { status });
  }
  const normalized = normalizeManagedTelegramUpdate(payload);
  if (normalized.kind === "invalid") {
    return Response.json({ ok: false, error: "Invalid Telegram update" }, { status: 400 });
  }
  if (normalized.kind === "ignored") return Response.json({ ok: true });
  const allowlist = allowedActorIds(env.TELEGRAM_ALLOWED_ACTOR_IDS);
  if (allowlist && !allowlist.has(normalized.inbound.actorId)) {
    return Response.json({ ok: true });
  }

  const id = env.MANAGED_TELEGRAM_PEER.idFromName(
    `managed:${normalized.inbound.surfaceId}`,
  );
  // SAFETY: the managed peer namespace is owned by this worker and exposes the handleWebhook RPC.
  const peer = env.MANAGED_TELEGRAM_PEER.get(id) as ManagedTelegramPeerStub;
  await peer.handleWebhook(normalized.inbound);
  return Response.json({ ok: true });
}

function allowedActorIds(value: string | undefined): Set<string> | null {
  if (!value?.trim()) return null;
  const ids = value.split(",").map((id) => id.trim()).filter(Boolean);
  if (ids.some((id) => !/^[1-9][0-9]{0,19}$/.test(id))) {
    throw new Error("Managed Telegram actor allowlist is invalid");
  }
  return new Set(ids);
}

async function readBoundedRequestText(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get("Content-Length");
  if (declared && (/^[0-9]+$/.test(declared) ? Number(declared) : Infinity) > maxBytes) {
    await request.body?.cancel("Telegram webhook body exceeds limit").catch(() => undefined);
    throw new ManagedTelegramBodyTooLargeError();
  }
  if (!request.body) throw new Error("Telegram webhook body is required");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel("Telegram webhook body exceeds limit").catch(() => undefined);
        throw new ManagedTelegramBodyTooLargeError();
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
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

class ManagedTelegramBodyTooLargeError extends Error {}
