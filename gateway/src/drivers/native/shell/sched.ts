import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import { resolveCallerOwnerUid, type KernelContext } from "../../../kernel/context";
import {
  handleSchedulerAdd,
  handleSchedulerList,
  handleSchedulerRemove,
  handleSchedulerRun,
  handleSchedulerUpdate,
} from "../../../kernel/scheduler";
import { jsonObjectSchema } from "@humansandmachines/gsv/protocol";
import type { SchedulerAddArgs, ScheduleTarget } from "@humansandmachines/gsv/protocol";
import { parseDurationMs, requireCommandCapability, requireShellOptionValue } from "./common";
import { resolveVisibleAdapterMessageDestination } from "../../../kernel/adapter-destinations";
import * as z from "zod/mini";

const ISO_TIMESTAMP_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

const adapterDestinationSchema = z.strictObject({
  kind: z.literal("adapter"),
  adapter: z.string(),
  accountId: z.string(),
  surface: z.strictObject({
    kind: z.enum(["dm", "group", "channel", "thread"]),
    id: z.string(),
    name: z.optional(z.string()),
    handle: z.optional(z.string()),
    threadId: z.optional(z.string()),
  }),
  actorId: z.string(),
});
const responsibilityPrioritySchema = z.enum(["low", "normal", "high", "critical"]);
const scheduleTargetSchema = z.union([
  z.strictObject({ kind: z.literal("command.exec"), command: z.string(), cwd: z.optional(z.string()), timeoutMs: z.optional(z.number()) }),
  z.strictObject({ kind: z.literal("process.spawn"), runAs: z.optional(z.string()), label: z.optional(z.string()), prompt: z.string(), parentPid: z.optional(z.string()), cwd: z.optional(z.string()) }),
  z.strictObject({ kind: z.literal("process.event"), pid: z.string(), message: z.string(), data: z.optional(jsonObjectSchema), replyTo: z.optional(adapterDestinationSchema) }),
  z.strictObject({ kind: z.literal("responsibility"), message: z.string(), data: z.optional(jsonObjectSchema), priority: z.optional(responsibilityPrioritySchema) }),
  z.strictObject({ kind: z.literal("adapter.send"), destination: adapterDestinationSchema, text: z.string() }),
]);
const scheduleExpressionSchema = z.union([
  z.strictObject({ kind: z.literal("at"), atMs: z.number() }),
  z.strictObject({ kind: z.literal("after"), afterMs: z.number() }),
  z.strictObject({ kind: z.literal("every"), everyMs: z.number(), anchorMs: z.optional(z.number()) }),
  z.strictObject({ kind: z.literal("cron"), expr: z.string(), timezone: z.string() }),
]);
const schedulerAddArgsSchema = z.strictObject({
  name: z.string(),
  description: z.optional(z.string()),
  enabled: z.optional(z.boolean()),
  expression: scheduleExpressionSchema,
  target: scheduleTargetSchema,
});

export function buildSchedCommand(ctx: KernelContext) {
  return defineCommand("sched", async (args): Promise<ExecResult> => {
    try {
      return await runSchedCommand(args, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: "",
        stderr: `sched: ${message}\n`,
        exitCode: 1,
      };
    }
  });
}

