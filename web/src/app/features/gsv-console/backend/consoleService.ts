import type { GSVClient } from "@humansandmachines/gsv/client";
import type {
  AdapterConnectResult,
  AdapterPairConfirmResult,
  AdapterPairInfoResult,
  AdapterPairInspectResult,
  AiTextGenerateConfig,
  SysOAuthDevicePollResult,
  SysOAuthDeviceStartResult,
} from "@humansandmachines/gsv/protocol";
import { isAdapterConnectResult } from "@humansandmachines/gsv/protocol";
import {
  buildConsoleOverviewData,
  normalizeAccountsPayload,
  normalizeAdapterInventoryPayload,
  normalizeAdapterPayload,
  normalizeConfigPayload,
  normalizeIdentityLinksPayload,
  normalizeMcpServersPayload,
  normalizeProcessesPayload,
  normalizeTargetsPayload,
} from "../domain/consoleNormalization";
import { avatarConfigKey } from "../domain/agentPresentation";
import type {
  ConsoleAccount,
  ConsoleAdapter,
  ConsoleAdapterAccount,
  ConsoleConfigEntry,
  ConsoleIdentityLink,
  ConsoleMcpServer,
  ConsoleMcpTransport,
  ConsoleOverviewData,
  ConsoleProcess,
  ConsoleTarget,
} from "../domain/consoleModels";
import { modelProfileIdFromOptionValue } from "../domain/consoleAi";
import { isSensitiveSettingKey } from "../domain/consoleSettings";
import { requestFsRead } from "../../../services/gateway/fsRead";
import { z } from "zod";
export type { AgentApprovalAction } from "../domain/consoleAgentBehavior";

export const DEFAULT_CONSOLE_ADAPTERS = ["whatsapp", "discord", "telegram"] as const;
const TEXT_MODEL_VALIDATION_KEYS = [
  "config/ai/provider",
  "config/ai/model",
  "config/ai/base_url",
  "config/ai/provider_style",
  "config/ai/transport_target",
  "config/ai/api_key",
  "config/ai/reasoning",
] as const;
const MODEL_VALIDATION_SYSTEM_PROMPT = "You are validating a text-generation model configuration. Reply with exactly: ok";
const MODEL_VALIDATION_USER_MESSAGE = "Reply with ok.";
const OPENAI_CODEX_PROVIDER = "openai-codex";
const HTML_DOCUMENT_PATTERN = /(?:<!doctype\s+html|<html[\s>])/i;
const HTML_CHALLENGE_OR_BLOCK_PATTERN =
  /\b(?:unable\s+to\s+load\s+site|ray\s+id|cf-ray|cdn-cgi\/challenge-platform|cloudflare|vpn)\b/i;
const gatewayPayloadSchema = z.unknown();
type GatewayPayload = z.input<typeof gatewayPayloadSchema>;
const gatewayRecordSchema = z.record(z.string(), z.unknown());
type GatewayRecord = z.infer<typeof gatewayRecordSchema>;

function parseGatewayRecord(value: GatewayPayload): GatewayRecord {
  const parsed = gatewayRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export type ConsoleClient = Pick<GSVClient, "call" | "proc" | "account" | "sys">;
type ConsoleConfigClient = {
  sys: {
    config: Pick<GSVClient["sys"]["config"], "set">;
  };
};
type ConsoleAccountCreateClient = ConsoleConfigClient & {
  account: Pick<GSVClient["account"], "create">;
};
type ConsoleTokenCreateClient = {
  sys: {
    token: Pick<GSVClient["sys"]["token"], "create">;
  };
};

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
  fallbackModel?: string;
  reasoning?: string;
  approval?: string;
  /** Fixed portrait assigned at creation (see agentPresentation.pickAgentImage). */
  avatarSrc?: string;
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
  fallbackModel?: string;
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

export type StartConsoleOpenAiCodexOAuthResult = SysOAuthDeviceStartResult;
export type PollConsoleOpenAiCodexOAuthInput = {
  flowId: string;
};
export type PollConsoleOpenAiCodexOAuthResult = SysOAuthDevicePollResult;
export type CheckConsoleOpenAiCodexOAuthResult = {
  connected: boolean;
};

export type ConsoleProcessAction = "abort" | "reset" | "kill";

export type RunConsoleProcessActionInput = {
  pid: string;
  runId?: string;
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
  config?: Record<string, string | number | boolean | null>;
};

export type ConnectConsoleAdapterResult = AdapterConnectResult;

export type InspectConsoleAdapterPairingInput = {
  adapter: string;
  code: string;
};

export type ConsoleAdapterPairingInfo = AdapterPairInfoResult;
export type ConsoleAdapterPairingCandidate = AdapterPairInspectResult;
export type ConsoleAdapterPairingResult = AdapterPairConfirmResult;

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

  const result = parseGatewayRecord(await client.call("sys.link.consume", { code }));
  return normalizeIdentityLinkMutationResult(result);
}

