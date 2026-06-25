import type {
  ConsoleMcpServer,
  ConsoleOverviewData,
  ConsolePackage,
  ConsoleTarget,
} from "../../gsv-console/domain/consoleModels";
import type {
  DesktopChildObject,
  DesktopGlyph,
  DesktopObject,
  DesktopObjectId,
  ShellAppRoute,
  ShellStatus,
} from "./shellModel";
import { isNativeWebPackageName } from "../../packages/nativePackages";
import {
  messengerFamilies,
  type MessengerFamily,
} from "../../gsv-console/messengers/messengerPresentation";

type DesktopObjectSpec = {
  id: DesktopObjectId;
  label: string;
  glyph: DesktopGlyph;
  singular: string;
  plural: string;
  x: number;
  y: number;
};

type DesktopObjectBranch = {
  id: DesktopObjectId;
  children: DesktopChildObject[];
};

type PackageBranchId = Extract<DesktopObjectId, "integrations" | "applications">;

type StatusSummary = {
  total: number;
  online: number;
  live: number;
  update: number;
  warn: number;
  error: number;
};

const SPECS: Record<DesktopObjectId, DesktopObjectSpec> = {
  machines: {
    id: "machines",
    label: "MACHINES",
    glyph: "machines",
    singular: "compute target",
    plural: "compute targets",
    x: 32,
    y: 28,
  },
  messengers: {
    id: "messengers",
    label: "MESSENGERS",
    glyph: "messengers",
    singular: "messenger",
    plural: "messengers",
    x: 67,
    y: 25,
  },
  integrations: {
    id: "integrations",
    label: "INTEGRATIONS",
    glyph: "integrations",
    singular: "MCP server",
    plural: "MCP servers",
    x: 26,
    y: 70,
  },
  applications: {
    id: "applications",
    label: "APPLICATIONS",
    glyph: "applications",
    singular: "web package",
    plural: "web packages",
    x: 72,
    y: 68,
  },
};

const BRANCH_ORDER: DesktopObjectId[] = ["machines", "messengers", "integrations", "applications"];
const KNOWN_TOKEN_LABELS: Record<string, string> = {
  discord: "Discord",
  gsv: "GSV",
  whatsapp: "WhatsApp",
};

export function buildDesktopObjectsFromConsole(data: ConsoleOverviewData | null | undefined): DesktopObject[] {
  const applicationChildren = classifyApplications(safeArray(data?.packages));
  const branches: Record<DesktopObjectId, DesktopObjectBranch> = {
    machines: {
      id: "machines",
      children: safeArray(data?.targets)
        .filter(isMachineTarget)
        .map(targetToChild)
        .sort(compareChildren),
    },
    messengers: {
      id: "messengers",
      children: messengerFamilies(safeArray(data?.adapters)).map(familyToChild),
    },
    integrations: {
      id: "integrations",
      children: safeArray(data?.mcpServers)
        .map(mcpServerToChild)
        .sort(compareChildren),
    },
    applications: {
      id: "applications",
      children: applicationChildren,
    },
  };

  return BRANCH_ORDER.map((id) => buildObject(branches[id]));
}

function buildObject(branch: DesktopObjectBranch): DesktopObject {
  const spec = SPECS[branch.id];
  const status = statusForChildren(branch.children);

  return {
    id: spec.id,
    label: spec.label,
    glyph: spec.glyph,
    meta: countLabel(branch.children.length, spec.singular, spec.plural),
    x: spec.x,
    y: spec.y,
    status,
    statusLabel: statusLabelForChildren(branch.children),
    children: branch.children,
  };
}

function targetToChild(target: ConsoleTarget): DesktopChildObject {
  const label = firstNonEmpty(target.label, target.deviceId, target.ownerUsername) ?? "Unnamed target";
  const platform = formatTokenLabel(target.platform);
  const online = target.online === true;
  const status: ShellStatus = online ? "online" : "idle";

  return {
    id: stableId("target", [target.deviceId], target.kind),
    label,
    type: targetTypeLabel(target, platform),
    blurb: targetBlurb(target),
    status,
    statusLabel: online ? "ONLINE" : "OFFLINE",
    glyph: "machines",
    route: {
      kind: "machines",
      detailId: target.deviceId,
    },
  };
}

function familyToChild(family: MessengerFamily): DesktopChildObject {
  return {
    id: stableId("messenger", [family.adapter], family.adapter),
    label: formatTokenLabel(family.adapter),
    type: "MESSENGER",
    blurb: familyBlurb(family),
    status: family.status.tone as ShellStatus,
    statusLabel: family.status.label,
    glyph: "messengers",
    route: {
      kind: "messengers",
      detailId: family.adapter,
    },
  };
}

