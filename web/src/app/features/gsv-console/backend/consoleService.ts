import type { GSVClient } from "@humansandmachines/gsv/client";
import type { AiTextGenerateConfig } from "@humansandmachines/gsv/protocol";
import {
  buildConsoleOverviewData,
  normalizeAccountsPayload,
  normalizeAdapterInventoryPayload,
  normalizeAdapterPayload,
  normalizeConfigPayload,
  normalizeIdentityLinksPayload,
  normalizeMcpServersPayload,
  normalizePackagesPayload,
  normalizeProcessesPayload,
  normalizeTargetsPayload,
} from "../domain/consoleNormalization";
import type {
  ConsoleAccount,
  ConsoleAdapter,
  ConsoleAdapterAccount,
  ConsoleConfigEntry,
  ConsoleIdentityLink,
  ConsoleMcpServer,
  ConsoleMcpTransport,
  ConsoleOverviewData,
  ConsolePackage,
  ConsoleProcess,
  ConsoleTarget,
} from "../domain/consoleModels";
import { isSensitiveSettingKey } from "../domain/consoleSettings";
export type { AgentApprovalAction } from "../domain/consoleAgentBehavior";

export const DEFAULT_CONSOLE_ADAPTERS = ["whatsapp", "discord", "telegram"] as const;
const TEXT_MODEL_VALIDATION_KEYS = [
  "config/ai/provider",
  "config/ai/model",
  "config/ai/api_key",
  "config/ai/reasoning",
] as const;
const MODEL_VALIDATION_SYSTEM_PROMPT = "You are validating a text-generation model configuration. Reply with exactly: ok";
const MODEL_VALIDATION_USER_MESSAGE = "Reply with ok.";

export type ConsoleClient = Pick<GSVClient, "call" | "proc" | "pkg" | "account" | "sys">;

export type ConsoleAgentContextFileDraft = {
  label: string;
  name?: string;
  origName?: string;
  content: string;
  orig?: string;
};

export type ConsoleAgentContextFile = ConsoleAgentContextFileDraft & {
  name: string;
  orig: string;
};

export type CreateConsoleAgentInput = {
  name: string;
  role: string;
  description: string;
  model?: string;
  reasoning?: string;
  approval?: string;
  files: readonly ConsoleAgentContextFileDraft[];
};

export type CreateConsoleAgentResult = {
  uid: number | null;
  username: string;
  displayName: string;
};

export type SaveConsoleAgentContextInput = {
  username: string;
  files: readonly ConsoleAgentContextFileDraft[];
  baseNames?: readonly string[];
};

export type SaveConsoleAgentContextResult = {
  written: number;
  deleted: number;
};

export type SaveConsoleAgentBehaviorInput = {
  uid: number;
  model: string;
  reasoning: string;
  approval?: string;
};

export type SaveConsoleAgentBehaviorResult = {
  ok: true;
};

export type SaveConsoleConfigInput = {
  key: string;
  value?: string;
  copyFromKey?: string;
};

export type SaveConsoleConfigResult = {
  ok: true;
  key: string;
  value: string;
};

export type SaveConsoleConfigEntriesInput = {
  entries: readonly SaveConsoleConfigInput[];
};

export type SaveConsoleConfigEntriesResult = {
  ok: true;
  written: number;
};

export type ValidateConsoleModelConfigInput = {
  values: Record<string, string>;
  presetId?: string;
};

export type ValidateConsoleModelConfigResult = {
  ok: true;
  provider: string;
  model: string;
};

export type ConsoleProcessAction = "abort" | "reset" | "kill";

export type RunConsoleProcessActionInput = {
  pid: string;
  action: ConsoleProcessAction;
};

export type RunConsoleProcessActionResult = {
  ok: true;
  action: ConsoleProcessAction;
  pid: string;
};

export type CreateMachineNodeTokenInput = {
  deviceId: string;
  label?: string;
  expiresAt?: number | null;
};

export type DeleteConsoleMachineInput = {
  deviceId: string;
};

