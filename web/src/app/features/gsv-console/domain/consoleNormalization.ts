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
  ConsolePackage,
  ConsolePackageEntrypoint,
  ConsolePackageProfile,
  ConsolePackageRuntime,
  ConsoleProcess,
  ConsoleProcessState,
  ConsoleTarget,
  ConsoleTargetKind,
} from "./consoleModels";
import {
  isModelProfilesConfigKey,
  redactModelProfilesConfigValue,
} from "./consoleSettings";

const SENSITIVE_CONFIG_KEY_RE = /(?:^|\/|_)(?:api[_-]?key|password|secret|token|credential)(?:$|\/|_)/i;

export function normalizeProcessesPayload(payload: unknown): ConsoleProcess[] {
  const record = asRecord(payload);
  return asArray(record?.processes)
    .map(normalizeProcess)
    .filter((entry): entry is ConsoleProcess => entry !== null)
    .sort(compareNullableNumbersDesc((entry) => entry.lastActiveAt ?? entry.createdAt));
}

export function normalizeTargetsPayload(payload: unknown): ConsoleTarget[] {
  const record = asRecord(payload);
  return asArray(record?.devices)
    .map(normalizeTarget)
    .filter((entry): entry is ConsoleTarget => entry !== null)
    .sort((left, right) => {
      if (left.online !== right.online) {
        return left.online ? -1 : 1;
      }
      return left.label.localeCompare(right.label);
    });
}

