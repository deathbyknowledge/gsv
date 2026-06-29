import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import type { KernelContext } from "../../../kernel/context";
import {
  getVisibleTarget,
  listVisibleTargets,
  type TargetDescriptor,
} from "../../../kernel/targets";
import { requireCommandCapability, requireShellOptionValue } from "./common";

type TargetListEntry = {
  id: string;
  provider: string;
  owner: string;
  label: string;
  description: string;
  platform: string;
  version: string;
  online: boolean;
  implements: string[];
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  connectedAt: number | null;
  disconnectedAt: number | null;
  metadataWritable: boolean;
  route: string;
};

type ListOptions = {
  includeOffline: boolean;
  json: boolean;
  limit: number;
  offset: number;
  query: string | null;
};

const DEFAULT_TARGET_LIMIT = 20;
const MAX_TARGET_LIMIT = 100;

export function buildTargetsCommands(ctx: KernelContext) {
  return [
    buildTargetsCommand(ctx, "targets"),
    buildTargetsCommand(ctx, "devices"),
  ];
}

function buildTargetsCommand(ctx: KernelContext, commandName: "targets" | "devices") {
  return defineCommand(commandName, async (args): Promise<ExecResult> => {
    try {
      return await runTargetsCommand(args, ctx, commandName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: "",
        stderr: `${commandName}: ${message}\n`,
        exitCode: 1,
      };
    }
  });
}

async function runTargetsCommand(
  args: string[],
  ctx: KernelContext,
  commandName: "targets" | "devices",
): Promise<ExecResult> {
  if (args.includes("--help") || args.includes("-h")) {
    return { stdout: targetsUsage(commandName), stderr: "", exitCode: 0 };
  }

  const [subcommand = "list", ...rest] = args;

  switch (subcommand) {
    case "help":
      return { stdout: targetsUsage(commandName), stderr: "", exitCode: 0 };
    case "list":
      return listTargets(parseTargetListOptions(rest), ctx);
    case "search":
      return listTargets(parseTargetListOptions(rest, true), ctx);
    case "show":
      return showTarget(rest, ctx, commandName);
    default:
      return listTargets(parseTargetListOptions(args), ctx);
  }
}

function listTargets(options: ListOptions, ctx: KernelContext): ExecResult {
  requireCommandCapability(ctx, "sys.device.list");

  const entries = [
    gsvTarget(ctx),
    ...listVisibleTargets(ctx, { includeOffline: options.includeOffline }).map(targetToEntry),
  ]
    .filter((entry) => options.includeOffline || entry.online)
    .filter((entry) => !options.query || targetMatchesQuery(entry, options.query))
    .sort((left, right) => {
      if (left.id === "gsv") return -1;
      if (right.id === "gsv") return 1;
      return left.id.localeCompare(right.id);
    });

  const page = entries.slice(options.offset, options.offset + options.limit);
  if (options.json) {
    return {
      stdout: `${JSON.stringify({
        targets: page,
        total: entries.length,
        limit: options.limit,
        offset: options.offset,
      }, null, 2)}\n`,
      stderr: "",
      exitCode: 0,
    };
  }

  const lines = ["TARGET\tPROVIDER\tSTATE\tPLATFORM\tCAPS\tLABEL"];
  for (const entry of page) {
    lines.push([
      entry.id,
      entry.provider,
      entry.online ? "online" : "offline",
      entry.platform || "-",
      summarizeCapabilities(entry.implements),
      entry.label || "-",
    ].join("\t"));
  }

  if (entries.length === 0) {
    lines.push("(none)");
  } else if (entries.length > page.length || options.offset > 0) {
    const start = entries.length === 0 ? 0 : options.offset + 1;
    const end = options.offset + page.length;
    lines.push(`Showing ${start}-${end} of ${entries.length}. Use --offset ${end} --limit ${options.limit} for more.`);
  }

  return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
}

function showTarget(args: string[], ctx: KernelContext, commandName: "targets" | "devices"): ExecResult {
  requireCommandCapability(ctx, "sys.device.get");

  const { targetId, json } = parseTargetShowOptions(args, commandName);
  const entry = targetId === "gsv"
    ? gsvTarget(ctx)
    : targetToEntryOrNull(getVisibleTarget(ctx, targetId, { includeOffline: true }));

  if (!entry) {
    return { stdout: "", stderr: `${commandName} show: target not found: ${targetId}\n`, exitCode: 1 };
  }

  if (json) {
    return { stdout: `${JSON.stringify(entry, null, 2)}\n`, stderr: "", exitCode: 0 };
  }

  const lines = [
    `target: ${entry.id}`,
    `provider: ${entry.provider}`,
    `state: ${entry.online ? "online" : "offline"}`,
    `owner: ${entry.owner}`,
    `platform: ${entry.platform || "-"}`,
    `version: ${entry.version || "-"}`,
    `label: ${entry.label || "-"}`,
    `description: ${entry.description || "-"}`,
    `route: ${entry.route}`,
    `metadata writable: ${entry.metadataWritable ? "yes" : "no"}`,
    `first seen: ${formatTimestamp(entry.firstSeenAt)}`,
    `last seen: ${formatTimestamp(entry.lastSeenAt)}`,
    `connected: ${formatTimestamp(entry.connectedAt)}`,
    `disconnected: ${formatTimestamp(entry.disconnectedAt)}`,
    "capabilities:",
    ...entry.implements.map((capability) => `- ${capability}`),
  ];
  return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
}