export type DeleteConsoleMachineResult = {
  deleted: boolean;
  deviceId: string;
  revokedTokens: number;
};

export type ConsumeIdentityLinkCodeInput = {
  code: string;
};

export type RemoveIdentityLinkInput = {
  adapter: string;
  accountId: string;
  actorId: string;
};

export type IdentityLinkMutationResult = {
  linked: boolean;
  link: ConsoleIdentityLink | null;
};

export type RemoveIdentityLinkResult = {
  removed: boolean;
};

export type ConnectConsoleAdapterInput = {
  adapter: string;
  accountId: string;
  config?: Record<string, unknown>;
};

export type ConnectConsoleAdapterResult = {
  ok: boolean;
  adapter: string;
  accountId: string;
  connected: boolean;
  authenticated: boolean;
  message: string;
  error: string;
  challenge: {
    type: string;
    message: string;
    data: string;
    expiresAt: number | null;
  } | null;
};

export type AddConsoleMcpServerInput = {
  name: string;
  url: string;
  transport: ConsoleMcpTransport;
  headers?: Record<string, string>;
};

export type IssuedMachineNodeToken = {
  tokenId: string;
  token: string;
  tokenPrefix: string;
  uid: number;
  kind: "node";
  label: string | null;
  allowedRole: "driver" | null;
  allowedDeviceId: string | null;
  createdAt: number;
  expiresAt: number | null;
};

export type LoadConsoleOverviewOptions = {
  adapters?: readonly string[];
  includeConfig?: boolean;
};

export async function loadConsoleProcesses(client: Pick<GSVClient, "proc">): Promise<ConsoleProcess[]> {
  return normalizeProcessesPayload(await client.proc.list({}));
}

export async function loadConsoleTargets(client: ConsoleClient): Promise<ConsoleTarget[]> {
  return normalizeTargetsPayload(await client.call("sys.device.list", { includeOffline: true }));
}

export async function loadConsolePackages(client: Pick<GSVClient, "pkg">): Promise<ConsolePackage[]> {
  return normalizePackagesPayload(await client.pkg.list({}));
}

export async function loadConsoleAccounts(client: Pick<GSVClient, "account">): Promise<ConsoleAccount[]> {
  return normalizeAccountsPayload(await client.account.list({}));
}

export async function loadConsoleConfig(client: ConsoleClient): Promise<ConsoleConfigEntry[]> {
  return normalizeConfigPayload(await client.sys.config.get({}));
}

export async function loadConsoleIdentityLinks(client: Pick<GSVClient, "call">): Promise<ConsoleIdentityLink[]> {
  return normalizeIdentityLinksPayload(await client.call("sys.link.list", {}));
}

export async function consumeIdentityLinkCode(
  client: Pick<GSVClient, "call">,
  input: ConsumeIdentityLinkCodeInput,
): Promise<IdentityLinkMutationResult> {
  const code = input.code.trim();
  if (!code) {
    throw new Error("link code is required");
  }

  const result = await client.call("sys.link.consume", { code }) as Record<string, unknown>;
  return normalizeIdentityLinkMutationResult(result);
}

export async function removeIdentityLink(
  client: Pick<GSVClient, "call">,
  input: RemoveIdentityLinkInput,
): Promise<RemoveIdentityLinkResult> {
  const adapter = normalizeIdentityLinkField(input.adapter, "adapter").toLowerCase();
  const accountId = normalizeIdentityLinkField(input.accountId, "account id");
  const actorId = normalizeIdentityLinkField(input.actorId, "actor id");

  const result = await client.call("sys.unlink", { adapter, accountId, actorId }) as Record<string, unknown>;
  return { removed: result.removed === true };
}

export async function saveConsoleConfig(
  client: Pick<GSVClient, "sys">,
  input: SaveConsoleConfigInput,
): Promise<SaveConsoleConfigResult> {
  const key = input.key.trim();
  if (!key) {
    throw new Error("config key is required");
  }

  const value = String(input.value ?? "");
  if (input.copyFromKey) {
    await client.sys.config.set({ key, copyFromKey: input.copyFromKey });
    return { ok: true, key, value };
  }
  await client.sys.config.set({ key, value });
  return { ok: true, key, value };
}

