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
  AdapterTargetCancelResult,
  AdapterTargetDescriptor,
  AdapterTargetIdentity,
  AdapterTargetRequestFrame,
  AdapterTargetResponseFrame,
} from "../../../packages/gsv/src/services/adapters.js";
import { adapterTargetIdentitySchema } from "../../../packages/gsv/src/services/adapters.js";
import { handleAdapterFrame } from "../../shared/src/adapter-frame";
import { cancelBinaryBody } from "../../shared/src/media-body";
import {
  LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
  parseAdapterInstallationContext,
} from "../../shared/src/installation";
import type {
  AdapterAccountStatus,
  AdapterOutboundMessage,
  AdapterPeerDeliveryContext,
  AdapterSendResult,
  BinaryBody,
  GatewayFrame,
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
import { z } from "zod";

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
  acceptPeerSignal(
    installation: AdapterInstallationContext,
    context: AdapterPeerDeliveryContext,
    frame: Extract<GatewayFrame, { type: "sig" }>,
    body?: BinaryBody,
  ): Promise<void>;
  disconnect(input: AdapterPairingDisconnectInput): Promise<AdapterPairingDisconnectResult>;
  listTargets(
    installationId: string,
    routeGeneration: string,
  ): Promise<AdapterTargetDescriptor[]>;
  executeTarget(
    installationId: string,
    routeGeneration: string,
    targetId: string,
    frame: AdapterTargetRequestFrame<"shell.exec">,
  ): Promise<AdapterTargetResponseFrame<"shell.exec">>;
  cancelTarget(
    installationId: string,
    routeGeneration: string,
    targetId: string,
    requestId: string,
  ): Promise<AdapterTargetCancelResult>;
};

type ManagedSlackPeerClient = Omit<
  ManagedSlackPeerStub,
  "listTargets" | "executeTarget" | "cancelTarget"
