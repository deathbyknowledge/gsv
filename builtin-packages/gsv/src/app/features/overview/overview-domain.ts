import type { DeviceSummary, DevicesState } from "../devices/types";
import type { AdapterAccount, AdapterKind, AdaptersState, McpServer, McpState } from "../integrations/types";
import type { PackageRecord, PackagesState, PackagesView } from "../packages/types";
import type { ProcessEntry, RuntimeState } from "../runtime/types";
import type { AdministrationState } from "../settings/types";
import type { GsvSectionId, Tone } from "../../navigation/types";

export type OverviewSurface = "runtime" | "devices" | "packages" | "adapters" | "mcp" | "administration";

export type OverviewSurfaceError = {
  surface: OverviewSurface;
  label: string;
  message: string;
};

export type OverviewSnapshot = {
  runtime: RuntimeState | null;
  devices: DevicesState | null;
  packages: PackagesState | null;
  adapters: AdaptersState | null;
  mcp: McpState | null;
  administration: AdministrationState | null;
  errors: OverviewSurfaceError[];
  loadedAt: number;
};

export type OverviewAttentionItem = {
  id: string;
  title: string;
  description: string;
  meta: string;
  tone: Tone;
  sectionId: GsvSectionId;
  packageId?: string;
  packageView?: PackagesView;
  priority: number;
};

export type OverviewPostureItem = {
  id: string;
  label: string;
  value: string;
  detail: string;
  tone: Tone;
  sectionId: GsvSectionId;
};

export type OverviewModel = {
  attention: OverviewAttentionItem[];
  posture: OverviewPostureItem[];
  loadedAt: number;
};

const EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;

export function buildOverviewModel(snapshot: OverviewSnapshot): OverviewModel {
  const attention = [
    ...buildLoadErrorItems(snapshot.errors),
    ...buildRuntimeAttention(snapshot.runtime),
    ...buildDeviceAttention(snapshot.devices, snapshot.loadedAt),
    ...buildPackageAttention(snapshot.packages),
    ...buildAdapterAttention(snapshot.adapters),
    ...buildMcpAttention(snapshot.mcp),
    ...buildAccessAttention(snapshot.administration, snapshot.loadedAt),
  ].sort(compareAttentionItems);

  return {
    attention,
    posture: buildPosture(snapshot, attention),
    loadedAt: snapshot.loadedAt,
  };
}

function buildLoadErrorItems(errors: OverviewSurfaceError[]): OverviewAttentionItem[] {
  return errors.map((error) => ({
    id: `load:${error.surface}`,
    title: `${error.label} unavailable`,
    description: error.message,
    meta: "Load failed",
    tone: "danger",
    sectionId: surfaceSection(error.surface),
    priority: 100,
  }));
}

function buildRuntimeAttention(runtime: RuntimeState | null): OverviewAttentionItem[] {
  if (!runtime) return [];
  const items: OverviewAttentionItem[] = [];
  const errorText = runtime.errorText.trim();
  if (errorText) {
    items.push({
      id: "runtime:error",
      title: "Runtime reported an error",
      description: errorText,
      meta: "Runtime",
      tone: "danger",
      sectionId: "runtime",
      priority: 90,
    });
  }

  const failed = runtime.processes.filter(isFailedProcess);
  if (failed.length > 0) {
    items.push({
      id: "runtime:failed-processes",
      title: plural(failed.length, "process needs attention", "processes need attention"),
      description: summarizeProcesses(failed),
      meta: `${failed.length} processes`,
      tone: "danger",
      sectionId: "runtime",
      priority: 80,
    });
  }

  const paused = runtime.processes.filter((process) => processState(process) === "paused");
  if (paused.length > 0) {
    items.push({
      id: "runtime:paused-processes",
      title: plural(paused.length, "process is paused", "processes are paused"),
      description: "Paused work may need an operator decision before it can continue.",
      meta: `${paused.length} paused`,
      tone: "warning",
      sectionId: "runtime",
      priority: 55,
    });
  }

  return items;
}

