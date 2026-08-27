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
} from "../../../packages/gsv/src/protocol/adapters.js";
import type {
  AdapterService,
  AdapterServiceDescriptor,
} from "../../../packages/gsv/src/services/adapters.js";
import { cancelBinaryBody } from "../../shared/src/media-body";
import {
  LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
  parseAdapterInstallationContext,
} from "../../shared/src/installation";
import type {
  AdapterAccountStatus,
  AdapterOutboundMessage,
  AdapterSendResult,
  BinaryBody,
} from "./types";
import type { ManagedSlackPeerEnv } from "./managed-peer";
import {
  handleManagedSlackRequest,
  managedSlackConfigured,
  managedSlackInstallUrl,
  type ManagedSlackHttpEnv,
} from "./managed-http";
import {
  managedSlackPeerObjectName,
  managedSlackWorkspaceObjectName,
  requireWorkspaceAccountId,
} from "./managed-identity";
import { requireSlackId } from "./slack-api";

export { ManagedSlackWorkspace } from "./managed-workspace";
export { ManagedSlackPeer } from "./managed-peer";
export { ManagedSlackPairing } from "./managed-pairing";

interface Env extends ManagedSlackPeerEnv, ManagedSlackHttpEnv {
  MANAGED_SLACK_WORKSPACE: DurableObjectNamespace;
  MANAGED_SLACK_PEER: DurableObjectNamespace;
  MANAGED_SLACK_PAIRING: DurableObjectNamespace;
}

type ManagedSlackPeerStub = {
  sendMessage(
    installationId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<AdapterSendResult>;
  disconnect(input: AdapterPairingDisconnectInput): Promise<AdapterPairingDisconnectResult>;
};

type ManagedSlackPairingStub = {
  inspect(): Promise<AdapterPairingCandidate>;
  prepare(input: AdapterPairingPrepareInput): Promise<AdapterPairingPreparation>;
  activate(input: AdapterPairingActivateInput): Promise<AdapterPairingPreparation>;
  finalize(input: AdapterPairingFinalizeInput): Promise<AdapterPairingPreparation>;
};

type ManagedSlackWorkspaceStub = {
  getStatus(): Promise<{
    accountId: string;
    teamId?: string;
    teamName?: string;
    botUserId?: string;
    connected: boolean;
    error?: string;
  }>;
};

const PAIRING_ACCOUNT_ID = "managed";

export class ManagedSlackChannel extends WorkerEntrypoint<Env> implements AdapterService {
  readonly adapterId = "slack";

  async adapterDescribe(): Promise<AdapterServiceDescriptor> {
    return {
      version: 1,
      id: this.adapterId,
      displayName: "Slack",
      capabilities: {
        connect: false,
        disconnect: false,
        send: true,
        status: true,
        activity: false,
        pairing: true,
        surfaces: ["dm", "channel", "thread"],
        media: { inbound: [], outbound: [] },
      },
    };
  }

  async adapterStatus(
    installation: AdapterInstallationContext,
    accountId?: string,
  ): Promise<AdapterAccountStatus[]> {
    parseManagedInstallation(installation);
    if (!accountId || accountId === PAIRING_ACCOUNT_ID) return [];
    let normalized: string;
    try {
      normalized = requireWorkspaceAccountId(accountId);
    } catch {
      return [];
    }
    const status = await this.workspace(normalized).getStatus();
    const extra: NonNullable<AdapterAccountStatus["extra"]> = {};
    if (status.teamId) extra.teamId = status.teamId;
    if (status.teamName) extra.teamName = status.teamName;
    if (status.botUserId) extra.botUserId = status.botUserId;
    return [{
      accountId: normalized,
      connected: status.connected,
      authenticated: false,
      mode: "managed-shared",
      error: status.error,
      extra,
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
      const normalizedAccountId = requireWorkspaceAccountId(accountId);
      const actorId = requireSlackId(message.actorId, "Slack actor");
      return await this.peer(normalizedAccountId, actorId).sendMessage(
        parsed.installationId,
        message,
        body,
      );
    } catch (error) {
      await cancelBinaryBody(body, error);
      return { ok: false, error: safeError(error) };
    }
  }

  async adapterPairingInfo(
    installation: AdapterInstallationContext,
  ): Promise<AdapterPairingInfo> {
    parseManagedInstallation(installation);
    return {
      accountId: PAIRING_ACCOUNT_ID,
      configured: managedSlackConfigured(this.env),
      installUrl: managedSlackInstallUrl(this.env),
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
    const accountId = requireWorkspaceAccountId(input.accountId);
    const actorId = requireSlackId(input.actorId, "Slack actor");
    return await this.peer(accountId, actorId).disconnect(input);
  }

  private peer(accountId: string, actorId: string): ManagedSlackPeerStub {
    const id = this.env.MANAGED_SLACK_PEER.idFromName(
      managedSlackPeerObjectName(accountId, actorId),
    );
    return typedStub<ManagedSlackPeerStub>(this.env.MANAGED_SLACK_PEER.get(id));
  }

  private workspace(accountId: string): ManagedSlackWorkspaceStub {
    const id = this.env.MANAGED_SLACK_WORKSPACE.idFromName(
      managedSlackWorkspaceObjectName(accountId),
    );
    return typedStub<ManagedSlackWorkspaceStub>(this.env.MANAGED_SLACK_WORKSPACE.get(id));
  }

  private pairing(code: string): ManagedSlackPairingStub {
    const normalized = normalizePairingCode(code);
    const id = this.env.MANAGED_SLACK_PAIRING.idFromName(`pair:${normalized}`);
    return typedStub<ManagedSlackPairingStub>(this.env.MANAGED_SLACK_PAIRING.get(id));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return await handleManagedSlackRequest(request, env);
  },
} satisfies ExportedHandler<Env>;

function parseManagedInstallation(value: AdapterInstallationContext): AdapterInstallationContext {
  const installation = parseAdapterInstallationContext(value);
  if (installation.installationId === LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID) {
    throw new Error("Managed Slack cannot address singleton");
  }
  return installation;
}

function normalizePairingCode(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (!/^[A-HJ-NP-Z2-9]{12}$/.test(normalized)) throw new Error("Pairing code is invalid");
  return normalized;
}

function typedStub<T>(value: DurableObjectStub): T & DurableObjectStub {
  // SAFETY: these namespaces are owned by this worker and expose the declared RPC contracts.
  return value as T & DurableObjectStub;
}

function safeError<T>(error: T): string {
  const message = error instanceof Error ? error.message : String(error);
  return /Slack|route|destination|media/.test(message)
    ? message
    : "Managed Slack request failed";
}