function familyBlurb(family: MessengerFamily): string {
  switch (family.status.status) {
    case "not-enabled":
      return "Not enabled. Connect a bot to start messaging.";
    case "connected":
      return `${family.status.connectedCount} connected.`;
    case "disconnected":
      return "Disconnected.";
    case "attention":
      return family.status.tooltip ?? "Needs attention.";
    default:
      return "Messenger.";
  }
}

function packageToChild(pkg: ConsolePackage, branchId: PackageBranchId): DesktopChildObject {
  const status = packageStatus(pkg);

  return {
    id: stableId(branchId === "applications" ? "application" : "integration", [pkg.packageId], pkg.name),
    label: firstNonEmpty(pkg.name, pkg.packageId) ?? "Unnamed package",
    type: packageTypeLabel(pkg, branchId),
    blurb: packageBlurb(pkg),
    status: status.status,
    statusLabel: status.label,
    glyph: branchId,
    appRoute: branchId === "applications" ? appRouteForPackage(pkg) : undefined,
    route: {
      kind: branchId,
      detailId: pkg.packageId,
    },
  };
}

function mcpServerToChild(server: ConsoleMcpServer): DesktopChildObject {
  const status = mcpServerStatus(server);

  return {
    id: stableId("integration", [server.serverId], server.name),
    label: firstNonEmpty(server.name, server.serverId) ?? "Unnamed MCP server",
    type: "INTEGRATION · MCP",
    blurb: firstNonEmpty(
      server.error,
      server.url,
      `${server.tools.length} tool${server.tools.length === 1 ? "" : "s"} available.`,
      server.serverId,
    ) ?? "MCP server.",
    status: status.status,
    statusLabel: status.label,
    glyph: "integrations",
    route: {
      kind: "integrations",
      detailId: server.serverId,
    },
  };
}

function statusForChildren(children: readonly DesktopChildObject[]): ShellStatus {
  const summary = summarizeStatuses(children);
  if (summary.error > 0) {
    return "error";
  }
  if (summary.update > 0) {
    return "update";
  }
  if (summary.warn > 0) {
    return "warn";
  }
  if (summary.live > 0) {
    return "live";
  }
  if (summary.online > 0) {
    return "online";
  }
  return "idle";
}

function statusLabelForChildren(children: readonly DesktopChildObject[]): string {
  const summary = summarizeStatuses(children);
  if (summary.total === 0) {
    return "0 OBJECTS";
  }
  if (summary.error > 0) {
    return `${summary.error}/${summary.total} ERROR`;
  }
  if (summary.update > 0) {
    return `${summary.update}/${summary.total} REVIEW`;
  }
  if (summary.warn > 0) {
    return `${summary.warn}/${summary.total} WARN`;
  }
  if (summary.live > 0) {
    return `${summary.live}/${summary.total} LIVE`;
  }
  if (summary.online > 0) {
    return `${summary.online}/${summary.total} ONLINE`;
  }
  return `${summary.total} IDLE`;
}

function classifyApplications(packages: readonly ConsolePackage[]): DesktopChildObject[] {
  const children: DesktopChildObject[] = [];

  for (const pkg of packages) {
    if (isNativeConsolePackage(pkg)) {
      continue;
    }
    if (isApplicationPackage(pkg)) {
      children.push(packageToChild(pkg, "applications"));
    }
  }

  children.sort(compareChildren);
  return children;
}

function isMachineTarget(target: ConsoleTarget): boolean {
  return target.kind !== "adapter";
}

function isApplicationPackage(pkg: ConsolePackage): boolean {
  return pkg.runtime === "web-ui"
    || safeArray(pkg.uiEntrypoints).length > 0
    || safeArray(pkg.entrypoints).some((entrypoint) => firstNonEmpty(entrypoint.kind)?.toLowerCase() === "ui");
}

function isNativeConsolePackage(pkg: ConsolePackage): boolean {
  return isNativeWebPackageName(pkg.name) || isNativeWebPackageName(pkg.packageId);
}

function packageStatus(pkg: ConsolePackage): { status: ShellStatus; label: string } {
  if (pkg.reviewPending === true || (pkg.reviewRequired === true && pkg.reviewApprovedAt === null)) {
    return { status: "update", label: "REVIEW" };
  }
  if (pkg.enabled !== true) {
    return { status: "idle", label: "DISABLED" };
  }
  if (pkg.runtime === "unknown" && safeArray(pkg.entrypoints).length === 0) {
    return { status: "warn", label: "UNKNOWN" };
  }
  return { status: "online", label: "ENABLED" };
}

