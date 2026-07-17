import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import type { KernelContext } from "../../../kernel/context";
import {
  handleSchedulerAdd,
  handleSchedulerList,
  handleSchedulerRemove,
  handleSchedulerRun,
  handleSchedulerUpdate,
} from "../../../kernel/scheduler";
import type { SchedulerAddArgs, ScheduleTarget } from "@humansandmachines/gsv/protocol";
import { parseDurationMs, requireCommandCapability, requireShellOptionValue } from "./common";
import { resolveVisibleAdapterMessageDestination } from "../../../kernel/adapter-destinations";

const ISO_TIMESTAMP_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

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
    return JSON.parse(requireShellOptionValue(args[1], "--json")) as SchedulerAddArgs;
  }

  let here = false;
  let to: string | undefined;
  let name: string | undefined;
  let message: string | undefined;
  let conversationId: string | undefined;
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
    if (current === "--conversation") {
      if (conversationId !== undefined) {
        throw new Error("--conversation may only be specified once");
      }
      index += 1;
      conversationId = requireShellOptionValue(args[index], current);
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
    if (conversationId !== undefined) {
      throw new Error("--conversation is only valid with --here");
    }
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

  const processId = ctx.processId!;
  const caller = ctx.procs.get(processId);
  if (!caller) {
    throw new Error(`current process not found: ${processId}`);
  }
  const route = ctx.processRunId ? ctx.runRoutes.get(ctx.processRunId) : null;
  const replyTo = route?.kind === "adapter" && route.processId === processId
    ? route.destination
    : undefined;
  const targetConversationId = conversationId ?? caller.activeConversationId ?? "default";
  return {
    name,
    expression,
    target: {
      kind: "process.event",
      pid: processId,
      conversationId: targetConversationId,
      message,
      ...(replyTo ? { replyTo } : {}),
    },
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
    "  sched add --here --name NAME (--every DURATION | --cron EXPR [--timezone ZONE] | --after DURATION | --at ISO_TIMESTAMP) --message MESSAGE [--conversation ID]",
    "  sched add --to DESTINATION --name NAME (--every DURATION | --cron EXPR [--timezone ZONE] | --after DURATION | --at ISO_TIMESTAMP) --message MESSAGE",
    "  sched add --json JSON",
    "  sched enable <id>",
    "  sched disable <id>",
    "  sched remove <id>",
    "  sched run <id> [--force]",
    "",
    "Use --here to wake this process and automatically reply on the current surface.",
    "Use --to for a direct scheduled message to an authorized adapter destination.",
    "--at requires a future ISO timestamp with Z or an explicit numeric UTC offset.",
    "Use crontab -l, crontab FILE, crontab -r, or /var/spool/cron/<user>",
    "for scheduled shell commands. --json exposes the low-level schedule contract.",
    "--all includes disabled schedules, not other users' schedules.",
    "Crontab-backed schedule ids are regenerated when the crontab is reinstalled.",
    "",
  ].join("\n");
}
