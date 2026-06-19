import type { GsvDriverHandler } from "@humansandmachines/gsv/client";

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
  copyTargetFile?: (source: TargetCopyEndpoint, destination: TargetCopyEndpoint) => Promise<unknown>;
};

export type DriverHandler = GsvDriverHandler;

export type FileStat = {
  path: string;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  contentType?: string;
};

export type TargetFileSystem = {
  read(path: string): Promise<Uint8Array>;
  write(path: string, content: Uint8Array, contentType?: string): Promise<void>;
  append(path: string, content: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  copy(source: string, destination: string): Promise<string>;
  move(source: string, destination: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; directories: string[] }>;
  stat(path: string): Promise<FileStat>;
  exists(path: string): Promise<boolean>;
  search(path: string, query: string, include?: string): Promise<Array<{ path: string; line: number; content: string }>>;
  resolvePath(cwd: string, path: string): string;
  getAllPaths(): Promise<string[]>;
};

export function commandOk(stdout = ""): CommandResult {
  return { stdout, stderr: "", exitCode: 0 };
}

export function commandJson(value: unknown): CommandResult {
  return commandOk(`${JSON.stringify(value, null, 2)}\n`);
}

export function commandError(message: string, exitCode = 1): CommandResult {
  return { stdout: "", stderr: `${message.replace(/\s+$/, "")}\n`, exitCode };
}
