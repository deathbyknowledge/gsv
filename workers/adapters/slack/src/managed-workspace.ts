import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { installationDeletionRequestSchema, type InstallationDeletionReceipt, type InstallationDeletionRequest } from "../../../../packages/gsv/src/services/lifecycle.js";
import { ADAPTER_RETIREMENT_PREFIX, AdapterRetirement, sameAdapterDataOwner, type AdapterDataOwner } from "../../shared/src/retirement";
import type { AdapterResourceInspection } from "../../shared/src/peer-retirement";
import type { AdapterInstallationRegistration } from "../../shared/src/installation-retirement";
import type {
  AdapterTargetRequestFrame,
  AdapterTargetResponseFrame,
} from "../../../../packages/gsv/src/services/adapters.js";
import type { DeliveryFailureKind } from "../../shared/src/delivery-ledger";
import { callAdapterGateway, type AdapterGatewayBinding } from "../../shared/src/gateway-rpc";
import {
  downloadSlackFile,
  openSlackDm,
  postSlackMessage,
  requireSlackId,
  requireSlackToken,
  slackFileDeliveryErrorMessage,
  SlackApiError,
  updateSlackMessage,
  workspaceAccountId,
  type SlackFetch,
  type SlackDownloadedFile,
  type SlackOAuthInstallation,
  type SlackPostMessageInput,
  type SlackUpdateMessageInput,
  type SlackUploadFilesInput,
  uploadSlackFiles,
} from "./slack-api";
import { executeSlackTarget, managedSlackTargetRequestSchema, type SlackTargetCall } from "./slack-target";
import { cancelBinaryBody } from "../../shared/src/media-body";
import {
  managedSlackWorkspaceObjectName,
  requireWorkspaceAccountId,
} from "./managed-identity";

export type ManagedSlackWorkspaceState = {
  version: 1;
  accountId: string;
  teamId: string;
  teamName?: string;
  botUserId: string;
  botToken: string;
  appId?: string;
  scope?: string;
  generation: string;
  active: boolean;
  installedAt: number;
  deactivatedAt?: number;
};

type ManagedSlackUserCredentialState = {
  version: 1;
  actorId: string;
  token: string;
  scope: string;
  generation: string;
  authorizedAt: number;
  owner?: AdapterDataOwner | null;
};

type ManagedSlackDmCache = { generation: string; channelId: string; owner?: AdapterDataOwner | null };

type ActiveSlackTargetCall = {
  actorId: string;
  workspaceGeneration: string;
  credentialGeneration: string;
  controller: AbortController;
  owner: AdapterDataOwner;
};

type ManagedSlackPeerRouteRecord = {
  version: 1;
  actorId: string;
  installationId: string;
  routeGeneration: string;
};

type ManagedSlackWorkspaceStatusExtra = {
  teamId: string;
  botUserId: string;
  teamName?: string;
};

export type ManagedSlackWorkspaceAdmission =
  | {
      accepted: true;
      accountId: string;
      teamId: string;
      teamName?: string;
      botUserId: string;
      generation: string;
    }
  | { accepted: false };

export type ManagedSlackWorkspacePostResult =
  | { ok: true; channel: string; ts: string }
  | { ok: false; kind: DeliveryFailureKind; error: string };

export type ManagedSlackWorkspaceDownloadResult =
  | { ok: true; file: SlackDownloadedFile }
  | { ok: false; kind: DeliveryFailureKind; error: string };

export type ManagedSlackWorkspaceUploadResult =
  | { ok: true; fileIds: string[] }
  | { ok: false; kind: DeliveryFailureKind; error: string };

export type ManagedSlackWorkspaceStatus = {
  accountId: string;
  teamId?: string;
  teamName?: string;
  botUserId?: string;
  connected: boolean;
  generation?: string;
  error?: string;
};

export type ManagedSlackTargetAuthorization =
  | {
      available: true;
      teamId: string;
      teamName?: string;
      actorId: string;
      credentialGeneration: string;
    }
  | { available: false };

interface Env {
  GATEWAY: Fetcher & AdapterGatewayBinding;
  SLACK_API?: Fetcher;
  MANAGED_SLACK_WORKSPACE: Pick<DurableObjectNamespace, "idFromName">;
  SLACK_INSTALLATIONS: { getByName(installationId: string): { registerResource(resource: AdapterInstallationRegistration): Promise<void> } };
}