async function runSchedCommand(args: string[], ctx: KernelContext): Promise<ExecResult> {
  const [subcommand = "help", ...rest] = args;

  switch (subcommand) {
    case "help":
    case "--help":
    case "-h":
      return { stdout: schedUsage(), stderr: "", exitCode: 0 };
    case "list": {
      requireCommandCapability(ctx, "sched.list");
      const result = handleSchedulerList({ includeDisabled: rest.includes("--all") }, ctx);
      const lines = ["ID\tENABLED\tNEXT\tLAST\tERROR\tSOURCE\tNAME\tTARGET"];
      for (const schedule of result.schedules) {
        lines.push([
          schedule.id,
          schedule.enabled ? "yes" : "no",
          schedule.state.nextRunAtMs === null ? "-" : new Date(schedule.state.nextRunAtMs).toISOString(),
          schedule.state.lastStatus ?? "-",
          formatScheduleListText(schedule.state.lastError),
          formatScheduleSource(schedule.description),
          schedule.name,
          formatScheduleTarget(schedule.target),
        ].join("\t"));
      }
      return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
    }
    case "add": {
      requireCommandCapability(ctx, "sched.add");
      const parsed = await parseSchedAddCommand(rest, ctx);
      const result = await handleSchedulerAdd(parsed, ctx);
      return {
        stdout: `schedule_id=${result.schedule.id} next=${result.schedule.state.nextRunAtMs === null ? "-" : new Date(result.schedule.state.nextRunAtMs).toISOString()}\n`,
        stderr: "",
        exitCode: 0,
      };
    }
    case "remove": {
      requireCommandCapability(ctx, "sched.remove");
      const id = requireSchedId(rest[0]);
      const result = await handleSchedulerRemove({ id }, ctx);
      return { stdout: `removed=${result.removed}\n`, stderr: "", exitCode: result.removed ? 0 : 1 };
    }
    case "enable":
    case "disable": {
      requireCommandCapability(ctx, "sched.update");
      const id = requireSchedId(rest[0]);
      const result = await handleSchedulerUpdate({
        id,
        patch: { enabled: subcommand === "enable" },
      }, ctx);
      return {
        stdout: `schedule_id=${result.schedule.id} enabled=${result.schedule.enabled}\n`,
        stderr: "",
        exitCode: 0,
      };
    }
    case "run": {
      requireCommandCapability(ctx, "sched.run");
      const id = requireSchedId(rest[0]);
      const force = rest.includes("--force");
      const result = await handleSchedulerRun({ id, mode: force ? "force" : "due" }, ctx);
      return {
        stdout: JSON.stringify(result) + "\n",
        stderr: "",
        exitCode: result.results.some((item) => item.status === "error") ? 1 : 0,
      };
    }
    default:
      return { stdout: "", stderr: `sched: unknown command: ${subcommand}\n${schedUsage()}`, exitCode: 1 };
  }
}

async function parseSchedAddCommand(args: string[], ctx: KernelContext): Promise<SchedulerAddArgs> {
  if (args[0] === "--json") {
    if (args.length !== 2) {
      throw new Error("--json must be the only sched add option");
    }
    const parsed = JSON.parse(requireShellOptionValue(args[1], "--json"));
    return schedulerAddArgsSchema.parse(parsed);
  }

  let here = false;
  let to: string | undefined;
  let name: string | undefined;
  let message: string | undefined;
  let timezone: string | undefined;
  const expressions: SchedulerAddArgs["expression"][] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--here") {
      if (here) {
        throw new Error("--here may only be specified once");
      }
      here = true;
      continue;
    }
    if (current === "--to") {
      if (to !== undefined) {
        throw new Error("--to may only be specified once");
      }
      index += 1;
      to = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--name") {
      if (name !== undefined) {
        throw new Error("--name may only be specified once");
      }
      index += 1;
      name = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--message") {
      if (message !== undefined) {
        throw new Error("--message may only be specified once");
      }
      index += 1;
      message = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--timezone") {
      if (timezone !== undefined) {
        throw new Error("--timezone may only be specified once");
      }
      index += 1;
      timezone = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--every") {
      index += 1;
      expressions.push({
        kind: "every",
        everyMs: parseDurationMs(requireShellOptionValue(args[index], current)),
      });
      continue;
    }
    if (current === "--after") {
      index += 1;
      expressions.push({
        kind: "after",
        afterMs: parseDurationMs(requireShellOptionValue(args[index], current)),
      });
      continue;
    }
    if (current === "--at") {
      index += 1;
      const value = requireShellOptionValue(args[index], current);
      if (!ISO_TIMESTAMP_WITH_ZONE.test(value)) {
        throw new Error(`--at requires an ISO timestamp with Z or a UTC offset: ${value}`);
      }
      const atMs = Date.parse(value);
      if (!Number.isFinite(atMs)) {
        throw new Error(`invalid ISO timestamp: ${value}`);
      }
      expressions.push({ kind: "at", atMs });
      continue;
    }
    if (current === "--cron") {
      index += 1;
      expressions.push({
        kind: "cron",
        expr: requireShellOptionValue(args[index], current),
        timezone: "",
      });
      continue;
    }
    throw new Error(`unexpected argument: ${current}`);
  }

  if (here === (to !== undefined)) {
    throw new Error("sched add requires exactly one of --here or --to DESTINATION");
  }
  if (here && !ctx.processId) {
    throw new Error("sched add --here requires a process caller");
  }
  if (expressions.length !== 1) {
    throw new Error("sched add requires exactly one of --every, --cron, --after, or --at");
  }
  const expression = expressions[0];
  if (timezone !== undefined && expression.kind !== "cron") {
    throw new Error("--timezone is only valid with --cron");
  }
  if (expression.kind === "cron" && timezone !== undefined) {
    expression.timezone = timezone;
  }
  if (name === undefined) {
    throw new Error("sched add requires --name");
  }
  if (message === undefined) {
    throw new Error("sched add requires --message");
  }

  if (to !== undefined) {
    requireCommandCapability(ctx, "adapter.send");
    const destination = (await resolveVisibleAdapterMessageDestination(to, ctx, {
      includeOffline: true,
    })).destination;
    return {
      name,
      expression,
      target: {
        kind: "adapter.send",
        destination,
        text: message,
      },
    };
  }

  const currentProcessId = ctx.processId!;
  const caller = ctx.procs.get(currentProcessId);
  if (!caller) {
    throw new Error(`current process not found: ${currentProcessId}`);
  }
  const ipcCall = ctx.processRunId
    ? ctx.ipcCalls.findPendingByTargetRun({
        uid: resolveCallerOwnerUid(ctx),
        targetPid: currentProcessId,
        targetRunId: ctx.processRunId,
      })
    : null;
  const processId = ipcCall?.sourcePid ?? currentProcessId;
  const routeRunId = ipcCall ? ipcCall.sourceRunId : ctx.processRunId;
  const route = routeRunId ? ctx.runRoutes.get(routeRunId) : null;
  const replyTo = route?.kind === "adapter" && route.processId === processId
    ? route.destination
    : undefined;
  const targetProcess = ctx.procs.get(processId);
  if (!targetProcess) {
    throw new Error(`target process not found: ${processId}`);
  }
  const target: ScheduleTarget = targetProcess.isPersonalController && !replyTo
    ? { kind: "responsibility", message }
    : replyTo
      ? { kind: "process.event", pid: processId, message, replyTo }
      : { kind: "process.event", pid: processId, message };
  return {
    name,
    expression,
    target,
  };
}

