import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ActivateManagedTelegramClaimInput,
  ActivateManagedTelegramClaimResult,
  ManagedTelegramClaimInspection,
  ManagedTelegramControlInterface,
  ManagedTelegramDataLifecycleInterface,
  ManagedTelegramInstallationRouteLifecycleInput,
  ManagedTelegramPublicInterface,
  SuspendManagedTelegramClaimInput,
  SuspendManagedTelegramClaimResult,
} from "../../../packages/gsv/src/protocol/managed.js";
import { MANAGED_TELEGRAM_ACCOUNT_ID } from "../../../packages/gsv/src/protocol/managed.js";
import { cancelBinaryBody } from "../../shared/src/media-body";
import {
  LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
  parseAdapterInstallationContext,
} from "../../shared/src/installation";
import type {
  AdapterAccountStatus,
  AdapterActivity,
  AdapterConnectResult,
  AdapterDisconnectResult,
  AdapterInstallationContext,
  AdapterOutboundMessage,
  AdapterSendResult,
  AdapterSurface,
  AdapterWorkerInterface,
  BinaryBody,
} from "./types";
import {
  parseManagedTelegramClaimToken,
  parseAccountOrigin,
} from "./managed-claim";
import type { ManagedTelegramPeerEnv } from "./managed-peer";
import { normalizeManagedTelegramUpdate } from "./managed-update";

export { ManagedTelegramPeer } from "./managed-peer";