const STATE_KEY = "managed_slack_workspace:v1:state";
const USER_CREDENTIAL_PREFIX = "managed_slack_workspace:v1:user:";
const PEER_ROUTE_PREFIX = "managed_slack_workspace:v1:route:";
const DM_CACHE_PREFIX = "managed_slack_workspace:v1:dm:";
const BACKUP_LIFETIME_MS = 30 * 24 * 60 * 60_000 + 60_000;
const storedOwnerSchema = z.strictObject({ installationId: z.string().min(1), generation: z.string().min(1) }).nullable().optional();
const storedRouteSchema = z.strictObject({ version: z.literal(1), actorId: z.string().min(1), installationId: z.string().min(1), routeGeneration: z.string().min(1) });
const storedCredentialSchema = z.strictObject({ version: z.literal(1), actorId: z.string().min(1), token: z.string(), scope: z.string(), generation: z.string().min(1), authorizedAt: z.number(), owner: storedOwnerSchema });
const storedDmCacheSchema = z.strictObject({ generation: z.string().min(1), channelId: z.string().min(1), owner: storedOwnerSchema });
const MAX_TARGET_RUNTIME_MS = 120_000;
const REQUIRED_SCOPES = new Set([
  "app_mentions:read",
  "chat:write",
  "files:read",
  "files:write",
  "im:history",
  "im:write",
]);
const TARGET_BOT_SCOPES = new Set([
  "chat:write",
  "chat:write.public",
  "reactions:write",
]);
const TARGET_USER_SCOPES = new Set([
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read",
  "users:read",
]);

export class ManagedSlackWorkspace extends DurableObject<Env> {
  private readonly targetCalls = new Map<string, ActiveSlackTargetCall>();
  private readonly retirement = new AdapterRetirement(this.ctx.storage);

  async inspectInstallationResource(installationId: string): Promise<AdapterResourceInspection> {
    const ownership = this.ownership(installationId);
    const state = this.ctx.storage.kv.get<ManagedSlackWorkspaceState>(STATE_KEY);
    if (ownership.unattributed) return { outcome: "unidentified" };
    if (!state) return { outcome: ownership.keys.length ? "unidentified" : "empty" };
    const name = managedSlackWorkspaceObjectName(state.accountId);
    if (this.env.MANAGED_SLACK_WORKSPACE.idFromName(name).toString() !== this.ctx.id.toString()) return { outcome: "unidentified" };
    return ownership.keys.length ? { name, outcome: "identified", installationId } : { name, outcome: "unrelated" };
  }

  async quiesceInstallation(value: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    const input = installationDeletionRequestSchema.parse(value);
    this.retirement.quiesce(input);
    for (const active of this.targetCalls.values()) if (active.owner.installationId === input.installationId) active.controller.abort(new Error("Slack installation is retired"));
    return this.installationDeletionStatus(input);
  }

  async eraseInstallation(value: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    const input = installationDeletionRequestSchema.parse(value);
    const quiesced = await this.quiesceInstallation(input);
    if (quiesced.phase === "quiescing" || quiesced.outcome === "missing-inventory") return quiesced;
    const ownership = this.ownership(input.installationId);
    this.ctx.storage.transactionSync(() => {
      // Attribute legacy user records before removing the route that proves their owner.
      for (const key of ownership.keys.slice(0, 32)) if (key.startsWith(PEER_ROUTE_PREFIX)) {
        const route = this.ctx.storage.kv.get<ManagedSlackPeerRouteRecord>(key)!;
        this.attributeActorRecords(route);
      }
      for (const key of ownership.keys.slice(0, 32)) this.ctx.storage.kv.delete(key);
    });
    if (this.ownership(input.installationId).keys.length) return { ...await this.installationDeletionStatus(input), phase: "erasing" };
    this.retirement.complete(input);
    return this.installationDeletionStatus(input);
  }

  async installationDeletionStatus(value: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    const input = installationDeletionRequestSchema.parse(value);
    const state = this.retirement.status(input);
    const ownership = this.ownership(input.installationId);
    const inspected = await this.inspectInstallationResource(input.installationId);
    const base: InstallationDeletionReceipt = { ...input, phase: !state.startedAt ? "pending" : state.active ? "quiescing" : "quiesced",
      updatedAt: state.startedAt ?? Date.now(), pendingResources: state.active + ownership.keys.length,
      outcome: inspected.outcome === "unidentified" ? "missing-inventory" : "progress", retainedCopies: [] };
    if (!state.erasedAt || base.pendingResources || base.outcome === "missing-inventory") return base;
    const expiresAt = state.erasedAt + BACKUP_LIFETIME_MS;
    return Date.now() < expiresAt ? { ...base, phase: "live-erased", outcome: "retention-pending", retainedCopies: [{ id: "cloudflare-durable-object-pitr", kind: "backup", expiresAt }] }
      : { ...base, phase: "erased", outcome: "complete" };
  }