export function normalizePackagesPayload(payload: unknown): ConsolePackage[] {
  const record = asRecord(payload);
  return asArray(record?.packages)
    .map(normalizePackage)
    .filter((entry): entry is ConsolePackage => entry !== null)
    .sort((left, right) => {
      if (left.enabled !== right.enabled) {
        return left.enabled ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
}

export function normalizeAccountsPayload(payload: unknown): ConsoleAccount[] {
  const record = asRecord(payload);
  return asArray(record?.accounts)
    .map(normalizeAccount)
    .filter((entry): entry is ConsoleAccount => entry !== null)
    .sort((left, right) => accountRank(left.relation) - accountRank(right.relation) || left.username.localeCompare(right.username));
}

export function normalizeAdapterStatusPayload(payload: unknown, adapterFallback: string): ConsoleAdapterAccount[] {
  const record = asRecord(payload);
  const adapter = nonEmptyString(record?.adapter) ?? adapterFallback;
  return asArray(record?.accounts)
    .map((account) => normalizeAdapterAccount(account, adapter))
    .filter((entry): entry is ConsoleAdapterAccount => entry !== null)
    .sort((left, right) => left.accountId.localeCompare(right.accountId));
}

export function normalizeAdapterPayload(payload: unknown, adapterFallback = ""): ConsoleAdapterAccount[] {
  const record = asRecord(payload);
  const adapters = asArray(record?.adapters);
  if (adapters.length > 0) {
    return adapters.flatMap((adapter) => normalizeAdapterStatusPayload(adapter, ""));
  }
  return normalizeAdapterStatusPayload(payload, adapterFallback);
}

export function normalizeAdapterInventoryPayload(payload: unknown, adapterFallback = ""): ConsoleAdapter[] {
  const record = asRecord(payload);
  const adapters = asArray(record?.adapters);
  const rows = adapters.length > 0
    ? adapters.map((adapter) => normalizeAdapterEntry(adapter, ""))
    : [normalizeAdapterEntry(payload, adapterFallback)];

  return rows
    .filter((entry): entry is ConsoleAdapter => entry !== null)
    .sort((left, right) => adapterRank(left.adapter) - adapterRank(right.adapter) || left.adapter.localeCompare(right.adapter));
}

export function normalizeMcpServersPayload(payload: unknown): ConsoleMcpServer[] {
  const record = asRecord(payload);
  return asArray(record?.servers)
    .map(normalizeMcpServer)
    .filter((entry): entry is ConsoleMcpServer => entry !== null)
    .sort((left, right) => {
      const leftRank = mcpStateRank(left.state);
      const rightRank = mcpStateRank(right.state);
      return leftRank - rightRank || left.name.localeCompare(right.name);
    });
}

export function normalizeConfigPayload(payload: unknown): ConsoleConfigEntry[] {
  const record = asRecord(payload);
  return asArray(record?.entries)
    .map(normalizeConfigEntry)
    .filter((entry): entry is ConsoleConfigEntry => entry !== null)
    .sort((left, right) => left.key.localeCompare(right.key));
}

export function normalizeIdentityLinksPayload(payload: unknown): ConsoleIdentityLink[] {
  const record = asRecord(payload);
  return asArray(record?.links)
    .map(normalizeIdentityLink)
    .filter((entry): entry is ConsoleIdentityLink => entry !== null)
    .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
}

export function buildConsoleOverviewData(input: {
  processes: unknown;
  targets: unknown;
  packages: unknown;
  accounts: unknown;
  adapters: unknown[];
  mcpServers: unknown;
  config: unknown;
  loadedAt?: number;
}): ConsoleOverviewData {
  const adapterInventory = input.adapters.flatMap((payload) => normalizeAdapterInventoryPayload(payload));
  return {
    loadedAt: input.loadedAt ?? Date.now(),
    processes: normalizeProcessesPayload(input.processes),
    targets: normalizeTargetsPayload(input.targets),
    packages: normalizePackagesPayload(input.packages),
    accounts: normalizeAccountsPayload(input.accounts),
    adapterInventory,
    adapters: adapterInventory.flatMap((adapter) => adapter.accounts),
    mcpServers: normalizeMcpServersPayload(input.mcpServers),
    config: normalizeConfigPayload(input.config),
  };
}

export function summarizeConsoleOverview(data: ConsoleOverviewData): ConsoleOverviewCounts {
  return {
    processes: data.processes.length,
    activeProcesses: data.processes.filter((entry) => entry.activeRunId || entry.state === "running").length,
    queuedProcesses: data.processes.filter((entry) => entry.queuedCount > 0 || entry.state === "queued").length,
    targets: data.targets.length,
    onlineTargets: data.targets.filter((entry) => entry.online).length,
    packages: data.packages.length,
    enabledPackages: data.packages.filter((entry) => entry.enabled).length,
    reviewPendingPackages: data.packages.filter((entry) => entry.reviewPending).length,
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

function normalizeIdentityLink(value: unknown): ConsoleIdentityLink | null {
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

function normalizeProcess(value: unknown): ConsoleProcess | null {
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
    activeRunId,
    activeConversationId: nonEmptyString(record.activeConversationId),
    queuedCount,
    createdAt: numberOrNull(record.createdAt),
    lastActiveAt: numberOrNull(record.lastActiveAt),
  };
}

function normalizeTarget(value: unknown): ConsoleTarget | null {
  const record = asRecord(value);
  const deviceId = nonEmptyString(record?.deviceId);
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

function normalizePackage(value: unknown): ConsolePackage | null {
  const record = asRecord(value);
  const packageId = nonEmptyString(record?.packageId);
  if (!record || !packageId) {
    return null;
  }

  const source = asRecord(record.source);
  const scope = asRecord(record.scope);
  const review = asRecord(record.review);
  const entrypoints = asArray(record.entrypoints).map(normalizeEntrypoint).filter((entry): entry is ConsolePackageEntrypoint => entry !== null);
  const profiles = asArray(record.profiles).map(normalizePackageProfile).filter((entry): entry is ConsolePackageProfile => entry !== null);
  const runtime = normalizePackageRuntime(record.runtime);

  return {
    packageId,
    name: nonEmptyString(record.name) ?? packageId,
    description: stringOrEmpty(record.description),
    version: stringOrEmpty(record.version),
    runtime,
    enabled: record.enabled === true,
    scopeKind: scope?.kind === "global" || scope?.kind === "user" ? scope.kind : "unknown",
    scopeUid: numberOrNull(scope?.uid),
    sourceRepo: stringOrEmpty(source?.repo),
    sourceRef: stringOrEmpty(source?.ref),
    sourceSubdir: stringOrEmpty(source?.subdir),
    sourcePublic: source?.public === true,
    reviewRequired: review?.required === true,
    reviewApprovedAt: numberOrNull(review?.approvedAt),
    reviewPending: review?.required === true && numberOrNull(review?.approvedAt) === null,
    installedAt: numberOrNull(record.installedAt),
    updatedAt: numberOrNull(record.updatedAt),
    bindingNames: asArray(record.bindingNames).map(stringOrEmpty).filter(Boolean).sort(),
    entrypoints,
    uiEntrypoints: entrypoints.filter((entry) => entry.kind === "ui"),
    profiles,
  };
}

function normalizeEntrypoint(value: unknown): ConsolePackageEntrypoint | null {
  const record = asRecord(value);
  const name = nonEmptyString(record?.name);
  const kind = nonEmptyString(record?.kind);
  if (!record || !name || !kind) {
    return null;
  }

  return {
    name,
    kind,
    description: stringOrEmpty(record.description),
    route: stringOrEmpty(record.route),
    command: stringOrEmpty(record.command),
    syscalls: asArray(record.syscalls).map(stringOrEmpty).filter(Boolean).sort(),
  };
}

function normalizePackageProfile(value: unknown): ConsolePackageProfile | null {
  const record = asRecord(value);
  const name = nonEmptyString(record?.name);
  if (!record || !name) {
    return null;
  }

  const account = asRecord(record.account);
  return {
    name,
    displayName: nonEmptyString(record.displayName) ?? name,
    description: stringOrEmpty(record.description),
    icon: stringOrEmpty(record.icon),
    capabilities: asArray(record.capabilities).map(stringOrEmpty).filter(Boolean).sort(),
    account: {
      runAs: stringOrEmpty(account?.runAs),
      username: stringOrEmpty(account?.username),
      provisioned: typeof account?.provisioned === "boolean" ? account.provisioned : null,
      runnable: typeof account?.runnable === "boolean" ? account.runnable : null,
    },
  };
}

function normalizeAccount(value: unknown): ConsoleAccount | null {
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

function normalizeAdapterAccount(value: unknown, adapter: string): ConsoleAdapterAccount | null {
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

function normalizeAdapterEntry(value: unknown, adapterFallback: string): ConsoleAdapter | null {
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
    accounts,
  };
}

function normalizeMcpServer(value: unknown): ConsoleMcpServer | null {
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

function normalizeMcpTool(value: unknown): ConsoleMcpTool | null {
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

function normalizeConfigEntry(value: unknown): ConsoleConfigEntry | null {
  const record = asRecord(value);
  const key = nonEmptyString(record?.key);
  if (!record || !key) {
    return null;
  }

  const redacted = SENSITIVE_CONFIG_KEY_RE.test(key);
  const entryValue = stringOrEmpty(record.value);
  return {
    key,
    value: redacted ? "" : isModelProfilesConfigKey(key) ? redactModelProfilesConfigValue(entryValue) : entryValue,
    redacted,
  };
}

function normalizeProcessState(rawState: string, activeRunId: string | null, queuedCount: number): ConsoleProcessState {
  const state = rawState.toLowerCase();
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

function normalizePackageRuntime(value: unknown): ConsolePackageRuntime {
  return value === "dynamic-worker" || value === "node" || value === "web-ui" ? value : "unknown";
}

function normalizeAccountRelation(value: unknown): ConsoleAccountRelation {
  return value === "self" || value === "personal-agent" || value === "agent" || value === "human" ? value : "unknown";
}

function normalizeMcpTransport(value: unknown): ConsoleMcpTransport {
  return value === "auto" || value === "streamable-http" || value === "sse" ? value : "unknown";
}

function normalizeMcpState(value: unknown): ConsoleMcpConnectionState {
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
