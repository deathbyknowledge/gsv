import { DurableObject } from "cloudflare:workers";
import type { DeliveryFailureKind } from "../../shared/src/delivery-ledger";
import {
  downloadSlackFile,
  openSlackDm,
  postSlackMessage,
  requireSlackId,
  requireSlackToken,
  SlackApiError,
  workspaceAccountId,
  type SlackFetch,
  type SlackDownloadedFile,
  type SlackOAuthInstallation,
  type SlackPostMessageInput,
  type SlackUploadFilesInput,
  uploadSlackFiles,
} from "./slack-api";
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

interface Env {
  SLACK_API?: Fetcher;
}

const STATE_KEY = "managed_slack_workspace:v1:state";
const REQUIRED_SCOPES = new Set([
  "app_mentions:read",
  "chat:write",
  "files:read",
  "files:write",
  "im:history",
  "im:write",
]);

export class ManagedSlackWorkspace extends DurableObject<Env> {
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

    const state: ManagedSlackWorkspaceState = {
      version: 1,
      accountId: normalizedAccountId,
      teamId,
      teamName: normalizedOptionalText(installation.teamName, 160),
      botUserId: requireSlackId(installation.botUserId, "Slack bot user"),
      botToken: requireSlackToken(installation.botToken, "Slack bot token", "xoxb-"),
      appId: installation.appId
        ? requireSlackId(installation.appId, "Slack app")
        : undefined,
      scope: [...scopes].sort().join(","),
      generation: crypto.randomUUID(),
      active: true,
      installedAt: Date.now(),
    };
    await this.ctx.storage.put(STATE_KEY, state);
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
    if (!state.active) return { deactivated: true };
    await this.ctx.storage.put(STATE_KEY, {
      ...state,
      active: false,
      botToken: "",
      generation: crypto.randomUUID(),
      deactivatedAt: Date.now(),
    } satisfies ManagedSlackWorkspaceState);
    return { deactivated: true };
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
          ? "Slack app must be reinstalled to grant file access"
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