  async install(
    accountId: string,
    installation: SlackOAuthInstallation,
  ): Promise<ManagedSlackWorkspaceAdmission> {
    const normalizedAccountId = requireWorkspaceAccountId(accountId);
    this.assertObjectName(normalizedAccountId);
    const teamId = requireSlackId(installation.teamId, "Slack workspace");
    if (await workspaceAccountId(teamId) !== normalizedAccountId) {
      throw new Error("Slack workspace account identity mismatch");
    }
    const scopes = normalizedScopes(installation.scope);
    const missing = missingRequiredScopes(scopes);
    if (missing.length > 0) throw new Error("Slack installation is missing required scopes");

    const previous = await this.ctx.storage.get<ManagedSlackWorkspaceState>(STATE_KEY);
    const botToken = requireSlackToken(installation.botToken, "Slack bot token", "xoxb-");
    const botUserId = requireSlackId(installation.botUserId, "Slack bot user");
    const appId = installation.appId
      ? requireSlackId(installation.appId, "Slack app")
      : undefined;
    const scope = [...scopes].sort().join(",");
    const generation = previous && sameActiveWorkspaceInstallation(previous, {
      teamId,
      botUserId,
      botToken,
      appId,
      scope,
    })
      ? previous.generation
      : crypto.randomUUID();
    const state: ManagedSlackWorkspaceState = {
      version: 1,
      accountId: normalizedAccountId,
      teamId,
      teamName: normalizedOptionalText(installation.teamName, 160),
      botUserId,
      botToken,
      appId,
      scope,
      generation,
      active: true,
      installedAt: previous?.installedAt ?? Date.now(),
    };
    const user = installation.user;
    let credential: ManagedSlackUserCredentialState | undefined;
    if (user) {
      const actorId = requireSlackId(user.id, "Slack authorizing user");
      const userScopes = normalizedScopes(user.scope);
      const missingUserScopes = missingScopes(userScopes, TARGET_USER_SCOPES);
      if (missingUserScopes.length > 0) {
        throw new Error("Slack user authorization is missing required target scopes");
      }
      credential = {
        version: 1,
        actorId,
        token: requireSlackToken(user.token, "Slack user token", "xoxp-"),
        scope: [...userScopes].sort().join(","),
        generation: crypto.randomUUID(),
        authorizedAt: Date.now(),
        owner: null,
      };
    }
    const route = credential ? this.ctx.storage.kv.get<ManagedSlackPeerRouteRecord>(peerRouteKey(credential.actorId)) : undefined;
    if (route) await this.registerOwnership(routeOwner(route), state.accountId);
    this.ctx.storage.transactionSync(() => {
      if (JSON.stringify(this.ctx.storage.kv.get(STATE_KEY)) !== JSON.stringify(previous)) throw new Error("Slack workspace changed during authorization");
      this.ctx.storage.kv.put(STATE_KEY, state);
      if (credential) {
        const current = this.ctx.storage.kv.get<ManagedSlackPeerRouteRecord>(peerRouteKey(credential.actorId));
        if (!sameAdapterDataOwner(current ? routeOwner(current) : null, route ? routeOwner(route) : null)) throw new Error("Slack route changed during authorization");
        credential.owner = current ? routeOwner(current) : null;
        this.retirement.requireLive(credential.owner);
        this.ctx.storage.kv.put(userCredentialKey(credential.actorId), credential);
      }
    });
    this.abortSupersededTargetCalls(state.generation, credential);
    await this.publishStatus(state);
    return admission(state);
  }

  async admitEvent(teamIdInput: string): Promise<ManagedSlackWorkspaceAdmission> {
    const state = await this.ctx.storage.get<ManagedSlackWorkspaceState>(STATE_KEY);
    if (
      !state
      || !state.active
      || missingRequiredScopes(normalizedScopes(state.scope)).length > 0
    ) {
      return { accepted: false };
    }
    const teamId = requireSlackId(teamIdInput, "Slack workspace");
    if (state.teamId !== teamId) return { accepted: false };
    this.assertObjectName(state.accountId);
    return admission(state);
  }

  async deactivate(teamIdInput: string): Promise<{ deactivated: boolean }> {
    const current = await this.ctx.storage.get<ManagedSlackWorkspaceState>(STATE_KEY);
    if (!current) return { deactivated: false };
    const teamId = requireSlackId(teamIdInput, "Slack workspace");
    if (current.teamId !== teamId) throw new Error("Slack workspace identity mismatch");
    this.assertObjectName(current.accountId);
    const state = current.active
      ? {
        ...current,
        active: false,
        botToken: "",
        generation: crypto.randomUUID(),
        deactivatedAt: Date.now(),
      } satisfies ManagedSlackWorkspaceState
      : current;
    if (state !== current) await this.ctx.storage.put(STATE_KEY, state);
    const credentials = await this.ctx.storage.list({ prefix: USER_CREDENTIAL_PREFIX });
    if (credentials.size > 0) {
      await this.ctx.storage.delete([...credentials.keys()]);
    }
    for (const active of this.targetCalls.values()) {
      active.controller.abort(new Error("Slack workspace authorization changed"));
    }
    await this.publishStatus(state);
    return { deactivated: true };
  }