> & {
  listTargets(
    installationId: string,
    routeGeneration: string,
  ): Promise<AdapterTargetDescriptor[] & Disposable>;
  executeTarget(
    installationId: string,
    routeGeneration: string,
    targetId: string,
    frame: AdapterTargetRequestFrame<"shell.exec">,
  ): Promise<AdapterTargetResponseFrame<"shell.exec"> & Disposable>;
  cancelTarget(
    installationId: string,
    routeGeneration: string,
    targetId: string,
    requestId: string,
  ): Promise<AdapterTargetCancelResult & Disposable>;
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
const SLACK_TARGET_ID = "workspace";
type ParsedTargetIdentity = {
  accountId: string;
  actorId: string;
  routeGeneration: string;
};
const shellExecArgsSchema = z.object({
  input: z.string().min(1).max(1024 * 1024),
  cwd: z.string().max(4_096).optional(),
  sessionId: z.string().min(1).max(512).optional(),
  timeout: z.number().finite().int().positive().max(120_000).optional(),
  background: z.boolean().optional(),
  yieldMs: z.number().finite().int().nonnegative().max(120_000).optional(),
}).strict();
export const managedSlackTargetRequestSchema = z.object({
  type: z.literal("req"),
  id: z.string().min(1).max(512),
  call: z.literal("shell.exec"),
  args: shellExecArgsSchema,
  runId: z.string().min(1).max(512).optional(),
  deadlineAt: z.number().finite(),
}).strict();

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
        deliveryFrames: true,
        targets: true,
        surfaces: ["dm", "channel", "thread"],
        media: {
          inbound: ["image", "audio", "video", "document"],
          outbound: ["image", "audio", "video", "document"],
        },
      },
    };
  }

  async adapterFrame(
    installation: AdapterInstallationContext,
    context: AdapterPeerDeliveryContext,
    frame: GatewayFrame,
    body?: BinaryBody,
  ): Promise<GatewayFrame | null> {
    const parsed = parseManagedInstallation(installation);
    const accountId = requireWorkspaceAccountId(context.accountId);
    const actorId = requireSlackId(context.actorId, "Slack actor");
    const peer = this.peer(accountId, actorId);
    return await handleAdapterFrame(this.adapterId, parsed, context, frame, body, {
      send: async (message, requestBody) => await peer.sendMessage(
        parsed.installationId,
        message,
        requestBody,
      ),
      acceptSignal: async (signalContext, signalFrame, signalBody) => {
        await peer.acceptPeerSignal(parsed, signalContext, signalFrame, signalBody);
      },
    });
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

  async adapterTargetList(
    installation: AdapterInstallationContext,
    identity: AdapterTargetIdentity,
  ): Promise<AdapterTargetDescriptor[]> {
    const parsedInstallation = parseManagedInstallation(installation);
    const parsedIdentity = parseTargetIdentity(identity);
    using targets = await this.peer(parsedIdentity.accountId, parsedIdentity.actorId).listTargets(
      parsedInstallation.installationId,
      parsedIdentity.routeGeneration,
    );
    return targets.map((target) => ({ ...target, implements: [...target.implements] }));
  }

  async adapterTargetExecute(
    installation: AdapterInstallationContext,
    identity: AdapterTargetIdentity,
    targetId: string,
    frame: AdapterTargetRequestFrame,
  ): Promise<AdapterTargetResponseFrame> {
    const parsed = managedSlackTargetRequestSchema.safeParse(frame);
    if (!parsed.success || targetId !== SLACK_TARGET_ID) {
      await cancelBinaryBody(frame.body, "Slack target request is invalid");
      return targetError(frame.id, targetId === SLACK_TARGET_ID ? 400 : 404);
    }
    let parsedInstallation: ReturnType<typeof parseManagedInstallation>;
    let parsedIdentity: ParsedTargetIdentity;
    try {
      parsedInstallation = parseManagedInstallation(installation);
      parsedIdentity = parseTargetIdentity(identity);
    } catch {
      return targetError(frame.id, 403);
    }
    // SAFETY: the managed Slack target exposes only shell.exec, whose complete
    // request envelope and arguments were validated above.
    using response = await this.peer(parsedIdentity.accountId, parsedIdentity.actorId).executeTarget(
      parsedInstallation.installationId,
      parsedIdentity.routeGeneration,
      targetId,
      parsed.data as AdapterTargetRequestFrame<"shell.exec">,
    );
    return structuredClone(response);
  }

  async adapterTargetCancel(
    installation: AdapterInstallationContext,
    identity: AdapterTargetIdentity,
    targetId: string,
    requestId: string,
  ): Promise<AdapterTargetCancelResult> {
    if (targetId !== SLACK_TARGET_ID) return { cancelled: false };
    try {
      const parsedInstallation = parseManagedInstallation(installation);
      const parsedIdentity = parseTargetIdentity(identity);
      const normalizedRequestId = requireRequestId(requestId);
      using result = await this.peer(parsedIdentity.accountId, parsedIdentity.actorId).cancelTarget(
        parsedInstallation.installationId,
        parsedIdentity.routeGeneration,
        targetId,
        normalizedRequestId,
      );
      return { cancelled: result.cancelled };
    } catch {
      return { cancelled: false };
    }
  }

  private peer(
    accountId: string,
    actorId: string,
  ): ManagedSlackPeerClient & DurableObjectStub {
    const id = this.env.MANAGED_SLACK_PEER.idFromName(
      managedSlackPeerObjectName(accountId, actorId),
    );
    return typedStub<ManagedSlackPeerClient>(this.env.MANAGED_SLACK_PEER.get(id));
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

function parseTargetIdentity(value: AdapterTargetIdentity): ParsedTargetIdentity {
  const parsed = adapterTargetIdentitySchema.parse(value);
  const routeGeneration = parsed.routeGeneration?.trim() ?? "";
  if (!routeGeneration) throw new Error("Slack target route generation is required");
  return {
    accountId: requireWorkspaceAccountId(parsed.accountId),
    actorId: requireSlackId(parsed.actorId, "Slack actor"),
    routeGeneration,
  };
}

function requireRequestId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || normalized.includes("\0")) {
    throw new Error("Slack target request ID is invalid");
  }
  return normalized;
}

function targetError(id: string, code: number): AdapterTargetResponseFrame<"shell.exec"> {
  return {
    type: "res",
    id,
    ok: false,
    error: {
      code,
      message: code === 404
        ? "Slack target is unavailable"
        : code === 403
          ? "Slack target authorization is unavailable"
          : "Slack target request is invalid",
    },
  };
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