export async function saveConsoleConfigEntries(
  client: Pick<GSVClient, "sys">,
  input: SaveConsoleConfigEntriesInput,
): Promise<SaveConsoleConfigEntriesResult> {
  let written = 0;
  for (const entry of input.entries) {
    await saveConsoleConfig(client, entry);
    written += 1;
  }
  return { ok: true, written };
}

export async function validateConsoleModelConfig(
  client: Pick<GSVClient, "call">,
  input: ValidateConsoleModelConfigInput,
): Promise<ValidateConsoleModelConfigResult> {
  const presetId = input.presetId?.trim();
  const overrides = modelValidationOverrides(input.values);
  const model = overrides["config/ai/model"] || input.values["config/ai/model"]?.trim();
  if (!presetId && !model) {
    throw new Error("model is required");
  }

  const config: AiTextGenerateConfig = {
    ...(presetId ? { preset: { id: presetId } } : {}),
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
  };
  const secretValues = Object.entries(overrides)
    .filter(([key, value]) => isSensitiveSettingKey(key) && value.length > 0)
    .map(([, value]) => value);

  try {
    const result = await client.call("ai.text.generate", {
      systemPrompt: MODEL_VALIDATION_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: MODEL_VALIDATION_USER_MESSAGE,
        timestamp: Date.now(),
      }],
      config,
      options: {
        maxTokens: 16,
        reasoning: "off",
        timeoutMs: 30_000,
      },
      sessionAffinityKey: "gsv-console:model-validation",
    });
    const stopReason = result.message.stopReason;
    if (stopReason === "error" || stopReason === "aborted") {
      throw new Error(result.message.errorMessage || `model validation ended with ${stopReason}`);
    }
    return {
      ok: true,
      provider: result.provider,
      model: result.model,
    };
  } catch (error) {
    throw new Error(sanitizeModelValidationError(error, secretValues));
  }
}

export async function runConsoleProcessAction(
  client: Pick<GSVClient, "proc">,
  input: RunConsoleProcessActionInput,
): Promise<RunConsoleProcessActionResult> {
  const pid = input.pid.trim();
  if (!pid) {
    throw new Error("process id is required");
  }

  const result = input.action === "abort"
    ? await client.proc.abort({ pid })
    : input.action === "reset"
      ? await client.proc.reset({ pid })
      : input.action === "kill"
        ? await client.proc.kill({ pid, archive: true })
        : null;

  if (!result) {
    throw new Error(`unsupported process action: ${input.action}`);
  }
  if (result.ok === false) {
    throw new Error(result.error || `failed to ${input.action} process`);
  }

  return { ok: true, action: input.action, pid };
}

export async function loadConsoleAgentContext(
  client: Pick<GSVClient, "call">,
  username: string,
): Promise<ConsoleAgentContextFile[]> {
  const normalizedUsername = normalizeContextUsername(username);
  if (!normalizedUsername) {
    throw new Error("valid username is required");
  }

  const dir = contextDir(normalizedUsername);
  const listing = await client.call("fs.read", { path: dir }) as {
    ok?: boolean;
    files?: unknown;
    error?: string;
  };
  if (listing.ok === false) {
    return [];
  }

  const names = Array.isArray(listing.files)
    ? listing.files.filter((name): name is string => typeof name === "string" && name.endsWith(".md")).sort()
    : [];
  const files: ConsoleAgentContextFile[] = [];

  for (const name of names) {
    const result = await client.call("fs.read", { path: `${dir}/${name}` }) as {
      ok?: boolean;
      content?: unknown;
    };
    if (result.ok === false || typeof result.content !== "string") {
      continue;
    }
    const content = stripLineNumbers(result.content);
    files.push({
      name,
      origName: name,
      label: displayContextFileLabel(name),
      content,
      orig: content,
    });
  }

  return files;
}

