import { WorkerEntrypoint } from "cloudflare:workers";
import {
  MANAGED_TELEGRAM_ACCOUNT_ID,
  type AdapterInstallationContext,
  type AdapterPairingActivateInput,
  type AdapterPairingCandidate,
  type AdapterPairingDisconnectInput,
  type AdapterPairingDisconnectResult,
  type AdapterPairingFinalizeInput,
  type AdapterPairingInfo,
  type AdapterPairingPreparation,
  type AdapterPairingPrepareInput,
} from "../../../../packages/gsv/src/protocol/adapters.js";
import type {
  AdapterService,
  AdapterServiceDescriptor,
} from "../../../../packages/gsv/src/services/adapters.js";
import { handleAdapterFrame } from "../../shared/src/adapter-frame";
import { cancelBinaryBody } from "../../shared/src/media-body";
import {
  LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
  parseAdapterInstallationContext,
} from "../../shared/src/installation";
import type {
  AdapterAccountStatus,
  AdapterActivity,
  AdapterOutboundMessage,
  AdapterDeliveryContext,
  AdapterSendResult,
  AdapterSurface,
  BinaryBody,
  GatewayRequestFrame,
  GatewayResponseFrame,
} from "./types";
import type { ManagedTelegramPeerEnv } from "./managed-peer";
import {
  managedTelegramConfigured,
  normalizedManagedTelegramBotUsername,
  validManagedTelegramBotUsername,
} from "./managed-config";
import { handleManagedTelegramRequest } from "./managed-http";

export { ManagedTelegramPairing } from "./managed-pairing";
export { ManagedTelegramPeer } from "./managed-peer";

interface Env extends ManagedTelegramPeerEnv {
  MANAGED_TELEGRAM_PEER: DurableObjectNamespace;
  MANAGED_TELEGRAM_PAIRING: DurableObjectNamespace;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_ALLOWED_ACTOR_IDS?: string;
}

type ManagedTelegramPeerStub = {
  sendMessage(
    installationId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
    context?: AdapterDeliveryContext,
  ): Promise<AdapterSendResult>;
  setTyping(
    installationId: string,
    surface: AdapterSurface,
    actorId: string,
    routeGeneration: string,
    active: boolean,
  ): Promise<{ accepted: boolean }>;
  disconnect(input: AdapterPairingDisconnectInput): Promise<AdapterPairingDisconnectResult>;
};

type ManagedTelegramPairingStub = {
  inspect(): Promise<AdapterPairingCandidate>;
  prepare(input: AdapterPairingPrepareInput): Promise<AdapterPairingPreparation>;
  activate(input: AdapterPairingActivateInput): Promise<AdapterPairingPreparation>;
  finalize(input: AdapterPairingFinalizeInput): Promise<AdapterPairingPreparation>;
};

export class ManagedTelegramChannel extends WorkerEntrypoint<Env> implements AdapterService {
  readonly adapterId = "telegram";

  async adapterDescribe(): Promise<AdapterServiceDescriptor> {
    return {
      version: 1,
      id: this.adapterId,
      displayName: "Telegram",
      capabilities: {
        connect: false,
        disconnect: false,
        send: true,
        status: true,
        activity: true,
        pairing: true,
        surfaces: ["dm"],
        media: {
          inbound: ["image", "audio", "video", "document"],
          outbound: ["image", "audio", "video", "document"],
        },
      },
    };
  }