export async function removeIdentityLink(
  client: Pick<GSVClient, "call">,
  input: RemoveIdentityLinkInput,
): Promise<RemoveIdentityLinkResult> {
  const adapter = normalizeIdentityLinkField(input.adapter, "adapter").toLowerCase();
  const accountId = normalizeIdentityLinkField(input.accountId, "account id");
  const actorId = normalizeIdentityLinkField(input.actorId, "actor id");

  const result = parseGatewayRecord(await client.call("sys.unlink", { adapter, accountId, actorId }));
  return { removed: result.removed === true };
}

export async function saveConsoleConfig(
  client: ConsoleConfigClient,
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
  client: ConsoleConfigClient,
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
    ...(presetId ? { preset: { id: presetId } } : undefined),
    ...(Object.keys(overrides).length > 0 ? { overrides } : undefined),
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
        maxTokens: 2_048,
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

export async function startConsoleOpenAiCodexOAuth(
  client: Pick<GSVClient, "call">,
): Promise<StartConsoleOpenAiCodexOAuthResult> {
  return await client.call("sys.oauth.device.start", {
    kind: "ai-provider",
    provider: "openai-codex",
  });
}

export async function pollConsoleOpenAiCodexOAuth(
  client: Pick<GSVClient, "call">,
  input: PollConsoleOpenAiCodexOAuthInput,
): Promise<PollConsoleOpenAiCodexOAuthResult> {
  return await client.call("sys.oauth.device.poll", {
    flowId: input.flowId,
  });
}

export async function checkConsoleOpenAiCodexOAuth(
  client: Pick<GSVClient, "call">,
): Promise<CheckConsoleOpenAiCodexOAuthResult> {
  const result = await client.call("sys.oauth.list", {});
  return {
    connected: result.accounts.some((account) =>
      account.kind === "ai-provider" &&
      account.provider === OPENAI_CODEX_PROVIDER &&
      account.accountKey === "default" &&
      hasOpenAiCodexAccountId(account.metadata)
    ),
  };
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
    ? await client.proc.abort({ pid, ...(input.runId ? { runId: input.runId } : undefined) })
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
  client: Pick<GSVClient, "request">,
  username: string,
): Promise<ConsoleAgentContextFile[]> {
  const normalizedUsername = normalizeContextUsername(username);
  if (!normalizedUsername) {
    throw new Error("valid username is required");
  }

  const dir = contextDir(normalizedUsername);
  const listing = await requestFsRead(client, { path: dir });
  if (!listing.ok || !("files" in listing)) {
    return [];
  }

  const names = listing.files.filter((name) => name.endsWith(".md")).sort();
  const files: ConsoleAgentContextFile[] = [];

  for (const name of names) {
    const result = await requestFsRead(client, { path: `${dir}/${name}` });
    if (!result.ok || !("kind" in result) || result.kind !== "text") {
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
  client: ConsoleAccountCreateClient,
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
    const writes: Promise<unknown>[] = [saveAgentBehaviorConfig(client, uid, input)];
    const avatarSrc = input.avatarSrc?.trim();
    if (avatarSrc) {
      // Fixed portrait: persisted once at creation, read back everywhere via
      // agentPresentation.avatarForAccount. Non-fatal — the account exists by
      // now, and a cosmetic pref must not fail creation; on failure the agent
      // just falls back to the legacy position-derived portrait.
      writes.push(
        client.sys.config.set({ key: avatarConfigKey(uid), value: avatarSrc }).catch((error) => {
          console.warn("agent avatar persist failed; using fallback portrait", error);
        }),
      );
    }
    await Promise.all(writes);
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
      });
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
    });
    if (result.ok === false) {
      throw new Error(result.error || `failed to delete ${name}`);
    }
    deleted += 1;
  }

  return { written, deleted };
}

