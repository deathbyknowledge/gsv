export type ShellExecArgs = {
  input: string;
  cwd?: string;
  sessionId?: string;
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
