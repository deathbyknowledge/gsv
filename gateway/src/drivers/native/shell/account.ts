import { defineCommand } from "just-bash";
import type { CommandContext, ExecResult } from "just-bash";
import type {
  AccountCreateArgs,
  AccountCreateResult,
  AccountDetail,
  AccountSummary,
  SysCapRecord,
} from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../../../kernel/context";
import type { RequestFrame, ResponseFrame } from "../../../protocol/frames";
import type { ArgsOf, ResultOf, SyscallName } from "../../../syscalls";
import { requireCommandCapability, requireShellOptionValue } from "./common";

type NativeShellRequest = (
  frame: RequestFrame,
  signal?: AbortSignal,
) => Promise<ResponseFrame>;

export function buildAccountCommand(
  ctx: KernelContext,
  request?: NativeShellRequest,
) {
  return defineCommand("account", async (args, commandCtx): Promise<ExecResult> => {
    try {
      return await runAccountCommand(args, commandCtx, ctx, request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        stdout: "",
        stderr: `account: ${message}\n`,
        exitCode: 1,
      };
    }
  });
}

async function runAccountCommand(
  args: string[],
  commandCtx: CommandContext,
  ctx: KernelContext,
  request?: NativeShellRequest,
): Promise<ExecResult> {
  const [subcommand = "help", ...rest] = args;

  switch (subcommand) {
    case "help":
    case "--help":
    case "-h":
      return { stdout: accountUsage(), stderr: "", exitCode: 0 };
    case "create": {
      requireCommandCapability(ctx, "account.create");
      const parsed = parseAccountCreate(rest, commandCtx.stdin);
      const result = await requestAccount(
        request,
        "account.create",
        parsed.args,
        commandCtx.signal,
      );
      return {
        stdout: parsed.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : formatAccountCreated(result),
        stderr: "",
        exitCode: 0,
      };
    }
    case "list": {
      requireCommandCapability(ctx, "account.list");
      const parsed = parseAccountList(rest);
      const result = await requestAccount(
        request,
        "account.list",
        parsed.uid === undefined ? {} : { uid: parsed.uid },
        commandCtx.signal,
      );
      return {
        stdout: parsed.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : formatAccountList(result.accounts),
        stderr: "",
        exitCode: 0,
      };
    }
    case "get": {
      requireCommandCapability(ctx, "account.get");
      const parsed = parseAccountGet(rest);
      const result = await requestAccount(
        request,
        "account.get",
        /^\d+$/.test(parsed.selector)
          ? { uid: parseNonNegativeInteger(parsed.selector, "uid") }
          : { username: parsed.selector },
        commandCtx.signal,
      );
      if (!result.account) {
        throw new Error(`not found: ${parsed.selector}`);
      }
      return {
        stdout: parsed.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : formatAccountDetail(result.account),
        stderr: "",
        exitCode: 0,
      };
    }
    case "caps": {
      requireCommandCapability(ctx, "sys.cap.list");
      const parsed = parseAccountCaps(rest);
      const result = await requestAccount(
        request,
        "sys.cap.list",
        parsed.gid === undefined ? {} : { gid: parsed.gid },
        commandCtx.signal,
      );
      return {
        stdout: parsed.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : formatCapabilities(result.records),
        stderr: "",
        exitCode: 0,
      };
    }
    default:
      throw new Error(`unknown command: ${subcommand}\n${accountUsage()}`);
  }
}

function parseAccountCreate(
  args: string[],
  stdin: string,
): { args: AccountCreateArgs; json: boolean } {
  let username: string | undefined;
  let kind: AccountCreateArgs["kind"] = "agent";
  let password: string | undefined;
  let passwordStdin = false;
  let gecos: string | undefined;
  let persona: string | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--json") {
      json = true;
      continue;
    }
    if (current === "--kind") {
      index += 1;
      const value = requireShellOptionValue(args[index], current);
      if (value !== "agent" && value !== "human") {
        throw new Error("--kind must be agent or human");
      }
      kind = value;
      continue;
    }
    if (current === "--password") {
      if (passwordStdin || password !== undefined) {
        throw new Error("specify only one password source");
      }
      index += 1;
      password = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--password-stdin") {
      if (passwordStdin || password !== undefined) {
        throw new Error("specify only one password source");
      }
      passwordStdin = true;
      continue;
    }
    if (current === "--gecos") {
      index += 1;
      gecos = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--persona") {
      index += 1;
      persona = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current.startsWith("-")) {
      throw new Error(`unsupported option: ${current}`);
    }
    if (username !== undefined) {
      throw new Error(`unexpected argument: ${current}`);
    }
    username = current;
  }

  if (!username) {
    throw new Error("usage: account create <username> [options]");
  }
  if (passwordStdin) {
    password = stdin.replace(/\r?\n$/, "");
    if (!password) {
      throw new Error("--password-stdin received an empty password");
    }
  }
  if (kind === "human" && password === undefined) {
    throw new Error("human accounts require --password or --password-stdin");
  }
  if (kind === "agent" && password !== undefined) {
    throw new Error("--password is only valid for human accounts");
  }
  if (kind === "human" && persona !== undefined) {
    throw new Error("--persona is only valid for agent accounts");
  }

  return {
    args: {
      kind,
      username,
      ...(password !== undefined ? { password } : {}),
      ...(gecos !== undefined ? { gecos } : {}),
      ...(persona !== undefined ? { persona } : {}),
    },
    json,
  };
}

