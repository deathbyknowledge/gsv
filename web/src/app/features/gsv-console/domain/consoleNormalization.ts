import type {
  ConsoleAccount,
  ConsoleAccountRelation,
  ConsoleAdapter,
  ConsoleAdapterAccount,
  ConsoleConfigEntry,
  ConsoleIdentityLink,
  ConsoleMcpConnectionState,
  ConsoleMcpServer,
  ConsoleMcpTool,
  ConsoleMcpTransport,
  ConsoleOverviewCounts,
  ConsoleOverviewData,
  ConsoleProcess,
  ConsoleProcessState,
  ConsoleTarget,
  ConsoleTargetKind,
} from "./consoleModels";
import { consoleWorkProcesses } from "./consoleProcesses";
import { z } from "zod";

const SENSITIVE_CONFIG_KEY_RE = /(?:^|\/|_)(?:api[_-]?key|password|secret|token|credential)(?:$|\/|_)/i;

type ConsoleWireValue =
  | string
  | number
  | boolean
  | null
  | ConsoleWireValue[]
  | ConsoleWireRecord;

type ConsoleWireRecord = { [key: string]: ConsoleWireValue };
const consoleWireValueSchema: z.ZodType<ConsoleWireValue> = z.lazy(() => z.union([
  z.string(), z.number(), z.boolean(), z.null(),
  z.array(consoleWireValueSchema),
  z.record(z.string(), consoleWireValueSchema),
]));
type ConsoleRpcPayload = z.input<typeof consoleWireValueSchema>;

function parseConsolePayload(value: ConsoleRpcPayload): ConsoleWireValue {
  return consoleWireValueSchema.parse(value);
}

export function normalizeProcessesPayload(payload: ConsoleRpcPayload): ConsoleProcess[] {
  const record = asRecord(parseConsolePayload(payload));
  return asArray(record?.processes)
    .map(normalizeProcess)
    .filter((entry): entry is ConsoleProcess => entry !== null)
    .sort(compareNullableNumbersDesc((entry) => entry.lastActiveAt ?? entry.createdAt));
}

export function normalizeTargetsPayload(payload: ConsoleRpcPayload): ConsoleTarget[] {
  const record = asRecord(parseConsolePayload(payload));
  return asArray(record?.targets)
    .map(normalizeTarget)
    .filter((entry): entry is ConsoleTarget => entry !== null)
    .sort((left, right) => {
      if (left.online !== right.online) {
        return left.online ? -1 : 1;
      }
      return left.label.localeCompare(right.label);
    });
}

export function normalizeAccountsPayload(payload: ConsoleRpcPayload): ConsoleAccount[] {
  const record = asRecord(parseConsolePayload(payload));
  return asArray(record?.accounts)
    .map(normalizeAccount)
    .filter((entry): entry is ConsoleAccount => entry !== null)
    .sort((left, right) => accountRank(left.relation) - accountRank(right.relation) || left.username.localeCompare(right.username));
}

export function normalizeAdapterStatusPayload(payload: ConsoleRpcPayload, adapterFallback: string): ConsoleAdapterAccount[] {
  const record = asRecord(parseConsolePayload(payload));
  const adapter = nonEmptyString(record?.adapter) ?? adapterFallback;
  return asArray(record?.accounts)
    .map((account) => normalizeAdapterAccount(account, adapter))
    .filter((entry): entry is ConsoleAdapterAccount => entry !== null)
    .sort((left, right) => left.accountId.localeCompare(right.accountId));
}

export function normalizeAdapterPayload(payload: ConsoleRpcPayload, adapterFallback = ""): ConsoleAdapterAccount[] {
  const record = asRecord(parseConsolePayload(payload));
  const adapters = asArray(record?.adapters);
  if (adapters.length > 0) {
    return adapters.flatMap((adapter) => normalizeAdapterStatusPayload(adapter, ""));
  }
  return normalizeAdapterStatusPayload(payload, adapterFallback);
}

export function normalizeAdapterInventoryPayload(payload: ConsoleRpcPayload, adapterFallback = ""): ConsoleAdapter[] {
  const parsedPayload = parseConsolePayload(payload);
  const record = asRecord(parsedPayload);
  const adapters = asArray(record?.adapters);
  const rows = adapters.length > 0
    ? adapters.map((adapter) => normalizeAdapterEntry(adapter, ""))
    : [normalizeAdapterEntry(parsedPayload, adapterFallback)];

  return rows
    .filter((entry): entry is ConsoleAdapter => entry !== null)
    .sort((left, right) => adapterRank(left.adapter) - adapterRank(right.adapter) || left.adapter.localeCompare(right.adapter));
}