  async registerPeerRoute(
    actorIdInput: string,
    installationIdInput: string,
    routeGenerationInput: string,
  ): Promise<void> {
    const actorId = requireSlackId(actorIdInput, "Slack actor");
    const route: ManagedSlackPeerRouteRecord = {
      version: 1,
      actorId,
      installationId: requireRoutePart(installationIdInput, "installationId"),
      routeGeneration: requireRoutePart(routeGenerationInput, "routeGeneration"),
    };
    const state = this.ctx.storage.kv.get<ManagedSlackWorkspaceState>(STATE_KEY);
    if (!state) throw new Error("Slack workspace is not installed");
    const previousRoute = this.ctx.storage.kv.get<ManagedSlackPeerRouteRecord>(peerRouteKey(actorId));
    await this.registerOwnership(routeOwner(route), state.accountId);
    this.ctx.storage.transactionSync(() => {
      this.retirement.requireLive(routeOwner(route));
      const currentRoute = this.ctx.storage.kv.get<ManagedSlackPeerRouteRecord>(peerRouteKey(actorId));
      if (JSON.stringify(currentRoute) !== JSON.stringify(previousRoute) && JSON.stringify(currentRoute) !== JSON.stringify(route)) throw new Error("Slack route changed during registration");
      this.ctx.storage.kv.put(peerRouteKey(actorId), route);
      this.attributeActorRecords(route, true);
    });
    if (state) await this.publishStatusToRoute(state, route);
  }

  async unregisterPeerRoute(
    actorIdInput: string,
    installationIdInput: string,
    routeGenerationInput: string,
  ): Promise<void> {
    const actorId = requireSlackId(actorIdInput, "Slack actor");
    const installationId = requireRoutePart(installationIdInput, "installationId");
    const routeGeneration = requireRoutePart(routeGenerationInput, "routeGeneration");
    const key = peerRouteKey(actorId);
    const route = this.ctx.storage.kv.get<ManagedSlackPeerRouteRecord>(key);
    if (
      route?.version === 1
      && route.actorId === actorId
      && route.installationId === installationId
      && route.routeGeneration === routeGeneration
    ) {
      this.ctx.storage.transactionSync(() => {
        this.attributeActorRecords(route);
        this.ctx.storage.kv.delete(key);
      });
    }
  }

  async getTargetAuthorization(
    actorIdInput: string,
    expectedGeneration: string,
  ): Promise<ManagedSlackTargetAuthorization> {
    const actorId = requireSlackId(actorIdInput, "Slack actor");
    let authorization: {
      workspace: ManagedSlackWorkspaceState;
      credential: ManagedSlackUserCredentialState;
      owner: AdapterDataOwner;
    };
    try {
      authorization = await this.requireTargetAuthorization(actorId, expectedGeneration);
    } catch (error) {
      if (error instanceof SlackTargetAuthorizationUnavailableError) return { available: false };
      throw error;
    }
    return {
      available: true,
      teamId: authorization.workspace.teamId,
      teamName: authorization.workspace.teamName,
      actorId,
      credentialGeneration: authorization.credential.generation,
    };
  }

  async executeTarget(
    actorIdInput: string,
    expectedGeneration: string,
    frame: AdapterTargetRequestFrame<SlackTargetCall>,
  ): Promise<AdapterTargetResponseFrame<SlackTargetCall>> {
    const actorId = requireSlackId(actorIdInput, "Slack actor");
    if (!managedSlackTargetRequestSchema.safeParse(frame).success) {
      await cancelBinaryBody(frame.body, "Slack target request is invalid");
      return targetError(frame.id, 400, "Slack target request is invalid");
    }
    const remaining = Math.min(
      MAX_TARGET_RUNTIME_MS,
      Math.trunc(frame.deadlineAt - Date.now()),
    );
    if (remaining <= 0) return targetError(frame.id, 408, "Slack target request expired");

    let authorization: {
      workspace: ManagedSlackWorkspaceState;
      credential: ManagedSlackUserCredentialState;
      owner: AdapterDataOwner;
    };
    try {
      authorization = await this.requireTargetAuthorization(actorId, expectedGeneration);
    } catch {
      await cancelBinaryBody(frame.body, "Slack target authorization is unavailable");
      return targetError(frame.id, 403, "Slack target authorization is unavailable");
    }
    const { workspace, credential, owner } = authorization;
    using operation = this.operation(owner);
    const callKey = targetCallKey(actorId, frame.id);
    if (this.targetCalls.has(callKey)) {
      return targetError(frame.id, 409, "Slack target request is already running");
    }
    const controller = new AbortController();
    const active: ActiveSlackTargetCall = {
      actorId,
      workspaceGeneration: expectedGeneration,
      credentialGeneration: credential.generation,
      controller,
      owner,
    };
    this.targetCalls.set(callKey, active);
    const timeout = setTimeout(() => {
      controller.abort(new Error("Slack target request timed out"));
    }, remaining);

    try {
      const response = await executeSlackTarget(frame, {
        userToken: credential.token,
        botToken: workspace.botToken,
        actorId,
        botUserId: workspace.botUserId,
        teamId: workspace.teamId,
        teamName: workspace.teamName,
        signal: controller.signal,
        slackFetch: operation.fetch,
        guard: async () => {
          await this.requireTargetAuthorization(
            actorId,
            expectedGeneration,
            credential.generation,
            owner,
          );
        },
      });
      try {
        await this.requireTargetAuthorization(actorId, expectedGeneration, credential.generation, owner);
        if (frame.call !== "shell.exec") controller.signal.throwIfAborted();
        return response;
      } catch (error) {
        if (response.ok) await cancelBinaryBody(response.body, "Slack target authorization changed");
        throw error;
      }
    } catch {
      if (controller.signal.aborted) {
        return targetError(
          frame.id,
          499,
          controller.signal.reason instanceof Error
            ? controller.signal.reason.message
            : "Slack target request cancelled",
        );
      }
      return targetError(frame.id, 409, "Slack target authorization changed during execution");
    } finally {
      clearTimeout(timeout);
      if (this.targetCalls.get(callKey) === active) this.targetCalls.delete(callKey);
    }
  }

