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
import type { SchedulerAddArgs, ScheduleExpression, ScheduleTarget } from "../../../syscalls/scheduler";
import { parseDurationMs, requireCommandCapability, requireShellOptionValue } from "./common";

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
      const lines = ["ID\tENABLED\tNEXT\tLAST\tERROR\tNAME\tTARGET"];
      for (const schedule of result.schedules) {
        lines.push([
          schedule.id,
          schedule.enabled ? "yes" : "no",
          schedule.state.nextRunAtMs === null ? "-" : new Date(schedule.state.nextRunAtMs).toISOString(),
          schedule.state.lastStatus ?? "-",
          formatScheduleListText(schedule.state.lastError),
          schedule.name,
          formatScheduleTarget(schedule.target),
        ].join("\t"));
      }
      return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
    }
    case "add": {
      requireCommandCapability(ctx, "sched.add");
      const parsed = parseSchedAddCommand(rest);
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

function parseSchedAddCommand(args: string[]): SchedulerAddArgs {
  let name: string | undefined;
  let description: string | undefined;
  let label: string | undefined;
  let profile: string | undefined;
  let timezone: string | undefined;
  let pid: string | undefined;
  let conversationId: string | undefined;
  let command: string | undefined;
  let cwd: string | undefined;
  let timeoutMs: number | undefined;
  let data: Record<string, unknown> | undefined;
  let expression: ScheduleExpression | undefined;
  let prompt: string | undefined;
  let enabled = true;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--json") {
      return JSON.parse(requireShellOptionValue(args[index + 1], current)) as SchedulerAddArgs;
    }
    if (current === "--name") {
      index += 1;
      name = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--description") {
      index += 1;
      description = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--label") {
      index += 1;
      label = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--command" || current === "-c") {
      index += 1;
      command = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--cwd") {
      index += 1;
      cwd = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--timeout") {
      index += 1;
      timeoutMs = parseDurationMs(requireShellOptionValue(args[index], current));
      continue;
    }
    if (current === "--profile") {
      index += 1;
      profile = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--timezone") {
      index += 1;
      timezone = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--pid") {
      index += 1;
      pid = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--conversation") {
      index += 1;
      conversationId = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--data-json") {
      index += 1;
      const parsed = JSON.parse(requireShellOptionValue(args[index], current));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("--data-json must be a JSON object");
      }
      data = parsed as Record<string, unknown>;
      continue;
    }
    if (current === "--prompt" || current === "--message") {
      index += 1;
      prompt = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--disabled") {
      enabled = false;
      continue;
    }
    if (current === "--every") {
      index += 1;
      expression = { kind: "every", everyMs: parseDurationMs(requireShellOptionValue(args[index], current)) };
      continue;
    }
    if (current === "--after") {
      index += 1;
      expression = { kind: "after", afterMs: parseDurationMs(requireShellOptionValue(args[index], current)) };
      continue;
    }
    if (current === "--at") {
      index += 1;
      expression = { kind: "at", atMs: parseScheduleAtMs(requireShellOptionValue(args[index], current)) };
      continue;
    }
    if (current === "--cron") {
      index += 1;
      expression = {
        kind: "cron",
        expr: requireShellOptionValue(args[index], current),
        timezone: timezone ?? "",
      };
      continue;
    }
    positional.push(current);
  }

  if (!name) {
    throw new Error("missing --name");
  }
  if (!expression) {
    throw new Error("missing schedule expression (--cron, --every, --after, or --at)");
  }
  if (expression.kind === "cron" && timezone !== undefined) {
    expression = { ...expression, timezone };
  }

  if (command !== undefined && (pid || profile || label || conversationId || data || prompt || positional.length > 0)) {
    throw new Error("--command cannot be combined with process target options or positional prompt text");
  }

  const message = prompt ?? positional.join(" ").trim();
  const target: ScheduleTarget = buildScheduleTarget({
    command,
    pid,
    conversationId,
    data,
    profile,
    label,
    cwd,
    timeoutMs,
    message,
  });

  return {
    name,
    ...(description ? { description } : {}),
    enabled,
    expression,
    target,
  };
}

function buildScheduleTarget(input: {
  command?: string;
  pid?: string;
  conversationId?: string;
  data?: Record<string, unknown>;
  profile?: string;
  label?: string;
  cwd?: string;
  timeoutMs?: number;
  message: string;
}): ScheduleTarget {
  if (input.command !== undefined) {
    const command = input.command.trim();
    if (!command) {
      throw new Error("missing command");
    }
    return {
      kind: "command.exec",
      command,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    };
  }

  if (!input.message) {
    throw new Error("missing command/prompt/message");
  }

  if (input.pid) {
    return {
      kind: "process.event",
      pid: input.pid,
      message: input.message,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.data ? { data: input.data } : {}),
    };
  }

  return {
    kind: "command.exec",
    command: buildProcSpawnCommand(input),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  };
}

function buildProcSpawnCommand(input: {
  profile?: string;
  label?: string;
  cwd?: string;
  message: string;
}): string {
  return [
    "proc",
    "spawn",
    "--profile",
    quoteShellArg(input.profile ?? "cron"),
    ...(input.label ? ["--label", quoteShellArg(input.label)] : []),
    ...(input.cwd ? ["--cwd", quoteShellArg(input.cwd)] : []),
    quoteShellArg(input.message),
  ].join(" ");
}

function parseScheduleAtMs(value: string): number {
  if (/^\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid --at value: ${value}`);
  }
  return parsed;
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
    return `spawn:${target.profile ?? "cron"}`;
  }
  return `event:${target.pid}`;
}

function quoteShellArg(value: string): string {
  return JSON.stringify(value);
}

function formatScheduleListText(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  return value.replace(/[\t\r\n]+/g, " ").slice(0, 120);
}

function schedUsage(): string {
  return [
    "Usage:",
    "  sched list [--all]",
    "  sched add --name NAME (--cron EXPR [--timezone TZ] | --every DURATION | --after DURATION | --at TIME) [--command COMMAND] [--cwd PATH] [--timeout DURATION]",
    "  sched add --name NAME (--cron EXPR [--timezone TZ] | --every DURATION | --after DURATION | --at TIME) [--profile PROFILE] [--label LABEL] [--cwd PATH] <prompt>",
    "  sched add --name NAME (--cron EXPR [--timezone TZ] | --every DURATION | --after DURATION | --at TIME) --pid PID [--conversation id] <message>",
    "  sched add --json JSON",
    "  sched enable <id>",
    "  sched disable <id>",
    "  sched remove <id>",
    "  sched run <id> [--force]",
    "",
    "Without --pid, prompt text is stored as a command that runs proc spawn.",
    "Use --command for an explicit shell command. With --pid, sched add keeps",
    "the legacy process-event target for compatibility.",
    "",
  ].join("\n");
}
