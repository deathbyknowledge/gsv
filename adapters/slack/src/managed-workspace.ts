import { DurableObject } from "cloudflare:workers";
import type {
  AdapterTargetRequestFrame,
  AdapterTargetResponseFrame,
} from "../../../packages/gsv/src/services/adapters.js";
import type { DeliveryFailureKind } from "../../shared/src/delivery-ledger";
import {
  downloadSlackFile,
  openSlackDm,
  postSlackMessage,
  requireSlackId,
  requireSlackToken,
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
import { executeSlackTargetShell } from "./slack-target-shell";
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
};

type ActiveSlackTargetCall = {
  actorId: string;
  workspaceGeneration: string;
  credentialGeneration: string;
  controller: AbortController;
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
  SLACK_API?: Fetcher;
}

const STATE_KEY = "managed_slack_workspace:v1:state";
const USER_CREDENTIAL_PREFIX = "managed_slack_workspace:v1:user:";
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
      };
    }
    const writes = [this.ctx.storage.put(STATE_KEY, state)];
    if (credential) {
      writes.push(this.ctx.storage.put(userCredentialKey(credential.actorId), credential));
    }
    await Promise.all(writes);
    this.abortSupersededTargetCalls(state.generation, credential);
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
    const state = await this.ctx.storage.get<ManagedSlackWorkspaceState>(STATE_KEY);
    if (!state) return { deactivated: false };
    const teamId = requireSlackId(teamIdInput, "Slack workspace");
    if (state.teamId !== teamId) throw new Error("Slack workspace identity mismatch");
    this.assertObjectName(state.accountId);
    if (state.active) {
      await this.ctx.storage.put(STATE_KEY, {
        ...state,
        active: false,
        botToken: "",
        generation: crypto.randomUUID(),
        deactivatedAt: Date.now(),
      } satisfies ManagedSlackWorkspaceState);
    }
    const credentials = await this.ctx.storage.list({ prefix: USER_CREDENTIAL_PREFIX });
    if (credentials.size > 0) {
      await this.ctx.storage.delete([...credentials.keys()]);
    }
    for (const active of this.targetCalls.values()) {
      active.controller.abort(new Error("Slack workspace authorization changed"));
    }
    return { deactivated: true };
  }

  async getTargetAuthorization(
    actorIdInput: string,
    expectedGeneration: string,
  ): Promise<ManagedSlackTargetAuthorization> {
    const actorId = requireSlackId(actorIdInput, "Slack actor");
    let authorization: {
      workspace: ManagedSlackWorkspaceState;
      credential: ManagedSlackUserCredentialState;
    };
    try {
      authorization = await this.requireTargetAuthorization(actorId, expectedGeneration);
    } catch {
      return { available: false };
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
    frame: AdapterTargetRequestFrame<"shell.exec">,
  ): Promise<AdapterTargetResponseFrame<"shell.exec">> {
    const actorId = requireSlackId(actorIdInput, "Slack actor");
    if (
      frame.type !== "req"
      || frame.call !== "shell.exec"
      || !frame.id.trim()
      || !Number.isFinite(frame.deadlineAt)
      || frame.body
    ) {
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
    };
    try {
      authorization = await this.requireTargetAuthorization(actorId, expectedGeneration);
    } catch {
      return targetError(frame.id, 403, "Slack target authorization is unavailable");
    }
    const { workspace, credential } = authorization;
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
    };
    this.targetCalls.set(callKey, active);
    const timeout = setTimeout(() => {
      controller.abort(new Error("Slack target request timed out"));
    }, remaining);

    try {
      const data = await executeSlackTargetShell({
        args: frame.args,
        userToken: credential.token,
        botToken: workspace.botToken,
        actorId,
        botUserId: workspace.botUserId,
        teamId: workspace.teamId,
        teamName: workspace.teamName,
        signal: controller.signal,
        slackFetch: this.slackFetch(),
        guard: async () => {
          await this.requireTargetAuthorization(
            actorId,
            expectedGeneration,
            credential.generation,
          );
        },
      });
      await this.requireTargetAuthorization(
        actorId,
        expectedGeneration,
        credential.generation,
      );
      return { type: "res", id: frame.id, ok: true, data };
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

  async openDm(
    actorIdInput: string,
    expectedGeneration: string,
  ): Promise<{ channelId: string }> {
    const state = await this.requireActive(expectedGeneration);
    const actorId = requireSlackId(actorIdInput, "Slack actor");
    const cacheKey = `managed_slack_workspace:v1:dm:${actorId}`;
    const cached = await this.ctx.storage.get<{ generation: string; channelId: string }>(cacheKey);
    if (cached?.generation === state.generation) {
      return { channelId: requireSlackId(cached.channelId, "Slack direct message") };
    }
    const channelId = await openSlackDm(state.botToken, actorId, this.slackFetch());
    await this.ctx.storage.put(cacheKey, { generation: state.generation, channelId });
    return { channelId };
  }

  async postMessage(
    expectedGeneration: string,
    input: SlackPostMessageInput,
  ): Promise<ManagedSlackWorkspacePostResult> {
    let state: ManagedSlackWorkspaceState;
    try {
      state = await this.requireActive(expectedGeneration);
    } catch {
      return { ok: false, kind: "permanent", error: "Slack workspace route changed" };
    }
    try {
      return {
        ok: true,
        ...await postSlackMessage(state.botToken, input, this.slackFetch()),
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
  ): Promise<ManagedSlackWorkspacePostResult> {
    let state: ManagedSlackWorkspaceState;
    try {
      state = await this.requireActive(expectedGeneration);
    } catch {
      return { ok: false, kind: "permanent", error: "Slack workspace route changed" };
    }
    try {
      return {
        ok: true,
        ...await updateSlackMessage(state.botToken, input, this.slackFetch()),
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
  ): Promise<ManagedSlackWorkspaceDownloadResult> {
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
        this.slackFetch(),
        async () => {
          await this.requireActive(expectedGeneration);
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
  ): Promise<ManagedSlackWorkspaceUploadResult> {
    let state: ManagedSlackWorkspaceState;
    try {
      state = await this.requireActive(expectedGeneration);
    } catch {
      return { ok: false, kind: "permanent", error: "Slack workspace route changed" };
    }
    try {
      const result = await uploadSlackFiles(
        state.botToken,
        input,
        this.slackFetch(),
        async () => {
          await this.requireActive(expectedGeneration);
        },
      );
      return { ok: true, fileIds: result.fileIds };
    } catch (error) {
      return {
        ok: false,
        kind: error instanceof SlackApiError ? error.kind : "permanent",
        error: "Slack file delivery failed",
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
      throw new Error("Slack workspace route changed");
    }
    this.assertObjectName(state.accountId);
    return state;
  }

  private async requireTargetAuthorization(
    actorId: string,
    expectedWorkspaceGeneration: string,
    expectedCredentialGeneration?: string,
  ): Promise<{
    workspace: ManagedSlackWorkspaceState;
    credential: ManagedSlackUserCredentialState;
  }> {
    const workspace = await this.requireActive(expectedWorkspaceGeneration);
    const credential = await this.ctx.storage.get<ManagedSlackUserCredentialState>(
      userCredentialKey(actorId),
    );
    if (
      !credential
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
      throw new Error("Slack target authorization is unavailable");
    }
    requireSlackToken(credential.token, "Slack user token", "xoxp-");
    return { workspace, credential };
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

  private assertObjectName(accountId: string): void {
    if (this.ctx.id.name !== managedSlackWorkspaceObjectName(accountId)) {
      throw new Error("Slack workspace Durable Object identity mismatch");
    }
  }

  private slackFetch(): SlackFetch {
    return this.env.SLACK_API
      ? (input, init) => this.env.SLACK_API!.fetch(input, init)
      : fetch;
  }
}

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
): AdapterTargetResponseFrame<"shell.exec"> {
  return { type: "res", id, ok: false, error: { code, message } };
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
