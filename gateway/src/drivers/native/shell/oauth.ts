import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import type { KernelContext } from "../../../kernel/context";
import {
  handleSysOAuthDevicePoll,
  handleSysOAuthDeviceStart,
  handleSysOAuthForget,
  handleSysOAuthList,
} from "../../../kernel/sys/oauth";
import {
  SYS_OAUTH_DEVICE_POLL,
  SYS_OAUTH_DEVICE_START,
  SYS_OAUTH_FORGET,
  SYS_OAUTH_LIST,
} from "../../../syscalls/constants";
import type {
  SysOAuthAccountSummary,
  SysOAuthConnectionKind,
  SysOAuthDevicePollResult,
  SysOAuthDeviceStartResult,
  SysOAuthFlowSummary,
} from "@humansandmachines/gsv/protocol";
import { requireCommandCapability, requireShellOptionValue } from "./common";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const DEFAULT_ACCOUNT_KEY = "default";

type CommonOptions = {
  json: boolean;
  uid?: number;
};

type ListOptions = CommonOptions & {
  provider?: string;
  kind?: SysOAuthConnectionKind;
  includePending: boolean;
};

export function buildOAuthCommand(ctx: KernelContext) {
  return defineCommand("oauth", async (args): Promise<ExecResult> => {
    try {
      if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
        return { stdout: oauthUsage(), stderr: "", exitCode: 0 };
      }

      const [subcommand, ...rest] = args;
      switch (subcommand) {
        case "list":
        case "ls":
          return await listOAuth(rest, ctx);
        case "show":
          return await showOAuth(rest, ctx);
        case "forget":
        case "rm":
          return forgetOAuth(rest, ctx);
        case "device":
          return await runDeviceOAuth(rest, ctx);
        case "codex":
          return await runCodexOAuth(rest, ctx);
        default:
          throw new Error(`unknown subcommand: ${subcommand}`);
      }
    } catch (error) {
      return {
        stdout: "",
        stderr: `oauth: ${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      };
    }
  });
}

async function listOAuth(args: string[], ctx: KernelContext): Promise<ExecResult> {
  requireCommandCapability(ctx, SYS_OAUTH_LIST);
  const options = parseListOptions(args);
  const result = handleSysOAuthList({
    ...(options.uid !== undefined ? { uid: options.uid } : {}),
    includePending: options.includePending,
  }, ctx);
  const accounts = filterAccounts(result.accounts, options);
  const flows = options.includePending
    ? filterFlows(result.flows ?? [], options)
    : undefined;
  if (options.json) {
    return jsonResult({ accounts, ...(flows ? { flows } : {}) });
  }
  return {
    stdout: formatAccountTable(accounts, flows),
    stderr: "",
    exitCode: 0,
  };
}

async function showOAuth(args: string[], ctx: KernelContext): Promise<ExecResult> {
  requireCommandCapability(ctx, SYS_OAUTH_LIST);
  const { selector, options } = parseShowOptions(args);
  const result = handleSysOAuthList({
    ...(options.uid !== undefined ? { uid: options.uid } : {}),
    includePending: false,
  }, ctx);
  const account = result.accounts.find((candidate) =>
    candidate.accountId === selector ||
    `${candidate.provider}/${candidate.accountKey}` === selector ||
    candidate.provider === selector
  );
  if (!account) {
    return { stdout: "", stderr: `oauth show: account not found: ${selector}\n`, exitCode: 1 };
  }
  if (options.json) {
    return jsonResult(account);
  }
  return {
    stdout: formatAccountDetails(account),
    stderr: "",
    exitCode: 0,
  };
}

function forgetOAuth(args: string[], ctx: KernelContext): ExecResult {
  requireCommandCapability(ctx, SYS_OAUTH_FORGET);
  const { selector, options } = parseForgetOptions(args);
  const result = handleSysOAuthForget({
    accountId: selector,
    ...(options.uid !== undefined ? { uid: options.uid } : {}),
  }, ctx);
  if (options.json) {
    return jsonResult(result);
  }
  return {
    stdout: result.forgotten ? `forgot ${selector}\n` : "",
    stderr: result.forgotten ? "" : `oauth forget: account not found: ${selector}\n`,
    exitCode: result.forgotten ? 0 : 1,
  };
}

async function runDeviceOAuth(args: string[], ctx: KernelContext): Promise<ExecResult> {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return { stdout: deviceUsage(), stderr: "", exitCode: 0 };
  }
  if (subcommand === "start") {
    requireCommandCapability(ctx, SYS_OAUTH_DEVICE_START);
    const { provider, options } = parseDeviceStartOptions(rest);
    const result = await handleSysOAuthDeviceStart({
      kind: "ai-provider",
      provider,
      ...(options.uid !== undefined ? { uid: options.uid } : {}),
    }, ctx);
    return options.json ? jsonResult(result) : deviceStartResult(result);
  }
  if (subcommand === "poll") {
    requireCommandCapability(ctx, SYS_OAUTH_DEVICE_POLL);
    const { flowId, options } = parseDevicePollOptions(rest);
    const result = await handleSysOAuthDevicePoll({
      flowId,
      ...(options.uid !== undefined ? { uid: options.uid } : {}),
    }, ctx);
    return options.json ? jsonResult(result) : devicePollResult(result);
  }
  throw new Error(`unknown device subcommand: ${subcommand}`);
}

async function runCodexOAuth(args: string[], ctx: KernelContext): Promise<ExecResult> {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return { stdout: codexUsage(), stderr: "", exitCode: 0 };
  }
  if (subcommand === "status") {
    requireCommandCapability(ctx, SYS_OAUTH_LIST);
    const options = parseCommonOptions(rest, "oauth codex status [--json] [-u UID]");
    const result = handleSysOAuthList({
      ...(options.uid !== undefined ? { uid: options.uid } : {}),
      includePending: false,
    }, ctx);
    const account = result.accounts.find(isDefaultCodexAccount) ?? null;
    const status = {
      connected: account !== null,
      ready: account ? hasCodexAccountId(account) : false,
      account,
    };
    if (options.json) {
      return jsonResult(status);
    }
    return {
      stdout: formatCodexStatus(status),
      stderr: "",
      exitCode: status.ready ? 0 : 1,
    };
  }
  if (subcommand === "login") {
    return runDeviceOAuth(["start", OPENAI_CODEX_PROVIDER, ...rest], ctx);
  }
  if (subcommand === "poll") {
    return runDeviceOAuth(["poll", ...rest], ctx);
  }
  throw new Error(`unknown codex subcommand: ${subcommand}`);
}

function parseListOptions(args: string[]): ListOptions {
  const options: ListOptions = { json: false, includePending: false };
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--json") {
      options.json = true;
      continue;
    }
    if (current === "--pending" || current === "-p") {
      options.includePending = true;
      continue;
    }
    if (current === "--provider") {
      index += 1;
      options.provider = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--kind") {
      index += 1;
      options.kind = parseKind(requireShellOptionValue(args[index], current));
      continue;
    }
    if (current === "--uid" || current === "-u") {
      index += 1;
      options.uid = parseUid(requireShellOptionValue(args[index], current));
      continue;
    }
    throw new Error(`unknown option: ${current}`);
  }
  return options;
}

function parseShowOptions(args: string[]): { selector: string; options: CommonOptions } {
  const options = parseTrailingCommonOptions(args, "oauth show <account-id|provider[/key]> [--json] [-u UID]");
  if (options.positionals.length !== 1) {
    throw new Error("usage: oauth show <account-id|provider[/key]> [--json] [-u UID]");
  }
  return { selector: options.positionals[0], options };
}

function parseForgetOptions(args: string[]): { selector: string; options: CommonOptions } {
  const options = parseTrailingCommonOptions(args, "oauth forget <account-id> [--json] [-u UID]");
  if (options.positionals.length !== 1) {
    throw new Error("usage: oauth forget <account-id> [--json] [-u UID]");
  }
  return { selector: options.positionals[0], options };
}

function parseDeviceStartOptions(args: string[]): { provider: typeof OPENAI_CODEX_PROVIDER; options: CommonOptions } {
  const options = parseTrailingCommonOptions(args, "oauth device start <provider> [--json] [-u UID]");
  if (options.positionals.length !== 1) {
    throw new Error("usage: oauth device start <provider> [--json] [-u UID]");
  }
  if (options.positionals[0] !== OPENAI_CODEX_PROVIDER) {
    throw new Error("device provider must be openai-codex");
  }
  return { provider: OPENAI_CODEX_PROVIDER, options };
}

function parseDevicePollOptions(args: string[]): { flowId: string; options: CommonOptions } {
  const options = parseTrailingCommonOptions(args, "oauth device poll <flow-id> [--json] [-u UID]");
  if (options.positionals.length !== 1) {
    throw new Error("usage: oauth device poll <flow-id> [--json] [-u UID]");
  }
  return { flowId: options.positionals[0], options };
}

function parseCommonOptions(args: string[], usage: string): CommonOptions {
  return parseTrailingCommonOptions(args, usage);
}

function parseTrailingCommonOptions(
  args: string[],
  usage: string,
): CommonOptions & { positionals: string[] } {
  const options: CommonOptions & { positionals: string[] } = { json: false, positionals: [] };
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--json") {
      options.json = true;
      continue;
    }
    if (current === "--uid" || current === "-u") {
      index += 1;
      options.uid = parseUid(requireShellOptionValue(args[index], current));
      continue;
    }
    if (current.startsWith("-")) {
      throw new Error(`${usage}; unknown option: ${current}`);
    }
    options.positionals.push(current);
  }
  return options;
}

function filterAccounts(
  accounts: readonly SysOAuthAccountSummary[],
  options: Pick<ListOptions, "provider" | "kind">,
): SysOAuthAccountSummary[] {
  return accounts.filter((account) =>
    (!options.provider || account.provider === options.provider) &&
    (!options.kind || account.kind === options.kind)
  );
}

function filterFlows(
  flows: readonly SysOAuthFlowSummary[],
  options: Pick<ListOptions, "provider" | "kind">,
): SysOAuthFlowSummary[] {
  return flows.filter((flow) =>
    (!options.provider || flow.provider === options.provider) &&
    (!options.kind || flow.kind === options.kind)
  );
}

function isDefaultCodexAccount(account: SysOAuthAccountSummary): boolean {
  return account.kind === "ai-provider" &&
    account.provider === OPENAI_CODEX_PROVIDER &&
    account.accountKey === DEFAULT_ACCOUNT_KEY;
}

function hasCodexAccountId(account: SysOAuthAccountSummary): boolean {
  return stringMetadata(account.metadata, "chatgptAccountId") !== null;
}

function stringMetadata(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseKind(value: string): SysOAuthConnectionKind {
  if (value === "ai-provider" || value === "mcp-server" || value === "generic") {
    return value;
  }
  throw new Error("kind must be ai-provider, mcp-server, or generic");
}

function parseUid(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error("uid must be a non-negative integer");
  }
  return Number.parseInt(value, 10);
}

function jsonResult(value: unknown): ExecResult {
  return {
    stdout: `${JSON.stringify(value, null, 2)}\n`,
    stderr: "",
    exitCode: 0,
  };
}

function deviceStartResult(result: SysOAuthDeviceStartResult): ExecResult {
  return {
    stdout: [
      `flow_id=${result.flow.flowId}`,
      `provider=${result.provider}`,
      `user_code=${result.userCode}`,
      `verification_url=${result.verificationUrl}`,
      `interval_seconds=${result.intervalSeconds}`,
      `expires_at=${formatTimestamp(result.expiresAt)}`,
      "",
    ].join("\n"),
    stderr: "",
    exitCode: 0,
  };
}

function devicePollResult(result: SysOAuthDevicePollResult): ExecResult {
  if (result.status === "pending") {
    return {
      stdout: [
        "status=pending",
        `flow_id=${result.flow.flowId}`,
        `interval_seconds=${result.intervalSeconds}`,
        `expires_at=${formatTimestamp(result.expiresAt)}`,
        "",
      ].join("\n"),
      stderr: "",
      exitCode: 1,
    };
  }
  return {
    stdout: [
      "status=complete",
      `account_id=${result.account.accountId}`,
      `provider=${result.account.provider}`,
      `account_key=${result.account.accountKey}`,
      `ready=${hasCodexAccountId(result.account)}`,
      "",
    ].join("\n"),
    stderr: "",
    exitCode: 0,
  };
}

function formatAccountTable(
  accounts: readonly SysOAuthAccountSummary[],
  flows?: readonly SysOAuthFlowSummary[],
): string {
  const rows = accounts.map((account) => [
    account.accountId,
    String(account.uid),
    account.kind,
    account.provider,
    account.accountKey,
    account.expiresAt ? formatTimestamp(account.expiresAt) : "-",
    account.provider === OPENAI_CODEX_PROVIDER ? (hasCodexAccountId(account) ? "ready" : "missing-account-id") : "-",
  ]);
  const table = formatTable(["ACCOUNT", "UID", "KIND", "PROVIDER", "KEY", "EXPIRES", "STATE"], rows);
  if (!flows?.length) {
    return table;
  }
  const flowRows = flows.map((flow) => [
    flow.flowId,
    String(flow.uid),
    flow.kind,
    flow.provider,
    flow.expiresAt ? formatTimestamp(flow.expiresAt) : "-",
  ]);
  return `${table}\n${formatTable(["FLOW", "UID", "KIND", "PROVIDER", "EXPIRES"], flowRows)}`;
}

function formatAccountDetails(account: SysOAuthAccountSummary): string {
  return [
    `account_id: ${account.accountId}`,
    `uid: ${account.uid}`,
    `kind: ${account.kind}`,
    `provider: ${account.provider}`,
    `account_key: ${account.accountKey}`,
    `label: ${account.label ?? ""}`,
    `scope: ${account.scope ?? ""}`,
    `resource: ${account.resource ?? ""}`,
    `client_id: ${account.clientId}`,
    `token_type: ${account.tokenType}`,
    `expires_at: ${account.expiresAt ? formatTimestamp(account.expiresAt) : ""}`,
    `created_at: ${formatTimestamp(account.createdAt)}`,
    `updated_at: ${formatTimestamp(account.updatedAt)}`,
    `last_used_at: ${account.lastUsedAt ? formatTimestamp(account.lastUsedAt) : ""}`,
    `metadata: ${JSON.stringify(account.metadata)}`,
    "",
  ].join("\n");
}

function formatCodexStatus(status: { connected: boolean; ready: boolean; account: SysOAuthAccountSummary | null }): string {
  if (!status.account) {
    return "connected=no\nready=no\n";
  }
  return [
    "connected=yes",
    `ready=${status.ready ? "yes" : "no"}`,
    `account_id=${status.account.accountId}`,
    `chatgpt_account_id=${stringMetadata(status.account.metadata, "chatgptAccountId") ?? ""}`,
    `expires_at=${status.account.expiresAt ? formatTimestamp(status.account.expiresAt) : ""}`,
    "",
  ].join("\n");
}

function formatTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) {
    return "";
  }
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length))
  );
  const formatRow = (row: string[]) => row
    .map((cell, index) => cell.padEnd(widths[index]))
    .join("  ")
    .trimEnd();
  return `${formatRow(headers)}\n${rows.map(formatRow).join("\n")}\n`;
}

function formatTimestamp(value: number): string {
  return new Date(value).toISOString();
}

function oauthUsage(): string {
  return [
    "usage: oauth <subcommand> [args]",
    "",
    "subcommands:",
    "  list [--provider PROVIDER] [--kind KIND] [--pending] [--json] [-u UID]",
    "  show <account-id|provider[/key]> [--json] [-u UID]",
    "  forget <account-id> [--json] [-u UID]",
    "  device start <provider> [--json] [-u UID]",
    "  device poll <flow-id> [--json] [-u UID]",
    "  codex status [--json] [-u UID]",
    "  codex login [--json] [-u UID]",
    "  codex poll <flow-id> [--json] [-u UID]",
    "",
  ].join("\n");
}

function deviceUsage(): string {
  return [
    "usage: oauth device <start|poll> [args]",
    "  oauth device start <provider> [--json] [-u UID]",
    "  oauth device poll <flow-id> [--json] [-u UID]",
    "",
  ].join("\n");
}

function codexUsage(): string {
  return [
    "usage: oauth codex <status|login|poll> [args]",
    "  oauth codex status [--json] [-u UID]",
    "  oauth codex login [--json] [-u UID]",
    "  oauth codex poll <flow-id> [--json] [-u UID]",
    "",
  ].join("\n");
}
