import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import { hasCapability } from "../../kernel/capabilities";
import {
  handleNotificationCreate,
  handleNotificationDismiss,
  handleNotificationList,
  handleNotificationMarkRead,
} from "../../kernel/notifications";
import type { KernelContext } from "../../kernel/context";
import type {
  NotificationCreateArgs,
  NotificationDismissArgs,
  NotificationLevel,
  NotificationListArgs,
  NotificationMarkReadArgs,
  NotificationRecord,
} from "@gsv/protocol/syscalls/notification";

type NotifyShellOps = {
  create: (args: NotificationCreateArgs, ctx: KernelContext) => { notification: NotificationRecord };
  list: (args: NotificationListArgs, ctx: KernelContext) => { notifications: NotificationRecord[] };
  markRead: (args: NotificationMarkReadArgs, ctx: KernelContext) => { notification: NotificationRecord | null };
  dismiss: (args: NotificationDismissArgs, ctx: KernelContext) => { notification: NotificationRecord | null };
};

const DEFAULT_OPS: NotifyShellOps = {
  create: handleNotificationCreate,
  list: handleNotificationList,
  markRead: handleNotificationMarkRead,
  dismiss: handleNotificationDismiss,
};

export function buildNotifyCommands(ctx: KernelContext) {
  const notify = defineCommand("notify", async (args): Promise<ExecResult> => {
    try {
      return await runNotifyCommand(args, ctx);
    } catch (err) {
      return commandError("notify", err);
    }
  });

  return [notify];
}

export async function runNotifyCommand(
  args: string[],
  ctx: KernelContext,
  ops: NotifyShellOps = DEFAULT_OPS,
): Promise<ExecResult> {
  const [subcommand = "help", ...rest] = args;

  switch (subcommand) {
    case "help":
    case "--help":
    case "-h":
      return ok(notifyHelp());

    case "send": {
      requireCapability(ctx, "notification.create");
      const title = requireFlagValue(rest, "--title", "notify send requires --title");
      const body = findFlagValue(rest, "--body");
      const level = parseLevel(findFlagValue(rest, "--level"));
      const ttlMs = parseOptionalInteger(findFlagValue(rest, "--ttl-ms"));
      const result = ops.create(
        {
          title,
          body,
          level,
          ttlMs,
        },
        ctx,
      );
      return ok(`sent ${result.notification.notificationId}\n`);
    }

    case "list": {
      requireCapability(ctx, "notification.list");
      const includeRead = !hasFlag(rest, "--unread");
      const includeDismissed = hasFlag(rest, "--dismissed");
      const limit = parseOptionalInteger(findFlagValue(rest, "--limit"));
      const result = ops.list(
        {
          includeRead,
          includeDismissed,
          limit,
        },
        ctx,
      );
      return ok(formatNotificationList(result.notifications, includeDismissed));
    }

    case "read":
    case "mark-read": {
      requireCapability(ctx, "notification.mark_read");
      const notificationId = String(rest[0] ?? "").trim();
      if (!notificationId) {
        throw new Error("Usage: notify read <notification-id>");
      }
      const result = ops.markRead({ notificationId }, ctx);
      if (!result.notification) {
        throw new Error(`Notification '${notificationId}' not found`);
      }
      return ok(`read ${notificationId}\n`);
    }

    case "dismiss": {
      requireCapability(ctx, "notification.dismiss");
      const notificationId = String(rest[0] ?? "").trim();
      if (!notificationId) {
        throw new Error("Usage: notify dismiss <notification-id>");
      }
      const result = ops.dismiss({ notificationId }, ctx);
      if (!result.notification) {
        throw new Error(`Notification '${notificationId}' not found`);
      }
      return ok(`dismissed ${notificationId}\n`);
    }

    default:
      throw new Error(`Unknown notify subcommand: ${subcommand}`);
  }
}

function requireCapability(ctx: KernelContext, capability: string) {
  const capabilities = ctx.identity?.capabilities;
  if (!capabilities) {
    throw new Error("No active identity");
  }
  if (!hasCapability(capabilities, capability)) {
    throw new Error(`Permission denied: ${capability}`);
  }
}

function findFlagValue(args: string[], flag: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      const value = args[index + 1];
      return value && !value.startsWith("-") ? value : undefined;
    }
  }
  return undefined;
}

function requireFlagValue(args: string[], flag: string, message: string): string {
  const value = findFlagValue(args, flag);
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseOptionalInteger(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer: ${value}`);
  }
  return parsed;
}

function parseLevel(value?: string): NotificationLevel | undefined {
  if (!value) {
    return undefined;
  }
  switch (value) {
    case "info":
    case "success":
    case "warning":
    case "error":
      return value;
    default:
      throw new Error(`Invalid notification level: ${value}`);
  }
}

function formatNotificationList(notifications: NotificationRecord[], includeDismissed: boolean): string {
  if (notifications.length === 0) {
    return "No notifications.\n";
  }

  const lines: string[] = [];
  for (const notification of notifications) {
    const status = notification.dismissedAt
      ? "dismissed"
      : notification.readAt
        ? "read"
        : "unread";
    const createdAt = new Date(notification.createdAt).toISOString();
    lines.push(`${notification.notificationId} [${notification.level}] [${status}] ${notification.title}`);
    lines.push(`  created: ${createdAt}`);
    if (notification.body) {
      lines.push(`  body: ${notification.body}`);
    }
    if (notification.actions.length > 0) {
      const actions = notification.actions.map((action) => action.label).join(", ");
      lines.push(`  actions: ${actions}`);
    }
    if (includeDismissed && notification.dismissedAt) {
      lines.push(`  dismissed: ${new Date(notification.dismissedAt).toISOString()}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function notifyHelp(): string {
  return [
    "notify - send and manage user notifications",
    "",
    "Usage:",
    "  notify send --title TITLE [--body TEXT] [--level info|success|warning|error] [--ttl-ms N]",
    "  notify list [--unread] [--dismissed] [--limit N]",
    "  notify read <notification-id>",
    "  notify dismiss <notification-id>",
    "",
  ].join("\n");
}

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function commandError(command: string, err: unknown): ExecResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    stdout: "",
    stderr: `${command}: ${message}\n`,
    exitCode: 1,
  };
}
