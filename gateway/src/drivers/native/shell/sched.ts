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
import type { SchedulerAddArgs, ScheduleTarget } from "../../../syscalls/scheduler";
import { requireCommandCapability, requireShellOptionValue } from "./common";

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
  if (args[0] !== "--json") {
    throw new Error("sched add is a low-level compatibility command; use crontab FILE or sched add --json JSON");
  }
  return JSON.parse(requireShellOptionValue(args[1], "--json")) as SchedulerAddArgs;
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
  return `event:${target.pid}`;
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
    "  sched add --json JSON",
    "  sched enable <id>",
    "  sched disable <id>",
    "  sched remove <id>",
    "  sched run <id> [--force]",
    "",
    "Use crontab -l, crontab FILE, crontab -r, or /var/spool/cron/<user>",
    "for normal scheduled jobs. sched is the lower-level schedule inspector.",
    "",
  ].join("\n");
}