interface Env extends ManagedTelegramPeerEnv {
  MANAGED_TELEGRAM_PEER: DurableObjectNamespace;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

type ManagedTelegramPeerStub = {
  handleWebhook(
    inbound: Extract<
      ReturnType<typeof normalizeManagedTelegramUpdate>,
      { kind: "accepted" }
    >["inbound"],
  ): Promise<{ ok: true }>;
  sendMessage(
    installationId: string,
    message: AdapterOutboundMessage,
  ): Promise<AdapterSendResult>;
  setTyping(
    installationId: string,
    surface: AdapterSurface,
    actorId: string,
    active: boolean,
  ): Promise<void>;
  inspectClaim(claimToken: string): Promise<ManagedTelegramClaimInspection>;
  suspendClaim(
    input: SuspendManagedTelegramClaimInput,
  ): Promise<SuspendManagedTelegramClaimResult>;
  activateClaim(
    input: ActivateManagedTelegramClaimInput,
  ): Promise<ActivateManagedTelegramClaimResult>;
  suspendInstallationRoute(
    input: ManagedTelegramInstallationRouteLifecycleInput,
  ): Promise<{ suspended: boolean }>;
  recoverInstallationRoute(
    input: ManagedTelegramInstallationRouteLifecycleInput,
  ): Promise<{ recovered: boolean }>;
  deleteInstallationRoute(
    input: ManagedTelegramInstallationRouteLifecycleInput,
  ): Promise<{ deleted: boolean }>;
};

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

export class ManagedTelegramChannel
  extends WorkerEntrypoint<Env>
  implements
    AdapterWorkerInterface,
    ManagedTelegramControlInterface,
    ManagedTelegramDataLifecycleInterface,
    ManagedTelegramPublicInterface
{
  readonly adapterId = "telegram";

  async adapterConnect(
    installation: AdapterInstallationContext,
    _accountId: string,
    _config: Record<string, unknown> = {},
  ): Promise<AdapterConnectResult> {
    parseManagedInstallation(installation);
    return {
      ok: false,
      error: "The managed Telegram bot is platform-owned and cannot be connected",
    };
  }

  async adapterDisconnect(
    installation: AdapterInstallationContext,
    _accountId: string,
  ): Promise<AdapterDisconnectResult> {
    parseManagedInstallation(installation);
    return {
      ok: false,
      error: "The managed Telegram bot is platform-owned and cannot be disconnected",
    };
  }

  async adapterStatus(
    installation: AdapterInstallationContext,
    accountId?: string,
  ): Promise<AdapterAccountStatus[]> {
    parseManagedInstallation(installation);
    if (accountId && accountId !== MANAGED_TELEGRAM_ACCOUNT_ID) return [];
    const configured = this.isConfigured();
    return [{
      accountId: MANAGED_TELEGRAM_ACCOUNT_ID,
      connected: configured,
      authenticated: configured,
      mode: "managed-shared",
      ...(!configured ? { error: "The managed Telegram bot is not configured" } : {}),
    }];
  }

  async adapterSend(
    installation: AdapterInstallationContext,
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<AdapterSendResult> {
    let parsed: AdapterInstallationContext;
    try {
      parsed = parseManagedInstallation(installation);
      if (accountId !== MANAGED_TELEGRAM_ACCOUNT_ID) {
        throw new Error("Managed Telegram account ID is invalid");
      }
      if (body || message.media?.length) {
        throw new Error("Managed Telegram does not support media yet");
      }
      if (message.surface.kind !== "dm" || !message.actorId) {
        throw new Error("Managed Telegram supports direct-message destinations only");
      }
      const peer = this.peerForSurface(message.surface.id);
      return await peer.sendMessage(parsed.installationId, message);
    } catch (error) {
      await cancelBinaryBody(body, error);
      return { ok: false, error: errorMessage(error) };
    }
  }

  async adapterSetActivity(
    installation: AdapterInstallationContext,
    accountId: string,
    surface: AdapterSurface,
    activity: AdapterActivity,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const parsed = parseManagedInstallation(installation);
      if (accountId !== MANAGED_TELEGRAM_ACCOUNT_ID) {
        throw new Error("Managed Telegram account ID is invalid");
      }
      if (surface.kind !== "dm") {
        throw new Error("Managed Telegram supports direct-message destinations only");
      }
      if (activity.kind !== "typing" || !activity.active) return { ok: true };
      await this.peerForSurface(surface.id).setTyping(
        parsed.installationId,
        surface,
        surface.id,
        true,
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  async inspectManagedTelegramClaim(
    claimToken: string,
  ): Promise<ManagedTelegramClaimInspection> {
    const peer = this.peerForClaim(claimToken);
    return peer
      ? await peer.inspectClaim(claimToken)
      : { ok: false, reason: "invalid" };
  }

  async getManagedTelegramPublicBot(): Promise<{ username: string }> {
    return {
      username: managedTelegramBotUsername(this.env.TELEGRAM_BOT_USERNAME),
    };
  }

  async suspendManagedTelegramClaim(
    input: SuspendManagedTelegramClaimInput,
  ): Promise<SuspendManagedTelegramClaimResult> {
    const peer = this.peerForClaim(input.claimToken);
    if (!peer) throw new Error("Managed Telegram claim is invalid");
    return await peer.suspendClaim(input);
  }

  async activateManagedTelegramClaim(
    input: ActivateManagedTelegramClaimInput,
  ): Promise<ActivateManagedTelegramClaimResult> {
    const peer = this.peerForClaim(input.claimToken);
    if (!peer) throw new Error("Managed Telegram claim is invalid");
    return await peer.activateClaim(input);
  }

  async suspendManagedTelegramInstallationRoute(
    input: ManagedTelegramInstallationRouteLifecycleInput,
  ): Promise<{ suspended: boolean }> {
    return await this.peerForSurface(input.surfaceId).suspendInstallationRoute(input);
  }

  async recoverManagedTelegramInstallationRoute(
    input: ManagedTelegramInstallationRouteLifecycleInput,
  ): Promise<{ recovered: boolean }> {
    return await this.peerForSurface(input.surfaceId).recoverInstallationRoute(input);
  }

  async deleteManagedTelegramInstallationRoute(
    input: ManagedTelegramInstallationRouteLifecycleInput,
  ): Promise<{ deleted: boolean }> {
    return await this.peerForSurface(input.surfaceId).deleteInstallationRoute(input);
  }

  private peerForSurface(surfaceId: string): ManagedTelegramPeerStub {
    if (!/^[1-9][0-9]{0,19}$/.test(surfaceId)) {
      throw new Error("Managed Telegram surface ID is invalid");
    }
    const id = this.env.MANAGED_TELEGRAM_PEER.idFromName(`managed:${surfaceId}`);
    return this.env.MANAGED_TELEGRAM_PEER.get(id) as unknown as ManagedTelegramPeerStub;
  }

  private peerForClaim(claimToken: string): ManagedTelegramPeerStub | null {
    const parsed = parseManagedTelegramClaimToken(claimToken);
    if (!parsed) return null;
    try {
      const id = this.env.MANAGED_TELEGRAM_PEER.idFromString(
        parsed.durableObjectId,
      );
      return this.env.MANAGED_TELEGRAM_PEER.get(id) as unknown as ManagedTelegramPeerStub;
    } catch {
      return null;
    }
  }

  private isConfigured(): boolean {
    if (
      !this.env.TELEGRAM_BOT_TOKEN?.trim()
      || !validManagedTelegramBotUsername(this.env.TELEGRAM_BOT_USERNAME)
      || !this.env.TELEGRAM_WEBHOOK_SECRET?.trim()
      || (this.env.TELEGRAM_CLAIM_SIGNING_KEY?.trim().length ?? 0) < 32
    ) {
      return false;
    }
    try {
      parseAccountOrigin(
        this.env.GSV_ACCOUNT_ORIGIN ?? "https://accounts.gsv.space",
      );
      return true;
    } catch {
      return false;
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return Response.json({
        service: "gsv-managed-telegram",
        status: "ok",
        configured: Boolean(
          env.TELEGRAM_BOT_TOKEN?.trim()
          && validManagedTelegramBotUsername(env.TELEGRAM_BOT_USERNAME)
          && env.TELEGRAM_WEBHOOK_SECRET?.trim()
          && (env.TELEGRAM_CLAIM_SIGNING_KEY?.trim().length ?? 0) >= 32
        ),
      });
    }
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not Found", { status: 404 });
    }

    const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
    if (!webhookSecret) {
      return Response.json({ ok: false, error: "Webhook is not configured" }, {
        status: 503,
      });
    }
    const presented = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    if (!constantTimeEqual(presented, webhookSecret)) {
      return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await readBoundedRequestText(
        request,
        MAX_WEBHOOK_BODY_BYTES,
      ));
    } catch (error) {
      return Response.json({ ok: false, error: errorMessage(error) }, { status: 400 });
    }
    const normalized = normalizeManagedTelegramUpdate(payload);
    if (normalized.kind === "invalid") {
      return Response.json({ ok: false, error: "Invalid Telegram update" }, {
        status: 400,
      });
    }
    if (normalized.kind === "ignored") {
      return Response.json({ ok: true });
    }

    const id = env.MANAGED_TELEGRAM_PEER.idFromName(
      `managed:${normalized.inbound.surfaceId}`,
    );
    const peer = env.MANAGED_TELEGRAM_PEER.get(id) as unknown as ManagedTelegramPeerStub;
    await peer.handleWebhook(normalized.inbound);
    return Response.json({ ok: true });
  },
};

function managedTelegramBotUsername(value: string | undefined): string {
  const username = value?.trim().replace(/^@/, "") ?? "";
  if (!validManagedTelegramBotUsername(username)) {
    throw new Error("Managed Telegram bot username is not configured");
  }
  return username;
}

function validManagedTelegramBotUsername(value: string | undefined): boolean {
  const username = value?.trim().replace(/^@/, "") ?? "";
  return username.length >= 5
    && username.length <= 32
    && /^[A-Za-z][A-Za-z0-9_]*bot$/i.test(username);
}

async function readBoundedRequestText(
  request: Request,
  maxBytes: number,
): Promise<string> {
  const declared = request.headers.get("Content-Length");
  if (declared && (/^[0-9]+$/.test(declared) ? Number(declared) : Infinity) > maxBytes) {
    await request.body?.cancel("Telegram webhook body exceeds limit").catch(() => {});
    throw new Error("Telegram webhook body exceeds limit");
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
        await reader.cancel("Telegram webhook body exceeds limit").catch(() => {});
        throw new Error("Telegram webhook body exceeds limit");
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseManagedInstallation(
  value: unknown,
): AdapterInstallationContext {
  const installation = parseAdapterInstallationContext(value);
  if (
    installation.installationId
    === LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID
  ) {
    throw new Error("Managed Telegram cannot address singleton");
  }
  return installation;
}