  async cancelTarget(
    actorIdInput: string,
    expectedGeneration: string,
    requestId: string,
  ): Promise<{ cancelled: boolean }> {
    const actorId = requireSlackId(actorIdInput, "Slack actor");
    const active = this.targetCalls.get(targetCallKey(actorId, requestId));
    if (
      !active
      || active.actorId !== actorId
      || active.workspaceGeneration !== expectedGeneration
    ) {
      return { cancelled: false };
    }
    active.controller.abort(new Error("Slack target request cancelled"));
    return { cancelled: true };
  }

  async getStatus(): Promise<ManagedSlackWorkspaceStatus> {
    const state = await this.ctx.storage.get<ManagedSlackWorkspaceState>(STATE_KEY);
    if (!state) {
      return {
        accountId: accountIdFromObjectName(this.ctx.id.name),
        connected: false,
        error: "Slack workspace is not installed",
      };
    }
    return workspaceStatus(state);
  }

  async openDm(
    actorIdInput: string,
    expectedGeneration: string,
    owner?: AdapterDataOwner | null,
  ): Promise<{ channelId: string }> {
    const actorId = requireSlackId(actorIdInput, "Slack actor");
    const route = this.ctx.storage.kv.get<ManagedSlackPeerRouteRecord>(peerRouteKey(actorId));
    if (owner === undefined) owner = route ? routeOwner(route) : undefined;
    using operation = this.operation(owner);
    const state = await this.requireActive(expectedGeneration);
    const cacheKey = `${DM_CACHE_PREFIX}${actorId}`;
    const cached = this.ctx.storage.kv.get<ManagedSlackDmCache>(cacheKey);
    this.retirement.requireLive(owner);
    const admittedRoute = this.ctx.storage.kv.get<ManagedSlackPeerRouteRecord>(peerRouteKey(actorId));
    if (owner !== null && !sameAdapterDataOwner(owner ?? null, admittedRoute ? routeOwner(admittedRoute) : null)) throw new Error("Slack direct message route changed");
    if (cached?.generation === state.generation) {
      return { channelId: requireSlackId(cached.channelId, "Slack direct message") };
    }
    const channelId = await openSlackDm(state.botToken, actorId, operation.fetch);
    this.retirement.requireLive(owner);
    const currentRoute = this.ctx.storage.kv.get<ManagedSlackPeerRouteRecord>(peerRouteKey(actorId));
    if (owner !== null && !sameAdapterDataOwner(owner ?? null, currentRoute ? routeOwner(currentRoute) : null)) throw new Error("Slack route changed while opening a direct message");
    this.ctx.storage.kv.put(cacheKey, { generation: state.generation, channelId, owner: owner ?? null } satisfies ManagedSlackDmCache);
    return { channelId };
  }

  async postMessage(
    expectedGeneration: string,
    input: SlackPostMessageInput,
    owner?: AdapterDataOwner | null,
  ): Promise<ManagedSlackWorkspacePostResult> {
    using operation = this.operation(owner);
    let state: ManagedSlackWorkspaceState;
    try {
      state = await this.requireActive(expectedGeneration);
    } catch {
      return { ok: false, kind: "permanent", error: "Slack workspace route changed" };
    }
    try {
      const result = await postSlackMessage(state.botToken, input, operation.fetch);
      this.retirement.requireLive(owner);
      return {
        ok: true,
        ...result,
      };
    } catch (error) {
      return {
        ok: false,
        kind: error instanceof SlackApiError ? error.kind : "permanent",
        error: "Slack delivery failed",
      };
    }
  }

  async updateMessage(
    expectedGeneration: string,
    input: SlackUpdateMessageInput,
    owner?: AdapterDataOwner | null,
  ): Promise<ManagedSlackWorkspacePostResult> {
    using operation = this.operation(owner);
    let state: ManagedSlackWorkspaceState;
    try {
      state = await this.requireActive(expectedGeneration);
    } catch {
      return { ok: false, kind: "permanent", error: "Slack workspace route changed" };
    }
    try {
      const result = await updateSlackMessage(state.botToken, input, operation.fetch);
      this.retirement.requireLive(owner);
      return {
        ok: true,
        ...result,
      };
    } catch (error) {
      return {
        ok: false,
        kind: error instanceof SlackApiError ? error.kind : "permanent",
        error: "Slack message update failed",
      };
    }
  }