export async function createConsoleAgent(
  client: Pick<GSVClient, "account" | "sys">,
  input: CreateConsoleAgentInput,
): Promise<CreateConsoleAgentResult> {
  const displayName = input.name.trim();
  const username = usernameFromAgentName(displayName);
  if (!username) {
    throw new Error("agent name is required");
  }

  const result = await client.account.create({
    kind: "agent",
    username,
    gecos: displayName || undefined,
    persona: personaSeed(input),
    contextFiles: contextFilesFromDraft(input.files),
  });
  const account = result.account;
  const uid = Number(account.uid);
  if (Number.isFinite(uid)) {
    await saveAgentBehaviorConfig(client, uid, input);
  }

  return {
    uid: Number.isFinite(uid) ? uid : null,
    username: account.username || username,
    displayName,
  };
}

export async function saveConsoleAgentContext(
  client: Pick<GSVClient, "call">,
  input: SaveConsoleAgentContextInput,
): Promise<SaveConsoleAgentContextResult> {
  const username = normalizeContextUsername(input.username);
  if (!username) {
    throw new Error("valid username is required");
  }

  let written = 0;
  let deleted = 0;
  const baseNames = new Set(
    (input.baseNames ?? [])
      .map((name) => normalizeContextFileName(name))
      .filter((name): name is string => name !== null),
  );
  const desiredNames = new Set<string>();
  for (const file of input.files) {
    const name = normalizeContextFileName(file.name ?? file.label);
    if (!name) {
      throw new Error("valid context file names are required");
    }
    desiredNames.add(name);
    if (file.content.trim().length === 0) {
      continue;
    }
    const origName = normalizeContextFileName(file.origName ?? file.name ?? file.label);
    const renamed = origName !== null && origName !== name;
    if (renamed || isChangedContextFile(file)) {
      const result = await client.call("fs.write", {
        path: `${contextDir(username)}/${name}`,
        content: file.content,
      }) as { ok?: boolean; error?: string };
      if (result.ok === false) {
        throw new Error(result.error || `failed to write ${name}`);
      }
      written += 1;
    }
  }

  for (const name of baseNames) {
    if (desiredNames.has(name)) {
      continue;
    }
    const result = await client.call("fs.delete", {
      path: `${contextDir(username)}/${name}`,
    }) as { ok?: boolean; error?: string };
    if (result.ok === false) {
      throw new Error(result.error || `failed to delete ${name}`);
    }
    deleted += 1;
  }

  return { written, deleted };
}

export async function saveConsoleAgentBehavior(
  client: Pick<GSVClient, "sys">,
  input: SaveConsoleAgentBehaviorInput,
): Promise<SaveConsoleAgentBehaviorResult> {
  const uid = Number(input.uid);
  if (!Number.isFinite(uid)) {
    throw new Error("uid is required");
  }
  await saveAgentBehaviorConfig(client, uid, input, { includeEmpty: true });

  return { ok: true };
}

export async function createMachineNodeToken(
  client: Pick<GSVClient, "sys">,
  input: CreateMachineNodeTokenInput,
): Promise<IssuedMachineNodeToken> {
  const deviceId = input.deviceId.trim();
  if (!deviceId) {
    throw new Error("device id is required");
  }

  const label = input.label?.trim();
  const result = await client.sys.token.create({
    kind: "node",
    allowedRole: "driver",
    allowedDeviceId: deviceId,
    ...(label ? { label } : {}),
    ...(typeof input.expiresAt === "number" ? { expiresAt: input.expiresAt } : {}),
  });

  return {
    tokenId: result.token.tokenId,
    token: result.token.token,
    tokenPrefix: result.token.tokenPrefix,
    uid: result.token.uid,
    kind: "node",
    label: result.token.label,
    allowedRole: result.token.allowedRole === "driver" ? "driver" : null,
    allowedDeviceId: result.token.allowedDeviceId,
    createdAt: result.token.createdAt,
    expiresAt: result.token.expiresAt,
  };
}

