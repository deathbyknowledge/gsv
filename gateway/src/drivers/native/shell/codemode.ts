import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import { GsvFs } from "../../../fs/gsv-fs";
import { resolveUserPath } from "../../../fs";
import type { KernelContext } from "../../../kernel/context";
import type {
  ProcessIdentity,
  SysMcpListResult,
} from "@humansandmachines/gsv/protocol";
import type { RequestFrame, ResponseFrame } from "../../../protocol/frames";
import type { SyscallName } from "../../../syscalls";
import { createCodeModeRequest } from "../../../codemode/request";
import {
  buildCodeModeMcpToolBindings,
  executeCodeMode,
} from "../../../process/codemode";
import { materializeToolResponse } from "../../../process/tool-response";
import { CODEMODE_RUN, SYS_MCP_LIST } from "../../../syscalls/constants";
import type { CodeModeRunResult } from "../../../syscalls/codemode";
import { requireCommandCapability } from "./common";

type CodeModeCommandOptions = {
  code?: string;
  file?: string;
  target?: string;
  cwd?: string;
  json: boolean;
  args: unknown;
  argv: string[];
};

type NativeShellRequest = (
  frame: RequestFrame,
  signal?: AbortSignal,
) => Promise<ResponseFrame>;

export function buildCodeModeCommand(
  fs: GsvFs,
  identity: ProcessIdentity,
  kernelCtx: KernelContext,
  request?: NativeShellRequest,
) {
  return defineCommand("codemode", async (commandArgs, bashCtx): Promise<ExecResult> => {
    try {
      const options = parseCodeModeCommandArgs(commandArgs);

      if (!options.code && !options.file) {
        return { stdout: codeModeUsage(), stderr: "", exitCode: 0 };
      }

      requireCommandCapability(kernelCtx, CODEMODE_RUN);
      const code = options.code ?? await readCodeModeScript(fs, bashCtx.cwd, options.file!);
      if (!request) {
        throw new Error("direct syscall transport is unavailable");
      }

      const requestTool = (call: SyscallName, args: Record<string, unknown>) =>
        requestCodeModeTool(request, call, args, bashCtx.signal);
      const cwd = resolveCodeModeCwd(options.cwd, options.target, bashCtx.cwd, identity);
      const result = await executeCodeMode(kernelCtx.env, code, requestTool, {
        defaultTarget: options.target,
        defaultCwd: cwd,
        argv: options.argv,
        args: options.args,
        mcpToolBindings: await loadMcpToolBindings(requestTool, bashCtx.signal),
        signal: bashCtx.signal,
      });
      return formatCodeModeCommandResult(result, options.json);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { stdout: "", stderr: `codemode: ${message}\n`, exitCode: 1 };
    }
  });
}

async function requestCodeModeTool(
  request: NativeShellRequest,
  call: SyscallName,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const prepared = createCodeModeRequest(call, args);
  const frame = {
    type: "req",
    id: crypto.randomUUID(),
    call,
    args: prepared.args,
    ...(prepared.body ? { body: prepared.body } : {}),
  } as RequestFrame;
  let response: ResponseFrame | undefined;

  try {
    response = await request(frame, signal);
    signal?.throwIfAborted();
    if (!response.ok) {
      throw new Error(response.error.message);
    }
    return await materializeToolResponse(
      call,
      response.data ?? null,
      response.body,
      signal,
    );
  } finally {
    if (response?.ok && response.body && !response.body.stream.locked) {
      await response.body.stream.cancel("CodeMode response completed").catch(() => {});
    }
    if (prepared.body && !prepared.body.stream.locked) {
      await prepared.body.stream.cancel("CodeMode request completed").catch(() => {});
    }
  }
}

async function loadMcpToolBindings(
  request: (call: SyscallName, args: Record<string, unknown>) => Promise<unknown>,
  signal?: AbortSignal,
) {
  try {
    const result = await request(SYS_MCP_LIST, {}) as SysMcpListResult;
    return buildCodeModeMcpToolBindings(result.servers);
  } catch {
    signal?.throwIfAborted();
    return [];
  }
}