export function normalizeMcpServersPayload(payload: ConsoleRpcPayload): ConsoleMcpServer[] {
  const record = asRecord(parseConsolePayload(payload));
  return asArray(record?.servers)
    .map(normalizeMcpServer)
    .filter((entry): entry is ConsoleMcpServer => entry !== null)
    .sort((left, right) => {
      const leftRank = mcpStateRank(left.state);
      const rightRank = mcpStateRank(right.state);
      return leftRank - rightRank || left.name.localeCompare(right.name);
    });
}

export function normalizeConfigPayload(payload: ConsoleRpcPayload): ConsoleConfigEntry[] {
  const record = asRecord(parseConsolePayload(payload));
  return asArray(record?.entries)
    .map(normalizeConfigEntry)
    .filter((entry): entry is ConsoleConfigEntry => entry !== null)
    .sort((left, right) => left.key.localeCompare(right.key));
}

export function normalizeIdentityLinksPayload(payload: ConsoleRpcPayload): ConsoleIdentityLink[] {
  const record = asRecord(parseConsolePayload(payload));
  return asArray(record?.links)
    .map(normalizeIdentityLink)
    .filter((entry): entry is ConsoleIdentityLink => entry !== null)
    .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
}

export function buildConsoleOverviewData(input: {
  processes: ConsoleRpcPayload;
  targets: ConsoleRpcPayload;
  accounts: ConsoleRpcPayload;
  adapters: ConsoleRpcPayload[];
  mcpServers: ConsoleRpcPayload;
  config: ConsoleRpcPayload;
  loadedAt?: number;
}): ConsoleOverviewData {
  const adapterInventory = input.adapters.flatMap((payload) => normalizeAdapterInventoryPayload(payload));
  return {
    loadedAt: input.loadedAt ?? Date.now(),
    processes: normalizeProcessesPayload(input.processes),
    targets: normalizeTargetsPayload(input.targets),
    accounts: normalizeAccountsPayload(input.accounts),
    adapterInventory,
    adapters: adapterInventory.flatMap((adapter) => adapter.accounts),
    mcpServers: normalizeMcpServersPayload(input.mcpServers),
    config: normalizeConfigPayload(input.config),
  };
}

export function summarizeConsoleOverview(data: ConsoleOverviewData): ConsoleOverviewCounts {
  const processes = consoleWorkProcesses(data.processes);
  return {
    processes: processes.length,
    activeProcesses: processes.filter((entry) => entry.activeRunId || entry.state === "running").length,
    queuedProcesses: processes.filter((entry) => entry.queuedCount > 0 || entry.state === "queued").length,
    targets: data.targets.length,
    onlineTargets: data.targets.filter((entry) => entry.online).length,
    accounts: data.accounts.length,
    runnableAccounts: data.accounts.filter((entry) => entry.runnable).length,
    adapters: data.adapterInventory.length,
    availableAdapters: data.adapterInventory.filter((entry) => entry.available).length,
    adapterAccounts: data.adapters.length,
    connectedAdapterAccounts: data.adapters.filter((entry) => entry.connected).length,
    mcpServers: data.mcpServers.length,
    readyMcpServers: data.mcpServers.filter((entry) => entry.state === "ready").length,
    configEntries: data.config.length,
  };
}

function normalizeIdentityLink(value: ConsoleWireValue): ConsoleIdentityLink | null {
  const record = asRecord(value);
  const adapter = nonEmptyString(record?.adapter);
  const accountId = nonEmptyString(record?.accountId);
  const actorId = nonEmptyString(record?.actorId);
  if (!record || !adapter || !accountId || !actorId) {
    return null;
  }

  return {
    adapter,
    accountId,
    actorId,
    uid: numberOrNull(record.uid) ?? 0,
    createdAt: numberOrNull(record.createdAt),
    linkedByUid: numberOrNull(record.linkedByUid),
  };
}

function normalizeProcess(value: ConsoleWireValue): ConsoleProcess | null {
  const record = asRecord(value);
  const pid = nonEmptyString(record?.pid);
  if (!record || !pid) {
    return null;
  }

  const queuedCount = numberOrNull(record.queuedCount) ?? 0;
  const activeRunId = nonEmptyString(record.activeRunId);
  const rawState = nonEmptyString(record.state) ?? "";

  return {
    pid,
    label: nonEmptyString(record.label) ?? pid,
    state: normalizeProcessState(rawState, activeRunId, queuedCount),
    rawState,
    uid: numberOrNull(record.uid),
    username: nonEmptyString(record.username) ?? "",
    profile: nonEmptyString(record.profile) ?? "",
    cwd: nonEmptyString(record.cwd) ?? "",
    parentPid: nonEmptyString(record.parentPid),
    interactive: record.interactive === true,
    personal: record.personal === true,
    activeRunId,
    queuedCount,
    createdAt: numberOrNull(record.createdAt),
    lastActiveAt: numberOrNull(record.lastActiveAt),
  };
}