  async downloadFile(
    expectedGeneration: string,
    fileId: string,
    maxBytes: number,
    owner?: AdapterDataOwner | null,
  ): Promise<ManagedSlackWorkspaceDownloadResult> {
    using operation = this.operation(owner);
    let state: ManagedSlackWorkspaceState;
    try {
      state = await this.requireActive(expectedGeneration);
    } catch {
      return { ok: false, kind: "permanent", error: "Slack workspace route changed" };
    }
    try {
      const file = await downloadSlackFile(
        state.botToken,
        fileId,
        maxBytes,
        operation.fetch,
        async () => {
          await this.requireActive(expectedGeneration);
          this.retirement.requireLive(owner);
        },
      );
      return { ok: true, file };
    } catch (error) {
      return {
        ok: false,
        kind: error instanceof SlackApiError ? error.kind : "permanent",
        error: "Slack file download failed",
      };
    }
  }

  async uploadFiles(
    expectedGeneration: string,
    input: SlackUploadFilesInput,
    owner?: AdapterDataOwner | null,
  ): Promise<ManagedSlackWorkspaceUploadResult> {
    using operation = this.operation(owner);
    let state: ManagedSlackWorkspaceState;
    try {
      state = await this.requireActive(expectedGeneration);
    } catch {
      logSlackFileUploadFailure(undefined, "authorization");
      return { ok: false, kind: "permanent", error: "Slack workspace route changed" };
    }
    try {
      const result = await uploadSlackFiles(
        state.botToken,
        input,
        operation.fetch,
        async () => {
          await this.requireActive(expectedGeneration);
          this.retirement.requireLive(owner);
        },
      );
      return { ok: true, fileIds: result.fileIds };
    } catch (error) {
      const slackError = error instanceof SlackApiError ? error : undefined;
      logSlackFileUploadFailure(slackError);
      return {
        ok: false,
        kind: slackError?.kind ?? "permanent",
        error: slackFileDeliveryErrorMessage(slackError),
      };
    }
  }

  private async requireActive(expectedGeneration: string): Promise<ManagedSlackWorkspaceState> {
    const state = await this.ctx.storage.get<ManagedSlackWorkspaceState>(STATE_KEY);
    if (
      !state
      || !state.active
      || !expectedGeneration
      || state.generation !== expectedGeneration
      || !state.botToken
      || missingRequiredScopes(normalizedScopes(state.scope)).length > 0
    ) {
      throw new SlackTargetAuthorizationUnavailableError("Slack workspace route changed");
    }
    this.assertObjectName(state.accountId);
    return state;
  }

  private async requireTargetAuthorization(
    actorId: string,
    expectedWorkspaceGeneration: string,
    expectedCredentialGeneration?: string,
    expectedOwner?: AdapterDataOwner,
  ): Promise<{
    workspace: ManagedSlackWorkspaceState;
    credential: ManagedSlackUserCredentialState;
    owner: AdapterDataOwner;
  }> {
    const workspace = await this.requireActive(expectedWorkspaceGeneration);
    const credential = this.ctx.storage.kv.get<ManagedSlackUserCredentialState>(
      userCredentialKey(actorId),
    );
    const route = this.ctx.storage.kv.get<ManagedSlackPeerRouteRecord>(peerRouteKey(actorId));
    const owner = route ? routeOwner(route) : undefined;
    if (
      !credential
      || !owner
      || expectedOwner && !sameAdapterDataOwner(owner, expectedOwner)
      || credential.owner && !sameAdapterDataOwner(owner, credential.owner)
      || credential.version !== 1
      || credential.actorId !== actorId
      || !credential.generation
      || (
        expectedCredentialGeneration !== undefined
        && credential.generation !== expectedCredentialGeneration
      )
      || missingScopes(normalizedScopes(credential.scope), TARGET_USER_SCOPES).length > 0
      || missingScopes(normalizedScopes(workspace.scope), TARGET_BOT_SCOPES).length > 0
    ) {
      throw new SlackTargetAuthorizationUnavailableError("Slack target authorization is unavailable");
    }
    requireSlackToken(credential.token, "Slack user token", "xoxp-");
    if (this.retirement.retired(owner)) throw new SlackTargetAuthorizationUnavailableError("Slack installation is retired");
    return { workspace, credential, owner };
  }

  private abortSupersededTargetCalls(
    workspaceGeneration: string,
    credential?: ManagedSlackUserCredentialState,
  ): void {
    for (const active of this.targetCalls.values()) {
      if (
        active.workspaceGeneration !== workspaceGeneration
        || (
          credential !== undefined
          && active.actorId === credential.actorId
          && active.credentialGeneration !== credential.generation
        )
      ) {
        active.controller.abort(new Error("Slack target authorization changed"));
      }
    }
  }

  private async publishStatus(state: ManagedSlackWorkspaceState): Promise<void> {
    const routes = await this.ctx.storage.list<ManagedSlackPeerRouteRecord>({
      prefix: PEER_ROUTE_PREFIX,
    });
    await Promise.all([...routes.values()].map(async (route) => {
      if (route.version !== 1) return;
      await this.publishStatusToRoute(state, route);
    }));
  }