function parseCodeModeCommandArgs(args: string[]): CodeModeCommandOptions {
  const parsed: CodeModeCommandOptions = {
    json: false,
    args: null,
    argv: [],
  };
  const commandArgs = args[0] === "run" ? args.slice(1) : args;
  let passthrough = false;

  for (let index = 0; index < commandArgs.length; index += 1) {
    const current = commandArgs[index];
    if (passthrough) {
      parsed.argv.push(current);
      continue;
    }
    if (current === "--") {
      passthrough = true;
      continue;
    }
    if (current === "--help" || current === "-h") {
      parsed.code = "";
      parsed.file = "";
      return parsed;
    }
    if (current === "--json") {
      parsed.json = true;
      continue;
    }
    if (current === "-e" || current === "--eval") {
      index += 1;
      parsed.code = requireCodeModeOptionValue(commandArgs[index], current);
      continue;
    }
    if (current === "--target") {
      index += 1;
      parsed.target = requireCodeModeOptionValue(commandArgs[index], current);
      continue;
    }
    if (current === "--cwd") {
      index += 1;
      parsed.cwd = requireCodeModeOptionValue(commandArgs[index], current);
      continue;
    }
    if (current === "--arg") {
      index += 1;
      parsed.args = mergeCodeModeArg(parsed.args, requireCodeModeOptionValue(commandArgs[index], current));
      continue;
    }
    if (current === "--args-json") {
      index += 1;
      parsed.args = JSON.parse(requireCodeModeOptionValue(commandArgs[index], current));
      continue;
    }
    if (!parsed.file && parsed.code === undefined) {
      parsed.file = current;
      continue;
    }
    parsed.argv.push(current);
  }

  if (parsed.code !== undefined && parsed.file) {
    throw new Error("use either -e/--eval or a script file, not both");
  }
  return parsed;
}

function requireCodeModeOptionValue(value: string | undefined, option: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function mergeCodeModeArg(existing: unknown, spec: string): Record<string, unknown> {
  const args = existing && typeof existing === "object" && !Array.isArray(existing)
    ? { ...(existing as Record<string, unknown>) }
    : {};
  const eq = spec.indexOf("=");
  if (eq <= 0) {
    throw new Error("--arg requires key=value");
  }
  args[spec.slice(0, eq)] = spec.slice(eq + 1);
  return args;
}

async function readCodeModeScript(fs: GsvFs, cwd: string, file: string): Promise<string> {
  const path = fs.resolvePath(cwd, file);
  return await fs.readFile(path);
}

function resolveCodeModeCwd(
  cwd: string | undefined,
  target: string | undefined,
  shellCwd: string,
  identity: ProcessIdentity,
): string | undefined {
  if (cwd) {
    return target && target !== "gsv"
      ? cwd
      : resolveUserPath(cwd, identity.home, shellCwd);
  }
  return target && target !== "gsv" ? undefined : shellCwd;
}

function formatCodeModeCommandResult(result: CodeModeRunResult, json: boolean): ExecResult {
  if (json) {
    return {
      stdout: `${JSON.stringify(result, null, 2)}\n`,
      stderr: "",
      exitCode: result.status === "completed" ? 0 : 1,
    };
  }

  const logs = result.logs && result.logs.length > 0
    ? `${result.logs.join("\n")}\n`
    : "";
  if (result.status === "failed") {
    return {
      stdout: "",
      stderr: `${logs}${result.error}\n`,
      exitCode: 1,
    };
  }

  return {
    stdout: formatCodeModeValue(result.result),
    stderr: logs,
    exitCode: 0,
  };
}

export function formatCodeModeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value.endsWith("\n") ? value : `${value}\n`;
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

function codeModeUsage(): string {
  return [
    "codemode <script.js> [options] [-- argv...]",
    "codemode run <script.js> [options] [-- argv...]",
    "codemode -e <code> [options] [-- argv...]",
    "",
    "Options:",
    "  --target <target>   default target for shell/fs calls",
    "  --cwd <path>        default cwd for shell calls and relative fs paths",
    "  --json              print the full CodeMode result envelope",
    "  --arg key=value     expose scalar args[key] to the script",
    "  --args-json <json>  expose structured args to the script",
    "",
  ].join("\n");
}