function parseAccountList(args: string[]): { uid?: number; json: boolean } {
  let uid: number | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--json") {
      json = true;
      continue;
    }
    if (current === "--uid") {
      if (uid !== undefined) {
        throw new Error("--uid may only be specified once");
      }
      index += 1;
      uid = parseNonNegativeInteger(
        requireShellOptionValue(args[index], current),
        current,
      );
      continue;
    }
    throw new Error(`unexpected argument: ${current}`);
  }

  return { ...(uid !== undefined ? { uid } : {}), json };
}

function parseAccountGet(args: string[]): { selector: string; json: boolean } {
  let selector: string | undefined;
  let json = false;

  for (const current of args) {
    if (current === "--json") {
      json = true;
      continue;
    }
    if (current.startsWith("-")) {
      throw new Error(`unsupported option: ${current}`);
    }
    if (selector !== undefined) {
      throw new Error(`unexpected argument: ${current}`);
    }
    selector = current;
  }

  if (!selector) {
    throw new Error("usage: account get <username|uid> [--json]");
  }
  return { selector, json };
}

function parseAccountCaps(args: string[]): { gid?: number; json: boolean } {
  let gid: number | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--json") {
      json = true;
      continue;
    }
    if (current === "--gid") {
      if (gid !== undefined) {
        throw new Error("--gid may only be specified once");
      }
      index += 1;
      gid = parseNonNegativeInteger(
        requireShellOptionValue(args[index], current),
        current,
      );
      continue;
    }
    throw new Error(`unexpected argument: ${current}`);
  }

  return { ...(gid !== undefined ? { gid } : {}), json };
}

function parseNonNegativeInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} must be a safe integer`);
  }
  return parsed;
}

async function requestAccount<S extends SyscallName>(
  request: NativeShellRequest | undefined,
  call: S,
  args: ArgsOf<S>,
  signal?: AbortSignal,
): Promise<ResultOf<S>> {
  if (!request) {
    throw new Error("direct syscall transport is unavailable");
  }
  signal?.throwIfAborted();
  const response = await request({
    type: "req",
    id: crypto.randomUUID(),
    call,
    args,
  } as unknown as RequestFrame, signal);
  signal?.throwIfAborted();
  if (!response.ok) {
    throw new Error(response.error.message);
  }
  if (response.body) {
    await response.body.stream.cancel(`${call} returned an unexpected body`).catch(() => {});
    throw new Error(`${call} returned an unexpected body`);
  }
  return response.data as ResultOf<S>;
}

function formatAccountCreated(result: AccountCreateResult): string {
  return [
    `kind=${result.kind}`,
    `username=${result.account.username}`,
    `uid=${result.account.uid}`,
    result.personalAgent
      ? `personal_agent=${result.personalAgent.username}`
      : "",
    result.personalAgent
      ? `personal_agent_uid=${result.personalAgent.uid}`
      : "",
  ].filter(Boolean).join(" ") + "\n";
}

function formatAccountList(accounts: AccountSummary[]): string {
  const lines = ["UID\tUSERNAME\tRELATION\tNAME"];
  for (const account of accounts) {
    lines.push([
      String(account.uid),
      account.username,
      account.relation,
      tableCell(account.displayName),
    ].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

function formatAccountDetail(account: AccountDetail): string {
  return [
    "USERNAME\tUID\tGID\tKIND\tSTATE\tHOME\tSHELL\tDELEGABLE",
    [
      account.username,
      String(account.uid),
      String(account.gid),
      account.kind,
      account.state,
      tableCell(account.home),
      tableCell(account.shell),
      account.delegable === true ? "yes" : "no",
    ].join("\t"),
    "",
  ].join("\n");
}

function formatCapabilities(records: SysCapRecord[]): string {
  const sorted = [...records].sort((left, right) => (
    left.gid - right.gid || left.capability.localeCompare(right.capability)
  ));
  return [
    "GID\tCAPABILITY",
    ...sorted.map((record) => `${record.gid}\t${tableCell(record.capability)}`),
    "",
  ].join("\n");
}

function tableCell(value: string): string {
  return value.replace(/[\t\r\n]+/g, " ").trim();
}

function accountUsage(): string {
  return [
    "Usage:",
    "  account create <username> [--kind agent|human] [--password VALUE|--password-stdin] [--gecos TEXT] [--persona TEXT] [--json]",
    "  account list [--uid UID] [--json]",
    "  account get <username|uid> [--json]",
    "  account caps [--gid GID] [--json]",
    "",
  ].join("\n");
}