export async function saveConsoleAgentBehavior(
  client: ConsoleConfigClient,
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
  client: ConsoleTokenCreateClient,
  input: CreateMachineNodeTokenInput,
): Promise<IssuedMachineNodeToken> {
  const deviceId = input.deviceId.trim();
  if (!deviceId) {
    throw new Error("device id is required");
  }

  const label = input.label?.trim();
  const expiresAt = z.number().finite().safeParse(input.expiresAt);
  const result = await client.sys.token.create({
    kind: "node",
    allowedRole: "driver",
    allowedDeviceId: deviceId,
    ...(label ? { label } : undefined),
    ...(expiresAt.success ? { expiresAt: expiresAt.data } : undefined),
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

  const result = parseGatewayRecord(await client.call("sys.device.delete", { deviceId }));
  return {
    deleted: result.deleted === true,
    deviceId: stringOr(deviceId, result.deviceId),
    revokedTokens: (() => {
      const count = z.number().finite().safeParse(result.revokedTokens);
      return count.success ? Math.max(0, Math.floor(count.data)) : 0;
    })(),
  };
}

export async function loadConsoleAdapterAccounts(
  client: Pick<GSVClient, "call">,
  adapters?: readonly string[],
  accountId?: string,
): Promise<ConsoleAdapterAccount[]> {
  const payloads = await loadAdapterPayloads(client, adapters, accountId);
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

  const result: GatewayPayload = await client.call("adapter.connect", {
    adapter,
    accountId,
    ...(input.config && Object.keys(input.config).length > 0 ? { config: input.config } : undefined),
  });
  // The gateway response is transported as JSON; round-tripping here gives the
  // protocol guard its JSON-domain input and establishes the adapter result boundary.
  const parsedResult = JSON.parse(JSON.stringify(result));
  if (!isAdapterConnectResult(parsedResult)) {
    throw new Error("Adapter returned an invalid connection response");
  }
  return parsedResult;
}

export async function loadConsoleAdapterPairingInfo(
  client: Pick<GSVClient, "call">,
  adapter: string,
): Promise<ConsoleAdapterPairingInfo> {
  return await client.call("adapter.pair.info", { adapter: adapter.trim() });
}

export async function inspectConsoleAdapterPairing(
  client: Pick<GSVClient, "call">,
  input: InspectConsoleAdapterPairingInput,
): Promise<ConsoleAdapterPairingCandidate> {
  return await client.call("adapter.pair.inspect", {
    adapter: input.adapter.trim(),
    code: input.code.trim(),
  });
}

export async function confirmConsoleAdapterPairing(
  client: Pick<GSVClient, "call">,
  input: InspectConsoleAdapterPairingInput,
): Promise<ConsoleAdapterPairingResult> {
  return await client.call("adapter.pair.confirm", {
    adapter: input.adapter.trim(),
    code: input.code.trim(),
  });
}

export async function disconnectConsoleAdapterPairing(
  client: Pick<GSVClient, "call">,
  input: RemoveIdentityLinkInput,
): Promise<{ disconnected: boolean }> {
  return await client.call("adapter.pair.disconnect", {
    adapter: input.adapter.trim(),
    accountId: input.accountId.trim(),
    actorId: input.actorId.trim(),
  });
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

  const result = parseGatewayRecord(await client.call("adapter.disconnect", { adapter, accountId }));
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
  const callbackHost = globalThis.window?.location.origin;
  const result = await client.call("sys.mcp.add", {
    name,
    url,
    ...(callbackHost ? { callbackHost } : undefined),
    transport: {
      type: transport,
      ...(input.headers && Object.keys(input.headers).length > 0 ? { headers: input.headers } : undefined),
    },
  });
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
  const result = parseGatewayRecord(await client.call("sys.mcp.refresh", { serverId: id }));
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
  const result = parseGatewayRecord(await client.call("sys.mcp.remove", { serverId: id }));
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
    accounts,
    adapterResults,
    mcpServers,
    config,
  ] = await Promise.all([
    client.proc.list({}),
    client.call("sys.device.list", { includeOffline: true }),
    client.account.list({}),
    loadAdapterPayloads(client, options.adapters),
    loadOptionalPayload(() => client.call("sys.mcp.list", {})),
    includeConfig ? loadOptionalPayload(() => client.sys.config.get({})) : Promise.resolve({ entries: [] }),
  ]);

  return buildConsoleOverviewData({
    loadedAt: Date.now(),
    processes,
    targets,
    accounts,
    adapters: adapterResults,
    mcpServers,
    config,
  });
}

function normalizeIdentityLinkMutationResult(result: GatewayRecord): IdentityLinkMutationResult {
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

function modelValidationOverrides(values: Record<string, string>) {
  const overrides: Record<string, string> = {};
  for (const key of TEXT_MODEL_VALIDATION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      overrides[key] = (values[key] ?? "").trim();
    }
  }
  return overrides;
}

function hasOpenAiCodexAccountId(metadata: GatewayPayload): boolean {
  const record = parseGatewayRecord(metadata);
  const accountId = record.chatgptAccountId;
  const parsed = z.string().safeParse(accountId);
  return parsed.success && parsed.data.trim().length > 0;
}

function sanitizeModelValidationError(error: GatewayPayload, secretValues: readonly string[]): string {
  let message = error instanceof Error ? error.message : error ? String(error) : "model validation failed";
  message = sanitizeHtmlModelValidationError(message);
  for (const secret of secretValues) {
    if (secret.length < 4) {
      continue;
    }
    message = message.replace(new RegExp(escapeRegExp(secret), "g"), "redacted");
  }
  return message || "model validation failed";
}

function sanitizeHtmlModelValidationError(message: string): string {
  if (!HTML_DOCUMENT_PATTERN.test(message)) {
    return message;
  }
  if (HTML_CHALLENGE_OR_BLOCK_PATTERN.test(message)) {
    return [
      "Provider returned an HTML challenge or block page instead of a model response.",
      "Check VPN/network access to the provider, or run GSV from an environment that can reach it.",
    ].join(" ");
  }
  return "Provider returned an HTML error page instead of a model response.";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function loadAdapterPayloads(
  client: Pick<GSVClient, "call">,
  adapters?: readonly string[],
  accountId?: string,
): Promise<GatewayPayload[]> {
  if (!adapters) {
    try {
      return [await client.call("adapter.list", {})];
    } catch {
      return loadAdapterStatusPayloads(client, DEFAULT_CONSOLE_ADAPTERS);
    }
  }

  return loadAdapterStatusPayloads(client, adapters, accountId);
}

async function loadAdapterStatusPayloads(
  client: Pick<GSVClient, "call">,
  adapters: readonly string[],
  accountId?: string,
): Promise<GatewayPayload[]> {
  const settled = await Promise.allSettled(
    adapters.map(async (adapter) => {
      try {
        return await client.call("adapter.status", {
          adapter,
          ...(accountId ? { accountId } : undefined),
        });
      } catch {
        return { adapter, accounts: [] };
      }
    }),
  );

  return settled.map((result) => result.status === "fulfilled" ? result.value : { accounts: [] });
}

function stringOr(fallback: string, value: GatewayPayload): string {
  const parsed = z.string().safeParse(value);
  return parsed.success && parsed.data.trim().length > 0 ? parsed.data : fallback;
}

async function loadOptionalPayload(load: () => Promise<GatewayPayload>): Promise<GatewayPayload> {
  try {
    return await load();
  } catch {
    return {};
  }
}

type AgentBehaviorConfigDraft = {
  model?: string;
  fallbackModel?: string;
  reasoning?: string;
  approval?: string;
};

async function saveAgentBehaviorConfig(
  client: ConsoleConfigClient,
  uid: number,
  input: AgentBehaviorConfigDraft,
  options: { includeEmpty?: boolean } = {},
): Promise<void> {
  const model = input.model?.trim() ?? "";
  const fallbackModel = input.fallbackModel?.trim() ?? "";
  const reasoning = input.reasoning?.trim() ?? "";
  const approval = input.approval?.trim() ?? "";
  const writes: Promise<unknown>[] = [];

  if (input.model !== undefined && (options.includeEmpty || model)) {
    const modelProfile = modelProfileIdFromOptionValue(model);
    if (options.includeEmpty || modelProfile) {
      writes.push(client.sys.config.set({
        key: `users/${uid}/ai/model_profile`,
        value: modelProfile ?? "",
      }));
    }
    writes.push(client.sys.config.set({
      key: `users/${uid}/ai/model`,
      value: modelProfile ? "" : model,
    }));
  }
  if (input.fallbackModel !== undefined && (options.includeEmpty || fallbackModel)) {
    writes.push(client.sys.config.set({
      key: `users/${uid}/ai/fallback_model_profile`,
      value: modelProfileIdFromOptionValue(fallbackModel) ?? fallbackModel,
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