function normalizeTarget(value: ConsoleWireValue): ConsoleTarget | null {
  const record = asRecord(value);
  const deviceId = nonEmptyString(record?.targetId);
  if (!record || !deviceId) {
    return null;
  }

  const platform = nonEmptyString(record.platform) ?? "";

  return {
    deviceId,
    kind: normalizeTargetKind(deviceId, platform),
    ownerUid: numberOrNull(record.ownerUid),
    ownerUsername: nonEmptyString(record.ownerUsername),
    label: nonEmptyString(record.label) ?? deviceId,
    description: stringOrEmpty(record.description),
    platform,
    version: stringOrEmpty(record.version),
    online: record.online === true,
    lastSeenAt: numberOrNull(record.lastSeenAt),
    implements: asArray(record.implements).map(stringOrEmpty).filter(Boolean).sort(),
  };
}

function normalizeAccount(value: ConsoleWireValue): ConsoleAccount | null {
  const record = asRecord(value);
  const uid = numberOrNull(record?.uid);
  const username = nonEmptyString(record?.username);
  if (!record || uid === null || !username) {
    return null;
  }

  return {
    uid,
    username,
    displayName: nonEmptyString(record.displayName) ?? username,
    relation: normalizeAccountRelation(record.relation),
    runnable: record.runnable === true,
    gecos: stringOrEmpty(record.gecos),
    capabilities: asArray(record.capabilities).map(stringOrEmpty).filter(Boolean).sort(),
  };
}

function normalizeAdapterAccount(value: ConsoleWireValue, adapter: string): ConsoleAdapterAccount | null {
  const record = asRecord(value);
  const accountId = nonEmptyString(record?.accountId);
  if (!record || !accountId) {
    return null;
  }

  return {
    adapter,
    accountId,
    connected: record.connected === true,
    authenticated: record.authenticated === true,
    mode: stringOrEmpty(record.mode),
    lastActivity: numberOrNull(record.lastActivity),
    error: stringOrEmpty(record.error),
    extra: asRecord(record.extra) ?? {},
  };
}

function normalizeAdapterEntry(value: ConsoleWireValue, adapterFallback: string): ConsoleAdapter | null {
  const record = asRecord(value);
  const adapter = nonEmptyString(record?.adapter) ?? adapterFallback;
  if (!record || !adapter) {
    return null;
  }

  const accounts = asArray(record.accounts)
    .map((account) => normalizeAdapterAccount(account, adapter))
    .filter((entry): entry is ConsoleAdapterAccount => entry !== null)
    .sort((left, right) => left.accountId.localeCompare(right.accountId));

  return {
    adapter,
    available: record.available === true,
    supportsConnect: record.supportsConnect === true,
    supportsDisconnect: record.supportsDisconnect === true,
    supportsSend: record.supportsSend === true,
    supportsStatus: record.supportsStatus === true,
    supportsActivity: record.supportsActivity === true,
    supportsPairing: record.supportsPairing === true,
    accounts,
  };
}

function normalizeMcpServer(value: ConsoleWireValue): ConsoleMcpServer | null {
  const record = asRecord(value);
  const serverId = nonEmptyString(record?.serverId);
  if (!record || !serverId) {
    return null;
  }

  return {
    serverId,
    uid: numberOrNull(record.uid),
    name: nonEmptyString(record.name) ?? serverId,
    url: stringOrEmpty(record.url),
    transport: normalizeMcpTransport(record.transport),
    state: normalizeMcpState(record.state),
    authUrl: stringOrEmpty(record.authUrl),
    error: stringOrEmpty(record.error),
    instructions: stringOrEmpty(record.instructions),
    capabilities: asRecord(record.capabilities),
    tools: asArray(record.tools)
      .map(normalizeMcpTool)
      .filter((entry): entry is ConsoleMcpTool => entry !== null)
      .sort((left, right) => left.name.localeCompare(right.name)),
    resourceCount: numberOrNull(record.resourceCount) ?? 0,
    promptCount: numberOrNull(record.promptCount) ?? 0,
    createdAt: numberOrNull(record.createdAt),
    updatedAt: numberOrNull(record.updatedAt),
  };
}