function buildDeviceAttention(devices: DevicesState | null, now: number): OverviewAttentionItem[] {
  if (!devices) return [];
  const items: OverviewAttentionItem[] = [];
  if (devices.devices.length === 0) {
    items.push({
      id: "devices:none",
      title: "No execution targets are registered",
      description: "Provision a native node or connect a browser or adapter before routing work.",
      meta: "Targets",
      tone: "warning",
      sectionId: "devices",
      priority: 58,
    });
  } else {
    const offline = devices.devices.filter((device) => !device.online);
    if (offline.length > 0) {
      items.push({
        id: "devices:offline",
        title: plural(offline.length, "target is offline", "targets are offline"),
        description: summarizeDevices(offline),
        meta: `${offline.length}/${devices.devices.length} offline`,
        tone: offline.length === devices.devices.length ? "danger" : "warning",
        sectionId: "devices",
        priority: offline.length === devices.devices.length ? 82 : 60,
      });
    }
  }

  const expiringTokens = activeTokens(devices.deviceTokens, now).filter((token) => tokenExpiresSoon(token, now));
  if (expiringTokens.length > 0) {
    items.push({
      id: "devices:tokens-expiring",
      title: plural(expiringTokens.length, "node token expires soon", "node tokens expire soon"),
      description: "Rotate provisioning credentials before connected nodes lose access.",
      meta: `${expiringTokens.length} tokens`,
      tone: "warning",
      sectionId: "devices",
      priority: 50,
    });
  }

  return items;
}

function buildPackageAttention(packages: PackagesState | null): OverviewAttentionItem[] {
  if (!packages) return [];
  const items: OverviewAttentionItem[] = [];
  const reviews = packages.packages.filter((pkg) => pkg.reviewPending);
  if (reviews.length > 0) {
    items.push({
      id: "packages:review",
      title: plural(reviews.length, "package needs trust review", "packages need trust review"),
      description: summarizePackages(reviews),
      meta: `${reviews.length} review`,
      tone: "danger",
      sectionId: "packages",
      packageId: reviews.length === 1 ? reviews[0].packageId : undefined,
      packageView: "review",
      priority: 88,
    });
  }

  const updates = packages.packages.filter((pkg) => pkg.updateAvailable);
  if (updates.length > 0) {
    items.push({
      id: "packages:updates",
      title: plural(updates.length, "package update is available", "package updates are available"),
      description: summarizePackages(updates),
      meta: `${updates.length} updates`,
      tone: "warning",
      sectionId: "packages",
      packageId: updates.length === 1 ? updates[0].packageId : undefined,
      packageView: "updates",
      priority: 52,
    });
  }

  const catalogErrors = packages.catalogs.filter((catalog) => catalog.error);
  if (catalogErrors.length > 0) {
    items.push({
      id: "packages:catalog-errors",
      title: plural(catalogErrors.length, "catalog remote failed", "catalog remotes failed"),
      description: catalogErrors.map((catalog) => catalog.name).slice(0, 3).join(", "),
      meta: "Catalogs",
      tone: "warning",
      sectionId: "packages",
      priority: 48,
    });
  }

  return items;
}

function buildAdapterAttention(adapters: AdaptersState | null): OverviewAttentionItem[] {
  if (!adapters) return [];
  const entries = Object.entries(adapters.statusByAdapter) as Array<[AdapterKind, AdapterAccount[]]>;
  const accounts = entries.flatMap(([adapter, adapterAccounts]) => (
    adapterAccounts.map((account) => ({ adapter, account }))
  ));
  const errored = accounts.filter(({ account }) => account.error);
  if (errored.length > 0) {
    return [{
      id: "adapters:errors",
      title: plural(errored.length, "message adapter account has an error", "message adapter accounts have errors"),
      description: summarizeAdapterAccounts(errored),
      meta: `${errored.length} accounts`,
      tone: "danger",
      sectionId: "integrations",
      priority: 78,
    }];
  }

  const disconnected = accounts.filter(({ account }) => !account.connected);
  if (disconnected.length === 0) return [];
  return [{
    id: "adapters:disconnected",
    title: plural(disconnected.length, "message adapter account is disconnected", "message adapter accounts are disconnected"),
    description: summarizeAdapterAccounts(disconnected),
    meta: `${disconnected.length} accounts`,
    tone: "warning",
    sectionId: "integrations",
    priority: 56,
  }];
}

