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
} from "../../../packages/gsv/src/protocol/adapters.js";
import { cancelBinaryBody } from "../../shared/src/media-body";
import {
  LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
  parseAdapterInstallationContext,
} from "../../shared/src/installation";
import type {
  AdapterAccountStatus,
  AdapterActivity,
  AdapterOutboundMessage,
  AdapterSendResult,
  AdapterSurface,
  BinaryBody,
} from "./types";
import type { ManagedTelegramPairingEnv } from "./managed-pairing";
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
  ): Promise<AdapterSendResult>;
  setTyping(
    installationId: string,
    surface: AdapterSurface,
    actorId: string,
    active: boolean,
  ): Promise<void>;
  disconnect(input: AdapterPairingDisconnectInput): Promise<AdapterPairingDisconnectResult>;
};

type ManagedTelegramPairingStub = {
  inspect(): Promise<AdapterPairingCandidate>;
  prepare(input: AdapterPairingPrepareInput): Promise<AdapterPairingPreparation>;
  activate(input: AdapterPairingActivateInput): Promise<AdapterPairingPreparation>;
  finalize(input: AdapterPairingFinalizeInput): Promise<AdapterPairingPreparation>;
};

export class ManagedTelegramChannel extends WorkerEntrypoint<Env> {
  readonly adapterId = "telegram";

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
      ...(!configured ? { error: "Managed Telegram is not configured" } : {}),
      ...(validManagedTelegramBotUsername(this.env.TELEGRAM_BOT_USERNAME)
        ? { extra: { botUsername: normalizedManagedTelegramBotUsername(this.env.TELEGRAM_BOT_USERNAME) } }
        : {}),
    }];
  }

  async adapterSend(
    installation: AdapterInstallationContext,
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<AdapterSendResult> {
    try {
      const parsed = parseManagedInstallation(installation);
      if (accountId !== MANAGED_TELEGRAM_ACCOUNT_ID) {
        throw new Error("Managed Telegram account ID is invalid");
      }
      if (message.surface.kind !== "dm" || !message.actorId) {
        throw new Error("Managed Telegram supports direct messages only");
      }
      return await this.peer(message.surface.id).sendMessage(
        parsed.installationId,
        message,
        body,
      );
    } catch (error) {
      await cancelBinaryBody(body, error);
      return { ok: false, error: safeError(error) };
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
      if (surface.kind !== "dm") throw new Error("Managed Telegram supports direct messages only");
      if (activity.kind !== "typing" || !activity.active) return { ok: true };
      await this.peer(surface.id).setTyping(
        parsed.installationId,
        surface,
        surface.id,
        true,
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: safeError(error) };
    }
  }

  async adapterPairingInfo(
    installation: AdapterInstallationContext,
  ): Promise<AdapterPairingInfo> {
    parseManagedInstallation(installation);
    return {
      accountId: MANAGED_TELEGRAM_ACCOUNT_ID,
      configured: this.isConfigured(),
      ...(validManagedTelegramBotUsername(this.env.TELEGRAM_BOT_USERNAME)
        ? { botUsername: normalizedManagedTelegramBotUsername(this.env.TELEGRAM_BOT_USERNAME) }
        : {}),
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
    return await this.peer(input.surfaceId).disconnect(input);
  }

  private peer(surfaceId: string): ManagedTelegramPeerStub {
    if (!/^[1-9][0-9]{0,19}$/.test(surfaceId)) {
      throw new Error("Managed Telegram surface ID is invalid");
    }
    const id = this.env.MANAGED_TELEGRAM_PEER.idFromName(`managed:${surfaceId}`);
    return this.env.MANAGED_TELEGRAM_PEER.get(id) as unknown as ManagedTelegramPeerStub;
  }

  private pairing(code: string): ManagedTelegramPairingStub {
    const normalized = normalizePairingCode(code);
    const id = this.env.MANAGED_TELEGRAM_PAIRING.idFromName(`pair:${normalized}`);
    return this.env.MANAGED_TELEGRAM_PAIRING.get(id) as unknown as ManagedTelegramPairingStub;
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

function parseManagedInstallation(value: unknown): AdapterInstallationContext {
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

function safeError(error: unknown): string {
  if (error instanceof Error && /not linked|invalid|direct messages|media/.test(error.message)) {
    return error.message;
  }
  return "Managed Telegram request failed";
}