function normalizeMcpTool(value: ConsoleWireValue): ConsoleMcpTool | null {
  const record = asRecord(value);
  const name = nonEmptyString(record?.name);
  if (!record || !name) {
    return null;
  }
  return {
    name,
    description: stringOrEmpty(record.description),
    inputSchema: asRecord(record.inputSchema),
    outputSchema: asRecord(record.outputSchema),
  };
}

function normalizeConfigEntry(value: ConsoleWireValue): ConsoleConfigEntry | null {
  const record = asRecord(value);
  const key = nonEmptyString(record?.key);
  if (!record || !key) {
    return null;
  }

  const redacted = SENSITIVE_CONFIG_KEY_RE.test(key);
  const entryValue = stringOrEmpty(record.value);
  return {
    key,
    value: redacted ? "" : entryValue,
    redacted,
  };
}

function normalizeProcessState(rawState: string, activeRunId: string | null, queuedCount: number): ConsoleProcessState {
  const state = rawState.toLowerCase();
  if (state === "waiting_hil") return "waiting_hil";
  if (state === "running" || state === "active" || activeRunId) return "running";
  if (state === "queued" || queuedCount > 0) return "queued";
  if (state === "idle" || state === "ready" || state === "") return "idle";
  return "unknown";
}

function normalizeTargetKind(deviceId: string, platform: string): ConsoleTargetKind {
  const normalizedPlatform = platform.trim().toLowerCase();
  const normalizedDeviceId = deviceId.trim().toLowerCase();
  if (
    normalizedDeviceId.startsWith("browser:") ||
    normalizedPlatform === "browser" ||
    normalizedPlatform === "browser-extension"
  ) {
    return "browser";
  }
  if (normalizedPlatform) return "native-device";
  return "unknown";
}

function normalizeAccountRelation(value: ConsoleWireValue | undefined): ConsoleAccountRelation {
  return value === "self" || value === "personal-agent" || value === "agent" || value === "human" ? value : "unknown";
}

function normalizeMcpTransport(value: ConsoleWireValue | undefined): ConsoleMcpTransport {
  return value === "auto" || value === "streamable-http" || value === "sse" ? value : "unknown";
}

function normalizeMcpState(value: ConsoleWireValue | undefined): ConsoleMcpConnectionState {
  if (
    value === "not-connected"
    || value === "authenticating"
    || value === "connecting"
    || value === "connected"
    || value === "discovering"
    || value === "ready"
    || value === "failed"
  ) {
    return value;
  }
  return "unknown";
}

function adapterRank(adapter: string): number {
  if (adapter === "telegram") return 0;
  if (adapter === "discord") return 1;
  if (adapter === "whatsapp") return 2;
  return 10;
}

function mcpStateRank(state: ConsoleMcpConnectionState): number {
  if (state === "failed") return 0;
  if (state === "authenticating") return 1;
  if (state === "connecting" || state === "discovering" || state === "connected") return 2;
  if (state === "ready") return 3;
  if (state === "not-connected") return 4;
  return 5;
}

function accountRank(relation: ConsoleAccountRelation): number {
  if (relation === "self") return 0;
  if (relation === "personal-agent") return 1;
  if (relation === "agent") return 2;
  if (relation === "human") return 3;
  return 4;
}

function compareNullableNumbersDesc<T>(select: (item: T) => number | null): (left: T, right: T) => number {
  return (left, right) => (select(right) ?? 0) - (select(left) ?? 0);
}

function asRecord(value: ConsoleWireValue | undefined): ConsoleWireRecord | null {
  const parsed = z.record(z.string(), consoleWireValueSchema).safeParse(value);
  return parsed.success ? parsed.data : null;
}

function asArray(value: ConsoleWireValue | undefined): ConsoleWireValue[] {
  return Array.isArray(value) ? value : [];
}

function stringOrEmpty(value: ConsoleWireValue | undefined): string {
  const parsed = z.string().safeParse(value);
  return parsed.success ? parsed.data : "";
}

function nonEmptyString(value: ConsoleWireValue | undefined): string | null {
  const text = z.string().safeParse(value);
  if (text.success) {
    const trimmed = text.data.trim();
    return trimmed ? trimmed : null;
  }
  const number = z.number().finite().safeParse(value);
  if (number.success) return String(number.data);
  return null;
}

function numberOrNull(value: ConsoleWireValue | undefined): number | null {
  const number = z.number().finite().safeParse(value);
  if (number.success) {
    return number.data;
  }
  const text = z.string().safeParse(value);
  if (text.success && text.data.trim()) {
    const parsed = Number(text.data);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
