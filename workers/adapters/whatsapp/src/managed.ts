import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  AdapterInstallationContext,
  AdapterPairingActivateInput,
  AdapterPairingCandidate,
  AdapterPairingDisconnectInput,
  AdapterPairingDisconnectResult,
  AdapterPairingFinalizeInput,
  AdapterPairingInfo,
  AdapterPairingPreparation,
  AdapterPairingPrepareInput,
} from "../../../../packages/gsv/src/protocol/adapters.js";
import type {
  AdapterService,
  AdapterServiceDescriptor,
} from "../../../../packages/gsv/src/services/adapters.js";
import { handleAdapterFrame } from "../../shared/src/adapter-frame";
import { cancelBinaryBody } from "../../shared/src/media-body";
import {
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
import type { ManagedWhatsAppPeerEnv } from "./managed-peer";
import {
  managedWhatsAppChatUrl,
  managedWhatsAppConfigured,
  normalizedManagedWhatsAppDisplayNumber,
  validManagedWhatsAppDisplayNumber,
  type ManagedWhatsAppConfigEnv,
} from "./managed-config";
import { handleManagedWhatsAppRequest } from "./managed-http";
import { MANAGED_WHATSAPP_ACCOUNT_ID } from "./managed-peer-state";

export { ManagedWhatsAppPairing } from "./managed-pairing";
export { ManagedWhatsAppPeer } from "./managed-peer";
export { WhatsAppInstallation, WhatsAppLifecycleEntrypoint } from "./lifecycle";

interface Env extends ManagedWhatsAppPeerEnv, ManagedWhatsAppConfigEnv {
  WHATSAPP_ALLOWED_ACTOR_IDS?: string;
}

type ManagedWhatsAppPeerStub = {
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

type ManagedWhatsAppPairingStub = {
  inspect(): Promise<AdapterPairingCandidate>;
  prepare(input: AdapterPairingPrepareInput): Promise<AdapterPairingPreparation>;
  activate(input: AdapterPairingActivateInput): Promise<AdapterPairingPreparation>;
  finalize(input: AdapterPairingFinalizeInput): Promise<AdapterPairingPreparation>;
};

export class ManagedWhatsAppChannel extends WorkerEntrypoint<Env> implements AdapterService {
  readonly adapterId = "whatsapp";

  async adapterDescribe(): Promise<AdapterServiceDescriptor> {
    return {
      version: 1,
      id: this.adapterId,
      displayName: "WhatsApp",
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
    const parsed = parseAdapterInstallationContext(installation);
    if (
      context.accountId !== MANAGED_WHATSAPP_ACCOUNT_ID
      || context.surface.kind !== "dm"
      || !context.actorId
    ) {
      await cancelBinaryBody(frame.body, "Managed WhatsApp frame destination is invalid");
      throw new Error("Managed WhatsApp frame destination is invalid");
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
    parseAdapterInstallationContext(installation);
    if (accountId && accountId !== MANAGED_WHATSAPP_ACCOUNT_ID) return [];
    const configured = this.isConfigured();
    return [{
      accountId: MANAGED_WHATSAPP_ACCOUNT_ID,
      connected: configured,
      authenticated: false,
      mode: "managed-shared",
      error: configured ? undefined : "Managed WhatsApp is not configured",
      extra: validManagedWhatsAppDisplayNumber(this.env.WHATSAPP_DISPLAY_NUMBER)
        ? { selfE164: normalizedManagedWhatsAppDisplayNumber(this.env.WHATSAPP_DISPLAY_NUMBER) }
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
      const parsed = parseAdapterInstallationContext(installation);
      if (accountId !== MANAGED_WHATSAPP_ACCOUNT_ID) {
        throw new Error("Managed WhatsApp account ID is invalid");
      }
      if (surface.kind !== "dm") throw new Error("Managed WhatsApp supports direct messages only");
      if (activity.kind !== "typing" || !activity.active) return { ok: true };
      const routeGeneration = activity.routeGeneration?.trim();
      if (!routeGeneration) {
        throw new Error("Managed WhatsApp route generation is required");
      }
      const result = await this.peer(surface.id).setTyping(
        parsed.installationId,
        surface,
        surface.id,
        routeGeneration,
        true,
      );
      if (!result.accepted) {
        throw new Error("WhatsApp route changed before activity delivery");
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: safeError(error instanceof Error ? error : String(error)) };
    }
  }

  /** The chat link opens WhatsApp on the platform number with the relink command prefilled. */
  async adapterPairingInfo(
    installation: AdapterInstallationContext,
  ): Promise<AdapterPairingInfo> {
    parseAdapterInstallationContext(installation);
    return {
      accountId: MANAGED_WHATSAPP_ACCOUNT_ID,
      configured: this.isConfigured(),
      installUrl: managedWhatsAppChatUrl(this.env.WHATSAPP_DISPLAY_NUMBER),
    };
  }

  async adapterPairingInspect(
    installation: AdapterInstallationContext,
    code: string,
  ): Promise<AdapterPairingCandidate> {
    parseAdapterInstallationContext(installation);
    return await this.pairing(code).inspect();
  }

  async adapterPairingPrepare(
    installation: AdapterInstallationContext,
    input: AdapterPairingPrepareInput,
  ): Promise<AdapterPairingPreparation> {
    const parsed = parseAdapterInstallationContext(installation);
    if (input.installationId !== parsed.installationId) {
      throw new Error("Pairing installation does not match the caller");
    }
    return await this.pairing(input.code).prepare(input);
  }

  async adapterPairingActivate(
    installation: AdapterInstallationContext,
    input: AdapterPairingActivateInput,
  ): Promise<AdapterPairingPreparation> {
    const parsed = parseAdapterInstallationContext(installation);
    if (input.route.installationId !== parsed.installationId) {
      throw new Error("Pairing installation does not match the caller");
    }
    return await this.pairing(input.code).activate(input);
  }

  async adapterPairingFinalize(
    installation: AdapterInstallationContext,
    input: AdapterPairingFinalizeInput,
  ): Promise<AdapterPairingPreparation> {
    const parsed = parseAdapterInstallationContext(installation);
    if (input.route.installationId !== parsed.installationId) {
      throw new Error("Pairing installation does not match the caller");
    }
    return await this.pairing(input.code).finalize(input);
  }

  async adapterPairingDisconnect(
    installation: AdapterInstallationContext,
    input: AdapterPairingDisconnectInput,
  ): Promise<AdapterPairingDisconnectResult> {
    const parsed = parseAdapterInstallationContext(installation);
    if (input.installationId !== parsed.installationId) {
      throw new Error("Pairing installation does not match the caller");
    }
    if (input.accountId !== MANAGED_WHATSAPP_ACCOUNT_ID) {
      throw new Error("Managed WhatsApp account ID is invalid");
    }
    return await this.peer(input.surfaceId).disconnect(input);
  }

  private peer(surfaceId: string): ManagedWhatsAppPeerStub {
    if (!/^[1-9][0-9]{4,14}$/.test(surfaceId)) {
      throw new Error("Managed WhatsApp surface ID is invalid");
    }
    const id = this.env.MANAGED_WHATSAPP_PEER.idFromName(`managed:${surfaceId}`);
    return typedStub(this.env.MANAGED_WHATSAPP_PEER.get(id));
  }

  private pairing(code: string): ManagedWhatsAppPairingStub {
    const normalized = normalizePairingCode(code);
    const id = this.env.MANAGED_WHATSAPP_PAIRING.idFromName(`pair:${normalized}`);
    return typedStub(this.env.MANAGED_WHATSAPP_PAIRING.get(id));
  }

  private isConfigured(): boolean {
    return managedWhatsAppConfigured(this.env);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return await handleManagedWhatsAppRequest(request, env);
  },
} satisfies ExportedHandler<Env>;

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
  if (error instanceof Error && /not linked|invalid|direct messages|media|window/.test(error.message)) {
    return error.message;
  }
  return "Managed WhatsApp request failed";
}