function requireSchedId(value: string | undefined): string {
  if (!value || value.trim().length === 0 || value.startsWith("--")) {
    throw new Error("missing schedule id");
  }
  return value.trim();
}

function formatScheduleTarget(target: ScheduleTarget): string {
  if (target.kind === "command.exec") {
    return `cmd:${formatScheduleListText(target.command)}`;
  }
  if (target.kind === "process.spawn") {
    return `spawn:${target.runAs ?? "personal-agent"}`;
  }
  if (target.kind === "adapter.send") {
    return `message:${target.destination.adapter}`;
  }
  if (target.kind === "responsibility") {
    return "r12y:ship";
  }
  return `event:${target.pid}`;
}

function formatScheduleListText(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  return value.replace(/[\t\r\n]+/g, " ").slice(0, 120);
}

function formatScheduleSource(description: string | null | undefined): string {
  const prefix = "Installed from ";
  if (description?.startsWith(prefix)) {
    return `crontab:${formatScheduleListText(description.slice(prefix.length))}`;
  }
  return "-";
}

function schedUsage(): string {
  return [
    "Usage:",
    "  sched list [--all]",
    "  sched add --here --name NAME (--every DURATION | --cron EXPR [--timezone ZONE] | --after DURATION | --at ISO_TIMESTAMP) --message MESSAGE",
    "  sched add --to DESTINATION --name NAME (--every DURATION | --cron EXPR [--timezone ZONE] | --after DURATION | --at ISO_TIMESTAMP) --message MESSAGE",
    "  sched add --json JSON",
    "  sched enable <id>",
    "  sched disable <id>",
    "  sched remove <id>",
    "  sched run <id> [--force]",
    "",
    "Use --here to wake this process, or its caller during delegated work, and reply on the current surface.",
    "Use --to for a direct scheduled message to an authorized adapter destination.",
    "--at requires a future ISO timestamp with Z or an explicit numeric UTC offset.",
    "Use crontab -l, crontab FILE, crontab -r, or /var/spool/cron/<user>",
    "for scheduled shell commands. --json exposes the low-level schedule contract.",
    "--all includes disabled schedules, not other users' schedules.",
    "Crontab-backed schedule ids are regenerated when the crontab is reinstalled.",
    "",
  ].join("\n");
}