function mcpServerStatus(server: ConsoleMcpServer): { status: ShellStatus; label: string } {
  if (server.state === "failed" || firstNonEmpty(server.error)) {
    return { status: "error", label: "ERROR" };
  }
  if (server.state === "authenticating") {
    return { status: "warn", label: "SIGN-IN" };
  }
  if (server.state === "connecting" || server.state === "connected" || server.state === "discovering") {
    return { status: "warn", label: "CHECK" };
  }
  if (server.state === "ready") {
    return { status: "online", label: "READY" };
  }
  return { status: "idle", label: "IDLE" };
}

function appRouteForPackage(pkg: ConsolePackage): ShellAppRoute | undefined {
  const uiEntrypoints = safeArray(pkg.uiEntrypoints).filter((entrypoint) => entrypoint.route.trim().length > 0);
  if (pkg.runtime !== "web-ui" || pkg.enabled !== true || uiEntrypoints.length === 0) {
    return undefined;
  }

  return {
    appId: uiEntrypoints.length === 1 ? pkg.name : `${pkg.name}-${uiEntrypoints[0].name}`,
    suffix: "/",
    search: "",
    hash: "",
  };
}

function targetTypeLabel(target: ConsoleTarget, platform: string): string {
  if (target.kind === "browser") {
    return platform ? `BROWSER · ${platform.toUpperCase()}` : "BROWSER TARGET";
  }
  if (target.kind === "unknown") {
    return platform ? `TARGET · ${platform.toUpperCase()}` : "TARGET";
  }
  return platform ? `MACHINE · ${platform.toUpperCase()}` : "MACHINE";
}

function packageTypeLabel(pkg: ConsolePackage, branchId: PackageBranchId): string {
  const runtime = formatRuntime(pkg.runtime);
  if (branchId === "applications") {
    return runtime ? `APPLICATION · ${runtime}` : "APPLICATION";
  }
  return runtime ? `INTEGRATION · ${runtime}` : "INTEGRATION";
}

function targetBlurb(target: ConsoleTarget): string {
  const implementsLabel = joinNonEmpty(target.implements);
  return firstNonEmpty(
    target.description,
    implementsLabel,
    target.ownerUsername ? `Owned by ${target.ownerUsername}.` : "",
    target.version ? `Version ${target.version}.` : "",
  ) ?? "Execution target.";
}

function packageBlurb(pkg: ConsolePackage): string {
  const entrypointDescription = firstNonEmpty(...safeArray(pkg.entrypoints).map((entrypoint) => entrypoint.description));
  return firstNonEmpty(
    pkg.description,
    entrypointDescription,
    pkg.sourceRepo,
    joinNonEmpty(pkg.bindingNames),
    pkg.packageId,
  ) ?? "Package.";
}

function summarizeStatuses(children: readonly DesktopChildObject[]): StatusSummary {
  return children.reduce<StatusSummary>((summary, child) => {
    summary.total += 1;
    if (child.status === "online") summary.online += 1;
    if (child.status === "live") summary.live += 1;
    if (child.status === "update") summary.update += 1;
    if (child.status === "warn") summary.warn += 1;
    if (child.status === "error") summary.error += 1;
    return summary;
  }, {
    total: 0,
    online: 0,
    live: 0,
    update: 0,
    warn: 0,
    error: 0,
  });
}

function compareChildren(left: DesktopChildObject, right: DesktopChildObject): number {
  return statusRank(left.status) - statusRank(right.status)
    || left.label.localeCompare(right.label)
    || left.id.localeCompare(right.id);
}

function statusRank(status: ShellStatus): number {
  if (status === "error") return 0;
  if (status === "update") return 1;
  if (status === "warn") return 2;
  if (status === "live") return 3;
  if (status === "online") return 4;
  return 5;
}

function stableId(prefix: string, parts: readonly unknown[], fallback: unknown): string {
  const body = parts.map(normalizeIdPart).filter(Boolean).join(":") || normalizeIdPart(fallback) || "unknown";
  return `${prefix}:${body}`;
}

function normalizeIdPart(value: unknown): string {
  return firstNonEmpty(value)?.replace(/\s+/g, "-") ?? "";
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatRuntime(runtime: unknown): string {
  if (runtime === "web-ui") return "WEB UI";
  if (runtime === "dynamic-worker") return "WORKER";
  if (runtime === "node") return "NODE";
  return "";
}

function formatTokenLabel(value: unknown): string {
  const text = firstNonEmpty(value);
  if (!text) {
    return "";
  }

  const knownLabel = KNOWN_TOKEN_LABELS[text.toLowerCase()];
  if (knownLabel) {
    return knownLabel;
  }

  return text
    .split(/[-_\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function joinNonEmpty(values: readonly unknown[] | null | undefined): string {
  return safeArray(values).map((value) => firstNonEmpty(value)).filter((value): value is string => value !== null).join(", ");
}

function firstNonEmpty(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function safeArray<T>(value: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(value) ? value : [];
}