export async function deleteConsoleMachine(
  client: Pick<GSVClient, "call">,
  input: DeleteConsoleMachineInput,
): Promise<DeleteConsoleMachineResult> {
  const deviceId = input.deviceId.trim();
  if (!deviceId) {
    throw new Error("device id is required");
  }

  const result = await client.call("sys.device.delete", { deviceId }) as Record<string, unknown>;
  return {
    deleted: result.deleted === true,
    deviceId: stringOr(deviceId, result.deviceId),
    revokedTokens: typeof result.revokedTokens === "number" && Number.isFinite(result.revokedTokens)
      ? Math.max(0, Math.floor(result.revokedTokens))
      : 0,
  };
}

export async function loadConsoleAdapterAccounts(
  client: Pick<GSVClient, "call">,
  adapters?: readonly string[],
): Promise<ConsoleAdapterAccount[]> {
  const payloads = await loadAdapterPayloads(client, adapters);
  return payloads.flatMap((payload) => normalizeAdapterPayload(payload));
}

export async function loadConsoleAdapters(
  client: Pick<GSVClient, "call">,
  adapters?: readonly string[],
): Promise<ConsoleAdapter[]> {
  const payloads = await loadAdapterPayloads(client, adapters);
  return payloads.flatMap((payload) => normalizeAdapterInventoryPayload(payload));
}

export async function connectConsoleAdapter(
  client: Pick<GSVClient, "call">,
  input: ConnectConsoleAdapterInput,
): Promise<ConnectConsoleAdapterResult> {
  const adapter = input.adapter.trim();
  const accountId = input.accountId.trim();
  if (!adapter) {
    throw new Error("adapter is required");
  }
  if (!accountId) {
    throw new Error("account id is required");
  }

  const result = await client.call("adapter.connect", {
    adapter,
    accountId,
    ...(input.config && Object.keys(input.config).length > 0 ? { config: input.config } : {}),
  }) as Record<string, unknown>;
  const ok = result.ok === true;
  const challenge = normalizeAdapterChallenge(result.challenge);
  return {
    ok,
    adapter: stringOr(adapter, result.adapter),
    accountId: stringOr(accountId, result.accountId),
    connected: result.connected === true,
    authenticated: result.authenticated === true,
    message: stringOr(ok ? "Connected" : "Connection failed", result.message),
    error: stringOr("", result.error),
    challenge,
  };
}

export async function disconnectConsoleAdapter(
  client: Pick<GSVClient, "call">,
  input: { adapter: string; accountId: string },
): Promise<{ ok: boolean; message: string; error: string }> {
  const adapter = input.adapter.trim();
  const accountId = input.accountId.trim();
  if (!adapter) {
    throw new Error("adapter is required");
  }
  if (!accountId) {
    throw new Error("account id is required");
  }

  const result = await client.call("adapter.disconnect", { adapter, accountId }) as Record<string, unknown>;
  if (result.ok !== true) {
    throw new Error(stringOr(stringOr("Disconnect failed", result.message), result.error));
  }
  return {
    ok: true,
    message: stringOr("Disconnected", result.message),
    error: stringOr("", result.error),
  };
}

export async function loadConsoleMcpServers(client: Pick<GSVClient, "call">): Promise<ConsoleMcpServer[]> {
  return normalizeMcpServersPayload(await client.call("sys.mcp.list", {}));
}

export async function addConsoleMcpServer(
  client: Pick<GSVClient, "call">,
  input: AddConsoleMcpServerInput,
): Promise<ConsoleMcpServer> {
  const name = input.name.trim();
  const url = input.url.trim();
  if (!name) {
    throw new Error("name is required");
  }
  if (!url) {
    throw new Error("url is required");
  }

  const transport = input.transport === "streamable-http" || input.transport === "sse" ? input.transport : "auto";
  const callbackHost = typeof window === "undefined" ? undefined : window.location.origin;
  const result = await client.call("sys.mcp.add", {
    name,
    url,
    ...(callbackHost ? { callbackHost } : {}),
    transport: {
      type: transport,
      ...(input.headers && Object.keys(input.headers).length > 0 ? { headers: input.headers } : {}),
    },
  }) as Record<string, unknown>;
  const servers = normalizeMcpServersPayload({ servers: [result.server] });
  const server = servers[0];
  if (!server) {
    throw new Error("MCP server response was invalid");
  }
  return server;
}