function parseTargetListOptions(args: string[], requireQuery = false): ListOptions {
  const options: ListOptions = {
    includeOffline: false,
    json: false,
    limit: DEFAULT_TARGET_LIMIT,
    offset: 0,
    query: null,
  };
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--json") {
      options.json = true;
      continue;
    }
    if (current === "--all") {
      options.includeOffline = true;
      continue;
    }
    if (current === "--online") {
      options.includeOffline = false;
      continue;
    }
    if (current === "--limit" || current === "-n") {
      index += 1;
      options.limit = parseLimit(requireShellOptionValue(args[index], current));
      continue;
    }
    if (current === "--offset") {
      index += 1;
      options.offset = parseNonNegativeInteger(requireShellOptionValue(args[index], current), current);
      continue;
    }
    if (current === "--search" || current === "-q") {
      index += 1;
      options.query = requireShellOptionValue(args[index], current).trim().toLowerCase();
      continue;
    }
    positional.push(current);
  }

  if (positional.length > 0) {
    options.query = positional.join(" ").trim().toLowerCase();
  }
  if (requireQuery && !options.query) {
    throw new Error("usage: targets search <query> [--all] [--limit N] [--offset N] [--json]");
  }
  return options;
}

function parseTargetShowOptions(
  args: string[],
  commandName: "targets" | "devices",
): { targetId: string; json: boolean } {
  let json = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    positional.push(arg);
  }
  if (positional.length !== 1) {
    throw new Error(`usage: ${commandName} show <target-id> [--json]`);
  }
  return { targetId: positional[0], json };
}

function parseLimit(value: string): number {
  const parsed = parseNonNegativeInteger(value, "--limit");
  if (parsed < 1) {
    throw new Error("--limit must be at least 1");
  }
  return Math.min(parsed, MAX_TARGET_LIMIT);
}

function parseNonNegativeInteger(value: string, option: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${option} must be a non-negative integer`);
  }
  return Number.parseInt(value, 10);
}

function targetMatchesQuery(entry: TargetListEntry, query: string): boolean {
  const haystack = [
    entry.id,
    entry.provider,
    entry.owner,
    entry.label,
    entry.description,
    entry.platform,
    entry.route,
    ...entry.implements,
  ].join("\n").toLowerCase();
  return haystack.includes(query);
}

function targetToEntryOrNull(target: TargetDescriptor | null): TargetListEntry | null {
  return target ? targetToEntry(target) : null;
}

function targetToEntry(target: TargetDescriptor): TargetListEntry {
  return {
    id: target.targetId,
    provider: target.providerId,
    owner: target.ownerUsername
      ? `${target.ownerUsername} (uid ${target.ownerUid})`
      : `uid ${target.ownerUid}`,
    label: target.label,
    description: target.description,
    platform: target.platform,
    version: target.version,
    online: target.online,
    implements: target.implements,
    firstSeenAt: target.firstSeenAt,
    lastSeenAt: target.lastSeenAt,
    connectedAt: target.connectedAt,
    disconnectedAt: target.disconnectedAt,
    metadataWritable: target.metadataWritable,
    route: target.route.kind === "connection"
      ? "connection"
      : `adapter-shell:${target.route.adapter}:${target.route.accountId}`,
  };
}

function gsvTarget(ctx: KernelContext): TargetListEntry {
  const now = Date.now();
  return {
    id: "gsv",
    provider: "kernel",
    owner: "system",
    label: "GSV",
    description: "Native GSV cloud target.",
    platform: "cloudflare-worker",
    version: ctx.config.get("config/server/version") ?? ctx.serverVersion ?? "",
    online: true,
    implements: ["fs.*", "shell.exec", "codemode.exec"],
    firstSeenAt: now,
    lastSeenAt: now,
    connectedAt: now,
    disconnectedAt: null,
    metadataWritable: false,
    route: "kernel",
  };
}

function summarizeCapabilities(capabilities: string[]): string {
  if (capabilities.length === 0) {
    return "-";
  }
  if (capabilities.length <= 3) {
    return capabilities.join(",");
  }
  return `${capabilities.slice(0, 3).join(",")}+${capabilities.length - 3}`;
}

function formatTimestamp(value: number | null): string {
  if (!value) {
    return "-";
  }
  return new Date(value).toISOString();
}

function targetsUsage(commandName: "targets" | "devices"): string {
  return [
    `Usage: ${commandName} list [--all] [--search QUERY] [--limit N] [--offset N] [--json]`,
    `Usage: ${commandName} search <query> [--all] [--limit N] [--offset N] [--json]`,
    `Usage: ${commandName} show <target-id> [--json]`,
    "",
    "Lists target ids available to this process. Use target ids with target-aware",
    "Shell, filesystem, CodeMode, and cp operations.",
  ].join("\n") + "\n";
}