  private async publishStatusToRoute(
    state: ManagedSlackWorkspaceState,
    route: ManagedSlackPeerRouteRecord,
  ): Promise<void> {
    try {
      this.retirement.requireLive(routeOwner(route));
      const status = workspaceStatus(state);
      const extra: ManagedSlackWorkspaceStatusExtra = {
        teamId: state.teamId,
        botUserId: state.botUserId,
      };
      if (state.teamName) extra.teamName = state.teamName;
      await callAdapterGateway(
        this.env.GATEWAY,
        { installationId: route.installationId },
        "adapter.state.update",
        {
          adapter: "slack",
          accountId: state.accountId,
          status: {
            accountId: state.accountId,
            connected: status.connected,
            authenticated: false,
            mode: "managed-shared",
            error: status.error,
            extra,
          },
        },
      );
    } catch {
      // Explicit status polling remains available if a route is temporarily unavailable.
    }
  }

  private assertObjectName(accountId: string): void {
    if (this.env.MANAGED_SLACK_WORKSPACE.idFromName(managedSlackWorkspaceObjectName(accountId)).toString() !== this.ctx.id.toString()) {
      throw new Error("Slack workspace Durable Object identity mismatch");
    }
  }

  private slackFetch(owner?: AdapterDataOwner | null): SlackFetch {
    const transport: SlackFetch = this.env.SLACK_API ? (input, init) => this.env.SLACK_API!.fetch(input, init) : fetch;
    if (!owner) return transport;
    const retirementSignal = this.retirement.signal(owner);
    return (input, init) => {
      this.retirement.requireLive(owner);
      const signal = init?.signal ? AbortSignal.any([init.signal, retirementSignal]) : retirementSignal;
      return transport(input, { ...init, signal });
    };
  }

  private operation(owner?: AdapterDataOwner | null) {
    const complete = this.retirement.start(owner);
    return { [Symbol.dispose]: complete, fetch: this.slackFetch(owner) };
  }

  private async registerOwnership(owner: AdapterDataOwner, accountId: string): Promise<void> {
    this.retirement.requireLive(owner);
    const name = managedSlackWorkspaceObjectName(accountId);
    this.assertObjectName(accountId);
    await this.env.SLACK_INSTALLATIONS.getByName(owner.installationId).registerResource({ kind: "adapter-account", name, objectId: this.ctx.id.toString(), generation: owner.generation });
    this.retirement.requireLive(owner);
  }

  private attributeActorRecords(route: ManagedSlackPeerRouteRecord, replaceOwner = false): void {
    const owner = routeOwner(route);
    const credential = this.ctx.storage.kv.get<ManagedSlackUserCredentialState>(userCredentialKey(route.actorId));
    if (credential && (replaceOwner || credential.owner === undefined || credential.owner === null)) this.ctx.storage.kv.put(userCredentialKey(route.actorId), { ...credential, owner });
    const cacheKey = `${DM_CACHE_PREFIX}${route.actorId}`;
    const cache = this.ctx.storage.kv.get<ManagedSlackDmCache>(cacheKey);
    if (cache && (replaceOwner || cache.owner === undefined || cache.owner === null)) this.ctx.storage.kv.put(cacheKey, { ...cache, owner });
  }

  private ownership(installationId: string) {
    const keys: string[] = [];
    let unattributed = 0;
    const state = this.ctx.storage.kv.get<ManagedSlackWorkspaceState>(STATE_KEY);
    if (state && state.version !== 1) unattributed++;
    for (const [key] of this.ctx.storage.kv.list()) {
      if (key === STATE_KEY || key.startsWith(ADAPTER_RETIREMENT_PREFIX)) continue;
      if (key.startsWith(PEER_ROUTE_PREFIX)) {
        const parsed = storedRouteSchema.safeParse(this.ctx.storage.kv.get(key));
        if (!parsed.success || key !== `${PEER_ROUTE_PREFIX}${parsed.data.actorId}`) unattributed++;
        else if (parsed.data.installationId === installationId) keys.push(key);
      } else if (key.startsWith(USER_CREDENTIAL_PREFIX) || key.startsWith(DM_CACHE_PREFIX)) {
        const actor = key.slice(key.startsWith(USER_CREDENTIAL_PREFIX) ? USER_CREDENTIAL_PREFIX.length : DM_CACHE_PREFIX.length);
        const parsed = (key.startsWith(USER_CREDENTIAL_PREFIX) ? storedCredentialSchema : storedDmCacheSchema).safeParse(this.ctx.storage.kv.get(key));
        if (!parsed.success || "actorId" in parsed.data && parsed.data.actorId !== actor) { unattributed++; continue; }
        const route = storedRouteSchema.safeParse(this.ctx.storage.kv.get(`${PEER_ROUTE_PREFIX}${actor}`));
        const owner = parsed.data.owner === undefined && route.success && route.data.actorId === actor ? routeOwner(route.data) : parsed.data.owner;
        if (!state || owner === undefined) unattributed++;
        else if (owner?.installationId === installationId) keys.push(key);
      } else unattributed++;
    }
    const tables = this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_METADATA', '_cf_KV', '__miniflare_do_name')").toArray();
    unattributed += tables.length;
    return { keys, unattributed };
  }
}

