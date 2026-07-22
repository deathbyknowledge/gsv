import { defineCommand } from "just-bash";
import type { CommandContext, ExecResult } from "just-bash";
import type {
  UserAdminArgs,
  UserAdminCreateResult,
  UserAdminPermissionsResult,
  UserAdminResult,
} from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../../../kernel/context";
import {
  requireUserAdmin,
  USER_ADMIN_CAPABILITY,
} from "../../../kernel/user-authority";
import type { RequestFrame, ResponseFrame } from "../../../protocol/frames";
import { requireCommandCapability, requireShellOptionValue } from "./common";

type NativeShellRequest = (
  frame: RequestFrame,
  signal?: AbortSignal,
) => Promise<ResponseFrame>;

type CreateOptions = {
  username: string;
  json: boolean;
};

type PermissionsOptions = {
  username: string;
  grant: string[];
  revoke: string[];
  addGroups: string[];
  removeGroups: string[];
  json: boolean;
};

export function buildUserCommand(
  kernelCtx: KernelContext,
  request?: NativeShellRequest,
) {
  return defineCommand("user", async (args, shellCtx): Promise<ExecResult> => {
    try {
      return await runUserCommand(args, shellCtx, kernelCtx, request);
    } catch (error) {
      return {
        stdout: "",
        stderr: `user: ${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      };
    }
  });
}

async function runUserCommand(
  args: string[],
  shellCtx: CommandContext,
  kernelCtx: KernelContext,
  request?: NativeShellRequest,
): Promise<ExecResult> {
  const [subcommand = "help", ...rest] = args;
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    return success(userUsage());
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    return success(userUsage());
  }

  // Fail on both advertised and current durable authority before parsing
  // credentials. The user.admin handler repeats the durable check at mutation.
  requireCommandCapability(kernelCtx, USER_ADMIN_CAPABILITY);
  requireUserAdmin(kernelCtx);
  if (!request) {
    throw new Error("direct syscall transport is unavailable");
  }

  switch (subcommand) {
    case "create":
    case "register": {
      const options = parseCreateOptions(rest, subcommand);
      const result = await requestUserAdmin(request, {
        action: "create",
        username: options.username,
        password: passwordFromStdin(shellCtx.stdin),
      }, shellCtx.signal);
      if (result.action !== "create") {
        throw new Error("invalid user.admin create response");
      }
      return options.json
        ? jsonResult(result)
        : success(formatCreateResult(result, subcommand === "register"));
    }

    case "permissions":
    case "edit-permissions": {
      const options = parsePermissionsOptions(rest, subcommand);
      const result = await requestUserAdmin(request, {
        action: "permissions",
        username: options.username,
        ...(options.grant.length > 0 ? { grant: options.grant } : {}),
        ...(options.revoke.length > 0 ? { revoke: options.revoke } : {}),
        ...(options.addGroups.length > 0 ? { addGroups: options.addGroups } : {}),
        ...(options.removeGroups.length > 0 ? { removeGroups: options.removeGroups } : {}),
      }, shellCtx.signal);
      if (result.action !== "permissions") {
        throw new Error("invalid user.admin permissions response");
      }
      return options.json ? jsonResult(result) : success(formatPermissionsResult(result));
    }

    default:
      throw new Error(`unknown subcommand: ${subcommand}`);
  }
}

async function requestUserAdmin(
  request: NativeShellRequest,
  args: UserAdminArgs,
  signal?: AbortSignal,
): Promise<UserAdminResult> {
  signal?.throwIfAborted();
  const frame: RequestFrame<"user.admin"> = {
    type: "req",
    id: crypto.randomUUID(),
    call: "user.admin",
    args,
  };
  const response = await request(frame, signal);
  signal?.throwIfAborted();
  if (!response.ok) {
    throw new Error(response.error.message);
  }
  if (!response.data) {
    throw new Error("user.admin returned no result");
  }
  return response.data as UserAdminResult;
}

function parseCreateOptions(args: string[], subcommand: string): CreateOptions {
  const positionals: string[] = [];
  let passwordStdin = false;
  let json = false;

  for (const arg of args) {
    if (arg === "--password-stdin") {
      passwordStdin = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length !== 1 || !passwordStdin) {
    throw new Error(`usage: user ${subcommand} USER --password-stdin [--json]`);
  }
  return { username: positionals[0], json };
}

function parsePermissionsOptions(args: string[], subcommand: string): PermissionsOptions {
  const parsed: PermissionsOptions = {
    username: "",
    grant: [],
    revoke: [],
    addGroups: [],
    removeGroups: [],
    json: false,
  };
  const positionals: string[] = [];
  const valueOptions: Record<string, keyof Pick<
    PermissionsOptions,
    "grant" | "revoke" | "addGroups" | "removeGroups"
  >> = {
    "--grant": "grant",
    "--revoke": "revoke",
    "--add-group": "addGroups",
    "--remove-group": "removeGroups",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    const field = valueOptions[arg];
    if (field) {
      index += 1;
      parsed[field].push(requireShellOptionValue(args[index], arg));
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    }
    positionals.push(arg);
  }

  if (positionals.length !== 1) {
    throw new Error(
      `usage: user ${subcommand} USER [--grant CAP] [--revoke CAP] ` +
      "[--add-group GROUP] [--remove-group GROUP] [--json]",
    );
  }
  parsed.username = positionals[0];
  return parsed;
}

function passwordFromStdin(stdin: string): string {
  const password = stdin.endsWith("\r\n")
    ? stdin.slice(0, -2)
    : stdin.endsWith("\n")
      ? stdin.slice(0, -1)
      : stdin;
  if (!password) {
    throw new Error("new user password is required on stdin");
  }
  return password;
}

function formatCreateResult(result: UserAdminCreateResult, registered: boolean): string {
  const lines = [
    `Created human account ${result.account.username} (uid ${result.account.uid}, gid ${result.account.gid}).`,
    `Home: ${result.account.home}`,
    `Personal agent: ${result.personalAgent.username} (uid ${result.personalAgent.uid}, gid ${result.personalAgent.gid})`,
  ];
  if (registered) {
    lines.push(`Registration complete. Start a new login as ${result.account.username}.`);
  }
  return `${lines.join("\n")}\n`;
}

function formatPermissionsResult(result: UserAdminPermissionsResult): string {
  const groups = result.groups.length === 0
    ? "(none)"
    : result.groups.map((group) =>
      `${group.name} (${group.gid}${group.primary ? ", primary" : ""})`
    ).join(", ");
  return [
    `User: ${result.user.username} (uid ${result.user.uid}, gid ${result.user.gid})`,
    `Groups: ${groups}`,
    "Direct capabilities:",
    formatCapabilities(result.directCapabilities),
    "Effective capabilities:",
    formatCapabilities(result.effectiveCapabilities),
    result.changed ? "Permissions updated." : "Permissions unchanged.",
    "",
  ].join("\n");
}

function formatCapabilities(capabilities: string[]): string {
  return capabilities.length > 0
    ? capabilities.map((capability) => `  ${capability}`).join("\n")
    : "  (none)";
}

function userUsage(): string {
  return [
    "Usage:",
    "  user create USER --password-stdin [--json]",
    "  user register USER --password-stdin [--json]",
    "  user permissions USER [--grant CAP] [--revoke CAP] [--add-group GROUP] [--remove-group GROUP] [--json]",
    "  user edit-permissions USER [--grant CAP] [--revoke CAP] [--add-group GROUP] [--remove-group GROUP] [--json]",
    "",
    "Passwords are accepted only on stdin so they do not appear in shell argv.",
    "",
  ].join("\n");
}

function success(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function jsonResult(value: unknown): ExecResult {
  return success(`${JSON.stringify(value, null, 2)}\n`);
}
