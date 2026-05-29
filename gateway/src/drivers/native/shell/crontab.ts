import { defineCommand, type CommandContext } from "just-bash";
import type { ExecResult } from "just-bash";
import { GsvFs } from "../../../fs/gsv-fs";
import { createCronFileService } from "../../../kernel/crontab";
import type { KernelContext } from "../../../kernel/context";
import { requireCommandCapability } from "./common";

export function buildCrontabCommand(fs: GsvFs, ctx: KernelContext) {
  return defineCommand("crontab", async (args, commandCtx): Promise<ExecResult> => {
    try {
      return await runCrontabCommand(args, commandCtx, fs, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: "",
        stderr: `crontab: ${message}\n`,
        exitCode: 1,
      };
    }
  });
}

async function runCrontabCommand(
  args: string[],
  commandCtx: CommandContext,
  fs: GsvFs,
  ctx: KernelContext,
): Promise<ExecResult> {
  const parsed = parseCrontabArgs(args, ctx);
  const service = createCronFileService(ctx);

  if (parsed.help) {
    return { stdout: crontabUsage(), stderr: "", exitCode: 0 };
  }

  if (parsed.action === "list") {
    requireCommandCapability(ctx, "sched.list");
    const content = service.readUserCrontab(parsed.username);
    if (content === undefined) {
      return { stdout: "", stderr: `no crontab for ${parsed.username}\n`, exitCode: 1 };
    }
    return { stdout: content, stderr: "", exitCode: 0 };
  }

  if (parsed.action === "remove") {
    requireCommandCapability(ctx, "sched.remove");
    const removed = await service.removeUserCrontab(parsed.username);
    if (!removed) {
      return { stdout: "", stderr: `no crontab for ${parsed.username}\n`, exitCode: 1 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  if (parsed.action === "edit") {
    return {
      stdout: "",
      stderr: "crontab: interactive editing is not supported; use crontab FILE or write /var/spool/cron/<user>\n",
      exitCode: 1,
    };
  }

  requireCommandCapability(ctx, "sched.add");
  requireCommandCapability(ctx, "sched.remove");
  const sourcePath = commandCtx.fs.resolvePath(commandCtx.cwd, parsed.file);
  const content = await fs.readFile(sourcePath);
  await service.installUserCrontab(parsed.username, content);
  return { stdout: "", stderr: "", exitCode: 0 };
}

function parseCrontabArgs(args: string[], ctx: KernelContext): {
  action: "install" | "list" | "remove" | "edit";
  username: string;
  file: string;
  help?: boolean;
} {
  let username = ctx.identity!.process.username;
  let action: "install" | "list" | "remove" | "edit" | null = null;
  let file = "";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      return { action: "list", username, file, help: true };
    }
    if (arg === "-u") {
      index += 1;
      username = args[index] ?? "";
      if (!username) {
        throw new Error("-u requires a user");
      }
      continue;
    }
    if (arg === "-l") {
      action = setAction(action, "list");
      continue;
    }
    if (arg === "-r") {
      action = setAction(action, "remove");
      continue;
    }
    if (arg === "-e") {
      action = setAction(action, "edit");
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`unsupported option: ${arg}`);
    }
    if (file) {
      throw new Error("only one crontab file may be installed at a time");
    }
    file = arg;
  }

  if (ctx.identity!.process.uid !== 0 && username !== ctx.identity!.process.username) {
    throw new Error(`Permission denied: cannot access crontab for ${username}`);
  }

  if (action) {
    if (file) {
      throw new Error("cannot combine action flags with a crontab file");
    }
    return { action, username, file };
  }

  if (!file) {
    throw new Error("usage: crontab [-l|-r|-e] [-u user] | crontab [-u user] FILE");
  }
  return { action: "install", username, file };
}

function setAction(
  existing: "install" | "list" | "remove" | "edit" | null,
  next: "list" | "remove" | "edit",
): "list" | "remove" | "edit" {
  if (existing) {
    throw new Error("only one of -l, -r, or -e may be used");
  }
  return next;
}

function crontabUsage(): string {
  return [
    "Usage:",
    "  crontab -l [-u user]",
    "  crontab -r [-u user]",
    "  crontab FILE [-u user]",
    "  crontab -e [-u user]",
    "",
    "Install, list, or remove a user's cron table. Jobs use standard five-field",
    "cron lines: minute hour day-of-month month day-of-week command.",
    "",
  ].join("\n");
}