function routeOwner(route: ManagedSlackPeerRouteRecord): AdapterDataOwner { return { installationId: route.installationId, generation: route.routeGeneration }; }

class SlackTargetAuthorizationUnavailableError extends Error {}

function accountIdFromObjectName(name: string | undefined): string {
  if (!name?.startsWith("workspace:")) throw new Error("Slack workspace identity unavailable");
  return requireWorkspaceAccountId(name.slice("workspace:".length));
}

function admission(state: ManagedSlackWorkspaceState): ManagedSlackWorkspaceAdmission {
  return {
    accepted: true,
    accountId: state.accountId,
    teamId: state.teamId,
    teamName: state.teamName,
    botUserId: state.botUserId,
    generation: state.generation,
  };
}

function workspaceStatus(state: ManagedSlackWorkspaceState): ManagedSlackWorkspaceStatus {
  const missing = missingRequiredScopes(normalizedScopes(state.scope));
  const connected = state.active && missing.length === 0;
  return {
    accountId: state.accountId,
    teamId: state.teamId,
    teamName: state.teamName,
    botUserId: state.botUserId,
    connected,
    generation: state.generation,
    error: !state.active
      ? "Slack app is not installed in this workspace"
      : missing.length > 0
        ? "Slack app must be reinstalled to grant required permissions"
        : undefined,
  };
}

function peerRouteKey(actorId: string): string {
  return `${PEER_ROUTE_PREFIX}${requireSlackId(actorId, "Slack actor")}`;
}

function requireRoutePart(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,190}[A-Za-z0-9])?$/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function normalizedOptionalText(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.trim().slice(0, maxLength) ?? "";
  return normalized || undefined;
}

function normalizedScopes(value: string | undefined): Set<string> {
  return new Set((value ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean));
}

function missingRequiredScopes(scopes: ReadonlySet<string>): string[] {
  return [...REQUIRED_SCOPES].filter((scope) => !scopes.has(scope));
}

function missingScopes(
  scopes: ReadonlySet<string>,
  required: ReadonlySet<string>,
): string[] {
  return [...required].filter((scope) => !scopes.has(scope));
}

function userCredentialKey(actorId: string): string {
  return `${USER_CREDENTIAL_PREFIX}${requireSlackId(actorId, "Slack actor")}`;
}

function targetCallKey(actorId: string, requestId: string): string {
  const normalizedRequestId = requestId.trim();
  if (!normalizedRequestId || normalizedRequestId.length > 512) {
    throw new Error("Slack target request ID is invalid");
  }
  return `${requireSlackId(actorId, "Slack actor")}\0${normalizedRequestId}`;
}

function targetError(
  id: string,
  code: number,
  message: string,
): AdapterTargetResponseFrame<SlackTargetCall> {
  return { type: "res", id, ok: false, error: { code, message } };
}

type SlackFileUploadLogStage =
  | "authorization"
  | "ticket"
  | "bytes"
  | "completion"
  | "unknown";

function logSlackFileUploadFailure(
  slackError: SlackApiError | undefined,
  stageOverride?: SlackFileUploadLogStage,
): void {
  const status = slackError?.status;
  const observableStatus = status !== undefined
    && Number.isInteger(status)
    && status >= 100
    && status <= 599
    ? status
    : undefined;
  console.warn(JSON.stringify({
    component: "slack",
    event: "file_upload_failed",
    stage: stageOverride ?? slackError?.fileStage ?? "unknown",
    outcome: slackError?.kind ?? "permanent",
    providerCode: observableSlackFileErrorCode(slackError?.code),
    status: observableStatus,
  }));
}

function observableSlackFileErrorCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  if ([
    "account_inactive",
    "channel_not_found",
    "file_uploads_disabled",
    "invalid_arguments",
    "invalid_auth",
    "method_deprecated",
    "missing_scope",
    "no_permission",
    "not_allowed_token_type",
    "not_in_channel",
    "posting_to_channel_denied",
    "rate_limited",
    "ratelimited",
    "restricted_action",
    "team_access_not_granted",
    "token_revoked",
    "unknown_error",
  ].includes(code)) {
    return code;
  }
  return "other";
}

function sameActiveWorkspaceInstallation(
  current: ManagedSlackWorkspaceState | undefined,
  next: {
    teamId: string;
    botUserId: string;
    botToken: string;
    appId?: string;
    scope: string;
  },
): current is ManagedSlackWorkspaceState {
  return Boolean(
    current?.active
    && current.teamId === next.teamId
    && current.botUserId === next.botUserId
    && current.botToken === next.botToken
    && (current.appId ?? "") === (next.appId ?? "")
    && (current.scope ?? "") === next.scope,
  );
}