function buildMcpAttention(mcp: McpState | null): OverviewAttentionItem[] {
  if (!mcp) return [];
  const failed = mcp.servers.filter((server) => server.state === "failed");
  if (failed.length > 0) {
    return [{
      id: "mcp:failed",
      title: plural(failed.length, "MCP server failed", "MCP servers failed"),
      description: summarizeMcpServers(failed),
      meta: `${failed.length} servers`,
      tone: "danger",
      sectionId: "integrations",
      priority: 76,
    }];
  }

  const blocked = mcp.servers.filter((server) => server.state === "authenticating" || server.state === "not-connected");
  if (blocked.length === 0) return [];
  return [{
    id: "mcp:blocked",
    title: plural(blocked.length, "MCP server needs connection work", "MCP servers need connection work"),
    description: summarizeMcpServers(blocked),
    meta: `${blocked.length} servers`,
    tone: "warning",
    sectionId: "integrations",
    priority: 54,
  }];
}

function buildAccessAttention(administration: AdministrationState | null, now: number): OverviewAttentionItem[] {
  if (!administration) return [];
  const expiring = activeTokens(administration.tokens, now).filter((token) => tokenExpiresSoon(token, now));
  if (expiring.length === 0) return [];
  return [{
    id: "access:tokens-expiring",
    title: plural(expiring.length, "access token expires soon", "access tokens expire soon"),
    description: "Rotate credentials before integrations or users lose access.",
    meta: `${expiring.length} tokens`,
    tone: "warning",
    sectionId: "access",
    priority: 50,
  }];
}

function buildPosture(snapshot: OverviewSnapshot, attention: OverviewAttentionItem[]): OverviewPostureItem[] {
  const runtimeIssues = attention.filter((item) => item.sectionId === "runtime");
  const deviceIssues = attention.filter((item) => item.sectionId === "devices");
  const packageIssues = attention.filter((item) => item.sectionId === "packages");
  const integrationIssues = attention.filter((item) => item.sectionId === "integrations");
  const accessIssues = attention.filter((item) => item.sectionId === "access");

  return [
    {
      id: "runtime",
      label: "Runtime",
      value: snapshot.runtime ? `${snapshot.runtime.processes.length} processes` : "unavailable",
      detail: postureDetail(runtimeIssues),
      tone: postureTone(runtimeIssues),
      sectionId: "runtime",
    },
    {
      id: "devices",
      label: "Targets",
      value: snapshot.devices ? devicePostureValue(snapshot.devices.devices) : "unavailable",
      detail: postureDetail(deviceIssues),
      tone: postureTone(deviceIssues),
      sectionId: "devices",
    },
    {
      id: "packages",
      label: "Extensions",
      value: snapshot.packages ? packagePostureValue(snapshot.packages) : "unavailable",
      detail: postureDetail(packageIssues),
      tone: postureTone(packageIssues),
      sectionId: "packages",
    },
    {
      id: "integrations",
      label: "Integrations",
      value: integrationPostureValue(snapshot.adapters, snapshot.mcp),
      detail: postureDetail(integrationIssues),
      tone: postureTone(integrationIssues),
      sectionId: "integrations",
    },
    {
      id: "access",
      label: "Access",
      value: snapshot.administration ? accessPostureValue(snapshot.administration, snapshot.loadedAt) : "unavailable",
      detail: postureDetail(accessIssues),
      tone: postureTone(accessIssues),
      sectionId: "access",
    },
  ];
}

