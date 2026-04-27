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

export function buildCodeModeSource(code: string): string {
  const userMain = normalizeCode(code);
  return `async () => {
  const shell = async (input, options = {}) => {
    if (typeof input !== "string") {
      throw new Error("shell(input, options) requires a string input");
    }
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new Error("shell(input, options) requires options to be an object when provided");
    }
    return await codemode.shell({ ...options, input });
  };
  const fs = Object.freeze({
    read: (args) => codemode.read(args),
    write: (args) => codemode.write(args),
    edit: (args) => codemode.edit(args),
    delete: (args) => codemode.delete(args),
    search: (args) => codemode.search(args),
  });
  const __userMain = ${userMain};
  return await __userMain();
}`;
}

export async function executeCodeMode(
  env: Env,
  code: string,
  requestTool: CodeModeToolRequest,
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

  const response = await executor.execute(buildCodeModeSource(code), providers);
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
