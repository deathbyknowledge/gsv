import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import type {
  ResponsibilityCreateArgs,
  ResponsibilityPatch,
  ResponsibilityRecord,
  ResponsibilityState,
} from "@humansandmachines/gsv/protocol";
import { jsonObjectSchema } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../../../kernel/context";
import {
  handleResponsibilityCreate,
  handleResponsibilityGet,
  handleResponsibilityList,
  handleResponsibilitySourceList,
  handleResponsibilitySourceUpdate,
  handleResponsibilityUpdate,
} from "../../../kernel/responsibilities";
import { requireCommandCapability, requireShellOptionValue } from "./common";
import * as z from "zod/mini";

const prioritySchema = z.enum(["low", "normal", "high", "critical"]);
const stateSchema = z.enum(["open", "active", "waiting", "resolved", "cancelled"]);
const assigneeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ship") }),
  z.strictObject({ kind: z.literal("process"), processId: z.string() }),
]);
const audienceSchema = z.strictObject({ conversationIds: z.array(z.string()) });
const responsibilityPatchSchema = z.strictObject({
  title: z.optional(z.string()),
  details: z.optional(z.nullable(jsonObjectSchema)),
  parentId: z.optional(z.nullable(z.string())),
  audience: z.optional(z.nullable(audienceSchema)),
  assignee: z.optional(assigneeSchema),
  state: z.optional(stateSchema),
  priority: z.optional(prioritySchema),
  dueAtMs: z.optional(z.nullable(z.number())),
  nextCheckAtMs: z.optional(z.nullable(z.number())),
  blocker: z.optional(z.nullable(z.string())),
  leaseExpiresAtMs: z.optional(z.nullable(z.number())),
  resolution: z.optional(z.nullable(jsonObjectSchema)),
});