export async function refreshConsoleMcpServer(
  client: Pick<GSVClient, "call">,
  serverId: string,
): Promise<ConsoleMcpServer | null> {
  const id = serverId.trim();
  if (!id) {
    throw new Error("server id is required");
  }
  const result = await client.call("sys.mcp.refresh", { serverId: id }) as Record<string, unknown>;
  return normalizeMcpServersPayload({ servers: result.server ? [result.server] : [] })[0] ?? null;
}

export async function removeConsoleMcpServer(
  client: Pick<GSVClient, "call">,
  serverId: string,
): Promise<{ removed: boolean }> {
  const id = serverId.trim();
  if (!id) {
    throw new Error("server id is required");
  }
  const result = await client.call("sys.mcp.remove", { serverId: id }) as Record<string, unknown>;
  return { removed: result.removed === true };
}

export async function loadConsoleOverview(
  client: ConsoleClient,
  options: LoadConsoleOverviewOptions = {},
): Promise<ConsoleOverviewData> {
  const includeConfig = options.includeConfig ?? true;

  const [
    processes,
    targets,
    packagesResult,
    accounts,
    adapterResults,
    mcpServers,
    config,
  ] = await Promise.all([
    client.proc.list({}),
    client.call("sys.device.list", { includeOffline: true }),
    client.pkg.list({}),
    client.account.list({}),
    loadAdapterPayloads(client, options.adapters),
    loadOptionalPayload(() => client.call("sys.mcp.list", {})),
    includeConfig ? loadOptionalPayload(() => client.sys.config.get({})) : Promise.resolve({ entries: [] }),
  ]);

  return buildConsoleOverviewData({
    loadedAt: Date.now(),
    processes,
    targets,
    packages: packagesResult,
    accounts,
    adapters: adapterResults,
    mcpServers,
    config,
  });
}

function normalizeIdentityLinkMutationResult(result: Record<string, unknown>): IdentityLinkMutationResult {
  const links = normalizeIdentityLinksPayload({ links: result.link ? [result.link] : [] });
  return {
    linked: result.linked === true,
    link: links[0] ?? null,
  };
}

function normalizeIdentityLinkField(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function modelValidationOverrides(values: Record<string, string>): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const key of TEXT_MODEL_VALIDATION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      overrides[key] = (values[key] ?? "").trim();
    }
  }
  return overrides;
}

function sanitizeModelValidationError(error: unknown, secretValues: readonly string[]): string {
  let message = error instanceof Error ? error.message : error ? String(error) : "model validation failed";
  for (const secret of secretValues) {
    if (secret.length < 4) {
      continue;
    }
    message = message.replace(new RegExp(escapeRegExp(secret), "g"), "redacted");
  }
  return message || "model validation failed";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function loadAdapterPayloads(client: Pick<GSVClient, "call">, adapters?: readonly string[]): Promise<unknown[]> {
  if (!adapters) {
    try {
      return [await client.call("adapter.list", {})];
    } catch {
      return loadAdapterStatusPayloads(client, DEFAULT_CONSOLE_ADAPTERS);
    }
  }

  return loadAdapterStatusPayloads(client, adapters);
}

async function loadAdapterStatusPayloads(client: Pick<GSVClient, "call">, adapters: readonly string[]): Promise<unknown[]> {
  const settled = await Promise.allSettled(
    adapters.map(async (adapter) => {
      try {
        return await client.call("adapter.status", { adapter });
      } catch {
        return { adapter, accounts: [] };
      }
    }),
  );

  return settled.map((result) => result.status === "fulfilled" ? result.value : { accounts: [] });
}

function normalizeAdapterChallenge(value: unknown): ConnectConsoleAdapterResult["challenge"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const type = stringOr("", record.type);
  if (!type) {
    return null;
  }
  return {
    type,
    message: stringOr("", record.message),
    data: stringOr("", record.data),
    expiresAt: typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt) ? record.expiresAt : null,
  };
}

