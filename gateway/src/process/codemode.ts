import {
  DynamicWorkerExecutor,
  normalizeCode,
  type ResolvedProvider,
} from "@cloudflare/codemode";
import type { SyscallName } from "../syscalls";
import type { CodeModeExecResult } from "../syscalls/codemode";
import {
  FS_DELETE,
  FS_EDIT,
  FS_READ,
  FS_SEARCH,
  FS_WRITE,
  SHELL_EXEC,
} from "../syscalls/constants";

export const CODE_MODE_EXECUTION_TIMEOUT_MS = 60_000;

export type CodeModeToolRequest = (
  call: SyscallName,
  args: Record<string, unknown>,
) => Promise<unknown>;

export type CodeModeExecutionOptions = {
  defaultTarget?: string;
  defaultCwd?: string;
  argv?: string[];
  args?: unknown;
};

export function buildCodeModeSource(
  code: string,
  options?: CodeModeExecutionOptions,
): string {
  const userMain = normalizeCode(code);
  const defaultTarget = JSON.stringify(options?.defaultTarget ?? null);
  const defaultCwd = JSON.stringify(options?.defaultCwd ?? null);
  const argv = JSON.stringify(options?.argv ?? []);
  const args = JSON.stringify(options && "args" in options ? options.args : null);
  return `async () => {
  const argv = Object.freeze(${argv});
  const args = ${args};
  const __defaultTarget = ${defaultTarget};
  const __defaultCwd = ${defaultCwd};
  const __isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const __isAbsolutePath = (path) => path.startsWith("/") || /^[A-Za-z]:[\\\\/]/.test(path);
  const __joinPath = (base, path) => {
    if (!base || __isAbsolutePath(path)) return path;
    if (base.endsWith("/")) return base + path.replace(/^\\.\\//, "");
    return base + "/" + path.replace(/^\\.\\//, "");
  };
  const __withShellDefaults = (options) => {
    const request = { ...options };
    if (!request.sessionId) {
      if (__defaultTarget !== null && request.target === undefined) request.target = __defaultTarget;
      if (__defaultCwd !== null && request.cwd === undefined) request.cwd = __defaultCwd;
    }
    return request;
  };
  const __withFsDefaults = (name, value) => {
    if (!__isObject(value)) {
      throw new Error(name + " requires an object argument");
    }
    const request = { ...value };
    if (__defaultTarget !== null && request.target === undefined) request.target = __defaultTarget;
    if (__defaultCwd !== null && typeof request.path === "string") {
      request.path = __joinPath(__defaultCwd, request.path);
    }
    return request;
  };
  const shell = async (input, options = {}) => {
    if (typeof input !== "string") {
      throw new Error("shell(input, options) requires a string input");
    }
    if (!__isObject(options)) {
      throw new Error("shell(input, options) requires options to be an object when provided");
    }
    return await codemode.shell({ ...__withShellDefaults(options), input });
  };
  const fs = Object.freeze({
    read: (args) => codemode.read(__withFsDefaults("fs.read", args)),
    write: (args) => codemode.write(__withFsDefaults("fs.write", args)),
    edit: (args) => codemode.edit(__withFsDefaults("fs.edit", args)),
    delete: (args) => codemode.delete(__withFsDefaults("fs.delete", args)),
    search: (args) => codemode.search(__withFsDefaults("fs.search", args)),
  });
  const __userMain = ${userMain};
  return await __userMain();
}`;
}

export async function executeCodeMode(
  env: Env,
  code: string,
  requestTool: CodeModeToolRequest,
  options?: CodeModeExecutionOptions,
): Promise<CodeModeExecResult> {
  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    timeout: CODE_MODE_EXECUTION_TIMEOUT_MS,
    globalOutbound: null,
  });

  const providers: ResolvedProvider[] = [
    {
      name: "codemode",
      fns: {
        shell: async (args: unknown) => requestTool(SHELL_EXEC as SyscallName, toRecord(args, "shell")),
        read: async (args: unknown) => requestTool(FS_READ as SyscallName, toRecord(args, "fs.read")),
        write: async (args: unknown) => requestTool(FS_WRITE as SyscallName, toRecord(args, "fs.write")),
        edit: async (args: unknown) => requestTool(FS_EDIT as SyscallName, toRecord(args, "fs.edit")),
        delete: async (args: unknown) => requestTool(FS_DELETE as SyscallName, toRecord(args, "fs.delete")),
        search: async (args: unknown) => requestTool(FS_SEARCH as SyscallName, toRecord(args, "fs.search")),
      },
    },
  ];

  const response = await executor.execute(buildCodeModeSource(code, options), providers);
  const logs = response.logs && response.logs.length > 0 ? response.logs : undefined;
  if (response.error) {
    return { status: "failed", error: response.error, logs };
  }
  return { status: "completed", result: response.result, logs };
}

function toRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} requires an object argument`);
  }
  return value as Record<string, unknown>;
}