  async adapterFrame(
    installation: AdapterInstallationContext,
    context: AdapterDeliveryContext,
    frame: GatewayRequestFrame,
  ): Promise<GatewayResponseFrame> {
    const parsed = parseManagedInstallation(installation);
    if (
      context.accountId !== MANAGED_TELEGRAM_ACCOUNT_ID
      || context.surface.kind !== "dm"
      || !context.actorId
    ) {
      await cancelBinaryBody(frame.body, "Managed Telegram frame destination is invalid");
      throw new Error("Managed Telegram frame destination is invalid");
    }
    const peer = this.peer(context.surface.id);
    return await handleAdapterFrame(this.adapterId, context, frame, {
      send: async (delivery, requestBody) => await peer.sendMessage(
        parsed.installationId,
        delivery.message,
        requestBody,
        context,
      ),
    });
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
      authenticated: false,
      mode: "managed-shared",
      error: configured ? undefined : "Managed Telegram is not configured",
      extra: validManagedTelegramBotUsername(this.env.TELEGRAM_BOT_USERNAME)
        ? { botUsername: normalizedManagedTelegramBotUsername(this.env.TELEGRAM_BOT_USERNAME) }
        : undefined,
    }];
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
      if (surface.kind !== "dm") throw new Error("Managed Telegram supports direct messages only");
      if (activity.kind !== "typing" || !activity.active) return { ok: true };
      const routeGeneration = activity.routeGeneration?.trim();
      if (!routeGeneration) {
        throw new Error("Managed Telegram route generation is required");
      }
      const result = await this.peer(surface.id).setTyping(
        parsed.installationId,
        surface,
        surface.id,
        routeGeneration,
        true,
      );
      if (!result.accepted) {
        throw new Error("Telegram route changed before activity delivery");
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: safeError(error instanceof Error ? error : String(error)) };
    }
  }

  async adapterPairingInfo(
    installation: AdapterInstallationContext,
  ): Promise<AdapterPairingInfo> {
    parseManagedInstallation(installation);
    return {
      accountId: MANAGED_TELEGRAM_ACCOUNT_ID,
      configured: this.isConfigured(),
      botUsername: validManagedTelegramBotUsername(this.env.TELEGRAM_BOT_USERNAME)
        ? normalizedManagedTelegramBotUsername(this.env.TELEGRAM_BOT_USERNAME)
        : undefined,
    };
  }

  async adapterPairingInspect(
    installation: AdapterInstallationContext,
    code: string,
  ): Promise<AdapterPairingCandidate> {
    parseManagedInstallation(installation);
    return await this.pairing(code).inspect();
  }

  async adapterPairingPrepare(
    installation: AdapterInstallationContext,
    input: AdapterPairingPrepareInput,
  ): Promise<AdapterPairingPreparation> {
    const parsed = parseManagedInstallation(installation);
    if (input.installationId !== parsed.installationId) {
      throw new Error("Pairing installation does not match the caller");
    }
    return await this.pairing(input.code).prepare(input);
  }

  async adapterPairingActivate(
    installation: AdapterInstallationContext,
    input: AdapterPairingActivateInput,
  ): Promise<AdapterPairingPreparation> {
    const parsed = parseManagedInstallation(installation);
    if (input.route.installationId !== parsed.installationId) {
      throw new Error("Pairing installation does not match the caller");
    }
    return await this.pairing(input.code).activate(input);
  }

  async adapterPairingFinalize(
    installation: AdapterInstallationContext,
    input: AdapterPairingFinalizeInput,
  ): Promise<AdapterPairingPreparation> {
    const parsed = parseManagedInstallation(installation);
    if (input.route.installationId !== parsed.installationId) {
      throw new Error("Pairing installation does not match the caller");
    }
    return await this.pairing(input.code).finalize(input);
  }

  async adapterPairingDisconnect(
    installation: AdapterInstallationContext,
    input: AdapterPairingDisconnectInput,
  ): Promise<AdapterPairingDisconnectResult> {
    const parsed = parseManagedInstallation(installation);
    if (input.installationId !== parsed.installationId) {
      throw new Error("Pairing installation does not match the caller");
    }
    if (input.accountId !== MANAGED_TELEGRAM_ACCOUNT_ID) {
      throw new Error("Managed Telegram account ID is invalid");
    }
    return await this.peer(input.surfaceId).disconnect(input);
  }

  private peer(surfaceId: string): ManagedTelegramPeerStub {
    if (!/^[1-9][0-9]{0,19}$/.test(surfaceId)) {
      throw new Error("Managed Telegram surface ID is invalid");
    }
    const id = this.env.MANAGED_TELEGRAM_PEER.idFromName(`managed:${surfaceId}`);
    return typedStub(this.env.MANAGED_TELEGRAM_PEER.get(id));
  }

  private pairing(code: string): ManagedTelegramPairingStub {
    const normalized = normalizePairingCode(code);
    const id = this.env.MANAGED_TELEGRAM_PAIRING.idFromName(`pair:${normalized}`);
    return typedStub(this.env.MANAGED_TELEGRAM_PAIRING.get(id));
  }

  private isConfigured(): boolean {
    return managedTelegramConfigured(this.env);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return await handleManagedTelegramRequest(request, env);
  },
} satisfies ExportedHandler<Env>;

function parseManagedInstallation(value: AdapterInstallationContext): AdapterInstallationContext {
  const installation = parseAdapterInstallationContext(value);
  if (installation.installationId === LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID) {
    throw new Error("Managed Telegram cannot address singleton");
  }
  return installation;
}

function normalizePairingCode(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (!/^[A-HJ-NP-Z2-9]{12}$/.test(normalized)) throw new Error("Pairing code is invalid");
  return normalized;
}

function typedStub<T, V>(value: V): T {
  // SAFETY: The Durable Object namespace binding owns the declared RPC contract.
  return value as T & V;
}

function safeError(error: Error | string): string {
  if (error instanceof Error && /not linked|invalid|direct messages|media/.test(error.message)) {
    return error.message;
  }
  return "Managed Telegram request failed";
}