function stringOr(fallback: string, value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

async function loadOptionalPayload(load: () => Promise<unknown>): Promise<unknown> {
  try {
    return await load();
  } catch {
    return {};
  }
}

type AgentBehaviorConfigDraft = {
  model?: string;
  reasoning?: string;
  approval?: string;
};

async function saveAgentBehaviorConfig(
  client: Pick<GSVClient, "sys">,
  uid: number,
  input: AgentBehaviorConfigDraft,
  options: { includeEmpty?: boolean } = {},
): Promise<void> {
  const model = input.model?.trim() ?? "";
  const reasoning = input.reasoning?.trim() ?? "";
  const approval = input.approval?.trim() ?? "";
  const writes: Promise<unknown>[] = [];

  if (input.model !== undefined && (options.includeEmpty || model)) {
    writes.push(client.sys.config.set({
      key: `users/${uid}/ai/model`,
      value: model,
    }));
  }
  if (input.approval !== undefined && (options.includeEmpty || approval)) {
    writes.push(client.sys.config.set({
      key: `users/${uid}/ai/tools/approval`,
      value: approval,
    }));
  }
  if (input.reasoning !== undefined && (options.includeEmpty || reasoning)) {
    writes.push(client.sys.config.set({
      key: `users/${uid}/ai/reasoning`,
      value: reasoning,
    }));
  }

  await Promise.all(writes);
}

function usernameFromAgentName(name: string): string | null {
  const username = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (!username) {
    return null;
  }
  if (/^[a-z_]/.test(username)) {
    return username;
  }
  return `a-${username}`.slice(0, 32);
}

function contextFilesFromDraft(files: readonly ConsoleAgentContextFileDraft[]):
  Array<{ name: string; text: string }> | undefined {
  const contextFiles = files
    .filter((file) => normalizeContextFileName(file.name ?? file.label) !== "05-persona.md")
    .filter(isChangedContextFile)
    .map((file) => ({
      name: normalizeContextFileName(file.name ?? file.label) ?? "context.md",
      text: file.content,
    }));

  return contextFiles.length > 0 ? contextFiles : undefined;
}

function personaSeed(input: CreateConsoleAgentInput): string | undefined {
  const personaFile = input.files.find((file) => normalizeContextFileName(file.name ?? file.label) === "05-persona.md");
  const personaText = personaFile && isChangedContextFile(personaFile) ? personaFile.content.trim() : "";
  const role = input.role.trim();
  const description = input.description.trim();
  const parts = [
    role && role.toUpperCase() !== "AGENT" ? `Role: ${role}` : "",
    personaText || description,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function isChangedContextFile(file: ConsoleAgentContextFileDraft): boolean {
  const content = file.content.trim();
  if (!content) {
    return false;
  }
  return content !== (file.orig ?? "").trim();
}

function normalizeContextFileName(label: string): string | null {
  const raw = label.trim();
  if (!raw || raw.includes("/") || raw.includes("\\") || raw.includes("\0")) {
    return null;
  }
  if (raw.toUpperCase() === "PERSONA") {
    return "05-persona.md";
  }
  const base = raw
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!base || base === "." || base === "..") {
    return null;
  }
  return `${base}.md`;
}

function normalizeContextUsername(value: string): string | null {
  const username = value.trim();
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(username) ? username : null;
}

function contextDir(username: string): string {
  return `/home/${username}/context.d`;
}

function stripLineNumbers(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\t/, ""))
    .join("\n");
}

function displayContextFileLabel(name: string): string {
  if (name === "05-persona.md") {
    return "PERSONA";
  }
  return name
    .replace(/\.md$/i, "")
    .replace(/^\d+-/, "")
    .replace(/[-_]+/g, " ")
    .trim()
    .toUpperCase() || name.toUpperCase();
}
