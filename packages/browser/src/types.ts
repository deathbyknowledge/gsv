import type { GsvEndpointHandler } from "@humansandmachines/gsv/client";
import type { FsCopyResult } from "@humansandmachines/gsv/protocol";

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type ShellResult =
  | { status: "completed"; output: string; exitCode: number; truncated?: boolean }
  | { status: "failed"; output: string; error: string; exitCode?: number; truncated?: boolean };

export type BrowserCommand = {
  name: string;
  summary: string;
  run(args: string[], ctx: CommandContext): Promise<CommandResult> | CommandResult;
};

export type TargetCopyEndpoint = {
  target: string;
  path: string;
};

export type CommandContext = {
  cwd: string;
  stdin: string;
  fs: TargetFileSystem;
  now: () => number;
  currentTargetId?: string;
  abortSignal?: AbortSignal;
  copyTargetFile?: (
    source: TargetCopyEndpoint,
    destination: TargetCopyEndpoint,
    signal: AbortSignal | undefined,
  ) => Promise<FsCopyResult>;
};

export type DriverHandler = GsvEndpointHandler;

export type FileStat = {
  path: string;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  contentType?: string;
};

export type TargetFileSystem = {
  readonly maxFileBytes?: number;
  read(path: string, signal?: AbortSignal): Promise<Uint8Array>;
  write(path: string, content: Uint8Array, contentType?: string, signal?: AbortSignal): Promise<void>;
  append(path: string, content: Uint8Array, signal?: AbortSignal): Promise<void>;
  delete(path: string, signal?: AbortSignal): Promise<void>;
  mkdir(path: string, signal?: AbortSignal): Promise<void>;
  copy(source: string, destination: string, signal?: AbortSignal): Promise<string>;
  move(source: string, destination: string, signal?: AbortSignal): Promise<void>;
  list(path: string, signal?: AbortSignal): Promise<{ files: string[]; directories: string[] }>;
  stat(path: string, signal?: AbortSignal): Promise<FileStat>;
  exists(path: string, signal?: AbortSignal): Promise<boolean>;
  search(path: string, query: string, include?: string, signal?: AbortSignal): Promise<Array<{ path: string; line: number; content: string }>>;
  resolvePath(cwd: string, path: string): string;
  getAllPaths(signal?: AbortSignal): Promise<string[]>;
};

export function commandOk(stdout = ""): CommandResult {
  return { stdout, stderr: "", exitCode: 0 };
}

export function commandJson<T>(value: T): CommandResult {
  return commandOk(`${JSON.stringify(value, null, 2)}\n`);
}

export function commandError(message: string, exitCode = 1): CommandResult {
  return { stdout: "", stderr: `${message.replace(/\s+$/, "")}\n`, exitCode };
}
