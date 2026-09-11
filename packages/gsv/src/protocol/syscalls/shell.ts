export const DEFAULT_SHELL_EXEC_TIMEOUT_MS = 120_000;

export type ShellCancelArgs = {
  target?: string;
  sessionId: string;
};

export type ShellCancelResult = {
  sessionId: string;
  /** True when this request stopped a running command; false if it had already ended. */
  cancelled: boolean;
};

export type ShellExecArgs = {
  target?: string;
  input: string;
  cwd?: string;
  sessionId?: string;
  /**
   * Start under a fresh caller-persisted UUID instead of resuming sessionId. Never replay a start.
   * Machine starts detach immediately; the first poll consumes output, not the start acknowledgement.
   */
  start?: boolean;
  /** Maximum runtime in milliseconds for a new command. */
  timeout?: number;
  background?: boolean;
  yieldMs?: number;
};

export type ShellExecResult =
  | {
      status: "completed";
      output: string;
      exitCode: number;
      sessionId?: string;
      truncated?: boolean;
      ok?: true;
      pid?: number;
      stdout?: string;
      stderr?: string;
    }
  | {
      status: "running";
      output: string;
      sessionId: string;
      truncated?: boolean;
    }
  | {
      status: "failed";
      output: string;
      error: string;
      exitCode?: number;
      sessionId?: string;
      truncated?: boolean;
      ok?: boolean;
      pid?: number;
      stdout?: string;
      stderr?: string;
    };