function surfaceSection(surface: OverviewSurface): GsvSectionId {
  if (surface === "runtime") return "runtime";
  if (surface === "devices") return "devices";
  if (surface === "packages") return "packages";
  if (surface === "administration") return "access";
  return "integrations";
}

function compareAttentionItems(left: OverviewAttentionItem, right: OverviewAttentionItem): number {
  return right.priority - left.priority || left.title.localeCompare(right.title);
}

function processState(process: ProcessEntry): string {
  return String(process.state ?? "unknown").trim().toLowerCase();
}

function isFailedProcess(process: ProcessEntry): boolean {
  return ["error", "failed", "crashed", "aborted", "blocked"].includes(processState(process));
}

function summarizeProcesses(processes: ProcessEntry[]): string {
  return processes.slice(0, 3).map((process) => String(process.label || process.pid || "unknown")).join(", ");
}

function summarizeDevices(devices: DeviceSummary[]): string {
  return devices.slice(0, 3).map((device) => device.label || device.description || device.deviceId).join(", ");
}

function summarizePackages(packages: PackageRecord[]): string {
  return packages.slice(0, 3).map((pkg) => pkg.name).join(", ");
}

function summarizeAdapterAccounts(accounts: Array<{ adapter: AdapterKind; account: AdapterAccount }>): string {
  return accounts.slice(0, 3).map(({ adapter, account }) => `${adapter}:${account.accountId}`).join(", ");
}

function summarizeMcpServers(servers: McpServer[]): string {
  return servers.slice(0, 3).map((server) => server.name).join(", ");
}

function activeTokens<T extends { revokedAt: number | null; expiresAt: number | null }>(tokens: T[], now: number): T[] {
  return tokens.filter((token) => {
    const expiresAt = normalizeTimestampMs(token.expiresAt);
    return token.revokedAt === null && (expiresAt === null || expiresAt > now);
  });
}

function tokenExpiresSoon(token: { expiresAt: number | null }, now: number): boolean {
  const expiresAt = normalizeTimestampMs(token.expiresAt);
  return expiresAt !== null && expiresAt - now <= EXPIRING_SOON_MS;
}

function normalizeTimestampMs(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return value < 100_000_000_000 ? value * 1000 : value;
}

function devicePostureValue(devices: DeviceSummary[]): string {
  const online = devices.filter((device) => device.online).length;
  return `${online}/${devices.length} online`;
}

function packagePostureValue(packages: PackagesState): string {
  return `${packages.counts.review} review, ${packages.counts.updates} updates`;
}

function integrationPostureValue(adapters: AdaptersState | null, mcp: McpState | null): string {
  if (!adapters && !mcp) return "unavailable";
  const adapterCount = adapters
    ? Object.values(adapters.statusByAdapter).reduce((total, accounts) => total + accounts.length, 0)
    : 0;
  const mcpCount = mcp?.servers.length ?? 0;
  return `${adapterCount} accounts, ${mcpCount} MCP`;
}

function accessPostureValue(administration: AdministrationState, now: number): string {
  const tokens = activeTokens(administration.tokens, now).length;
  return `${tokens} tokens, ${administration.links.length} links`;
}

function postureDetail(items: OverviewAttentionItem[]): string {
  if (items.length === 0) return "No attention items";
  const dangerCount = items.filter((item) => item.tone === "danger").length;
  if (dangerCount > 0) return `${dangerCount} urgent`;
  return `${items.length} need attention`;
}

function postureTone(items: OverviewAttentionItem[]): Tone {
  if (items.some((item) => item.tone === "danger")) return "danger";
  if (items.some((item) => item.tone === "warning")) return "warning";
  if (items.some((item) => item.tone === "accent")) return "accent";
  return "good";
}

function plural(count: number, singular: string, pluralLabel: string): string {
  return `${count} ${count === 1 ? singular : pluralLabel}`;
}