export function buildR12yCommand(ctx: KernelContext) {
  return defineCommand("r12y", async (args): Promise<ExecResult> => {
    try {
      return await runR12yCommand(args, ctx);
    } catch (error) {
      return {
        stdout: "",
        stderr: `r12y: ${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      };
    }
  });
}

async function runR12yCommand(args: string[], ctx: KernelContext): Promise<ExecResult> {
  const [subcommand = "help", ...rest] = args;
  switch (subcommand) {
    case "help":
    case "--help":
    case "-h":
      return result(r12yUsage());
    case "list": {
      requireCommandCapability(ctx, "r12y.list");
      const unexpected = rest.find((argument) => argument !== "--all" && argument !== "--json");
      if (unexpected) throw new Error(`unexpected list option: ${unexpected}`);
      const outputJson = rest.includes("--json");
      const listed = handleResponsibilityList({
        includeTerminal: rest.includes("--all"),
      }, ctx);
      return result(outputJson
        ? `${JSON.stringify(listed)}\n`
        : renderResponsibilityList(listed.responsibilities, listed.revision));
    }
    case "show": {
      requireCommandCapability(ctx, "r12y.get");
      requireArgumentCount(rest, 1, "show requires: r12y show ID");
      const shown = handleResponsibilityGet({ id: requireId(rest[0]) }, ctx);
      return result(`${JSON.stringify(shown)}\n`);
    }
    case "sources": {
      requireCommandCapability(ctx, "r12y.source.list");
      requireArgumentCount(rest, 0, "sources accepts no arguments");
      const { sources } = handleResponsibilitySourceList({}, ctx);
      return result(`${["ID\tSTATUS\tCONTROL\tNAME\tDESCRIPTION", ...sources.map((source) => [
        source.id,
        source.enabled ? "enabled" : "disabled",
        source.control === "required" ? "always-on" : "configurable",
        source.name,
        source.description,
      ].join("\t"))].join("\n")}\n`);
    }
    case "source": {
      requireCommandCapability(ctx, "r12y.source.update");
      requireArgumentCount(rest, 2, "source requires: r12y source enable|disable ID");
      const enabled = rest[0] === "enable"
        ? true
        : rest[0] === "disable"
          ? false
          : null;
      if (enabled === null) throw new Error("source action must be enable or disable");
      const updated = handleResponsibilitySourceUpdate({
        id: requireSourceId(rest[1]),
        enabled,
      }, ctx);
      return result(`${JSON.stringify(updated)}\n`);
    }
    case "create": {
      requireCommandCapability(ctx, "r12y.create");
      const created = await handleResponsibilityCreate(parseCreate(rest), ctx);
      return result(`${JSON.stringify(created)}\n`);
    }
    case "update": {
      requireCommandCapability(ctx, "r12y.update");
      const id = requireId(rest[0]);
      if (rest[1] !== "--json" || rest.length !== 3) {
        throw new Error("update requires: r12y update ID --json PATCH");
      }
      const patch = responsibilityPatchSchema.parse(JSON.parse(rest[2]));
      const updated = await handleResponsibilityUpdate({ id, patch }, ctx);
      return result(`${JSON.stringify(updated)}\n`);
    }
    case "start":
      requireArgumentCount(rest, 1, "start requires: r12y start ID");
      return await updateState(rest, "active", ctx);
    case "resolve":
      return await updateTerminal(rest, "resolved", ctx);
    case "cancel":
      return await updateTerminal(rest, "cancelled", ctx);
    case "wait":
      return await waitResponsibility(rest, ctx);
    case "delegate":
      return await delegateResponsibility(rest, ctx);
    default:
      return {
        stdout: "",
        stderr: `r12y: unknown command: ${subcommand}\n${r12yUsage()}`,
        exitCode: 1,
      };
  }
}

function parseCreate(args: string[]): ResponsibilityCreateArgs {
  const input: ResponsibilityCreateArgs = { title: "" };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    index += 1;
    const value = requireShellOptionValue(args[index], option);
    switch (option) {
      case "--title":
        input.title = value;
        break;
      case "--details":
        input.details = jsonObjectSchema.parse(JSON.parse(value));
        break;
      case "--parent":
        input.parentId = value;
        break;
      case "--process":
        input.assignee = { kind: "process", processId: value };
        break;
      case "--priority":
        input.priority = prioritySchema.parse(value);
        break;
      case "--due":
        input.dueAtMs = parseTimestamp(value, option);
        break;
      case "--check":
        input.nextCheckAtMs = parseTimestamp(value, option);
        break;
      case "--blocker":
        input.blocker = value;
        break;
      case "--dedupe":
        input.dedupeKey = value;
        break;
      default:
        throw new Error(`unexpected create option: ${option}`);
    }
  }
  if (!input.title) throw new Error("create requires --title TITLE");
  return input;
}

async function updateState(
  args: string[],
  state: ResponsibilityState,
  ctx: KernelContext,
): Promise<ExecResult> {
  requireCommandCapability(ctx, "r12y.update");
  const updated = await handleResponsibilityUpdate({
    id: requireId(args[0]),
    patch: { state },
  }, ctx);
  return result(`${JSON.stringify(updated)}\n`);
}

async function updateTerminal(
  args: string[],
  state: "resolved" | "cancelled",
  ctx: KernelContext,
): Promise<ExecResult> {
  requireCommandCapability(ctx, "r12y.update");
  const id = requireId(args[0]);
  let resolution: ResponsibilityPatch["resolution"];
  if (args.length > 1) {
    if (args[1] !== "--json" || args.length !== 3) {
      throw new Error(`${state} accepts only: --json RESOLUTION`);
    }
    resolution = jsonObjectSchema.parse(JSON.parse(args[2]));
  }
  const patch: ResponsibilityPatch = { state };
  if (resolution) patch.resolution = resolution;
  const updated = await handleResponsibilityUpdate({ id, patch }, ctx);
  return result(`${JSON.stringify(updated)}\n`);
}

async function waitResponsibility(args: string[], ctx: KernelContext): Promise<ExecResult> {
  requireCommandCapability(ctx, "r12y.update");
  const id = requireId(args[0]);
  const patch: ResponsibilityPatch = { state: "waiting" };
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    index += 1;
    const value = requireShellOptionValue(args[index], option);
    if (option === "--until") patch.nextCheckAtMs = parseTimestamp(value, option);
    else if (option === "--blocker") patch.blocker = value;
    else throw new Error(`unexpected wait option: ${option}`);
  }
  if (patch.nextCheckAtMs === undefined && patch.blocker === undefined) {
    throw new Error("wait requires --until ISO or --blocker TEXT");
  }
  const updated = await handleResponsibilityUpdate({ id, patch }, ctx);
  return result(`${JSON.stringify(updated)}\n`);
}

async function delegateResponsibility(args: string[], ctx: KernelContext): Promise<ExecResult> {
  requireCommandCapability(ctx, "r12y.update");
  if (args.length !== 4 || args[2] !== "--until") {
    throw new Error("delegate requires: r12y delegate ID PID --until ISO");
  }
  const updated = await handleResponsibilityUpdate({
    id: requireId(args[0]),
    patch: {
      state: "active",
      assignee: { kind: "process", processId: requireProcessId(args[1]) },
      leaseExpiresAtMs: parseTimestamp(args[3], "--until"),
    },
  }, ctx);
  return result(`${JSON.stringify(updated)}\n`);
}

function renderResponsibilityList(records: ResponsibilityRecord[], revision: number): string {
  const lines = [`REVISION\t${revision}`, "ID\tSTATE\tPRIORITY\tASSIGNEE\tDUE\tTITLE"];
  for (const record of records) {
    lines.push([
      record.id,
      record.state,
      record.priority,
      record.assignee.kind === "ship" ? "ship" : record.assignee.processId,
      record.dueAtMs === undefined ? "-" : new Date(record.dueAtMs).toISOString(),
      record.title.replace(/[\t\r\n]+/g, " "),
    ].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

function parseTimestamp(value: string, option: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${option} requires an ISO timestamp`);
  }
  return timestamp;
}

function requireId(value: string | undefined): string {
  if (!value || value.startsWith("--")) throw new Error("missing responsibility id");
  return value;
}

function requireProcessId(value: string | undefined): string {
  if (!value || !value.startsWith("proc:")) throw new Error("missing process id");
  return value;
}

function requireSourceId(
  value: string | undefined,
): "mail.received" | "federation.received" {
  if (value !== "mail.received" && value !== "federation.received") {
    throw new Error(`unknown responsibility source: ${value ?? ""}`);
  }
  return value;
}

function requireArgumentCount(args: string[], count: number, message: string): void {
  if (args.length !== count) throw new Error(message);
}

function result(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function r12yUsage(): string {
  return [
    "Usage:",
    "  r12y list [--all] [--json]",
    "  r12y show ID",
    "  r12y sources",
    "  r12y source enable|disable SOURCE_ID",
    "  r12y create --title TITLE [--details JSON] [--parent ID] [--process PID] [--priority PRIORITY] [--due ISO] [--check ISO] [--blocker TEXT] [--dedupe KEY]",
    "  r12y update ID --json PATCH",
    "  r12y start ID",
    "  r12y wait ID [--until ISO] [--blocker TEXT]",
    "  r12y delegate ID PID --until ISO",
    "  r12y resolve ID [--json RESOLUTION]",
    "  r12y cancel ID [--json RESOLUTION]",
    "",
    "Responsibilities are durable unresolved work owned by the Kernel.",
    "Use list/show to inspect the ledger and update it whenever work changes state.",
    "",
  ].join("\n");
}
