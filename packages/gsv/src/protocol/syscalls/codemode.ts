export type CodeModeExecArgs = {
  code: string;
};

export type CodeModeExecResult =
  | {
      status: "completed";
      result: unknown;
      logs?: string[];
    }
  | {
      status: "failed";
      error: string;
      logs?: string[];
    };

export type CodeModeRunArgs = {
  pid?: string;
  code: string;
  target?: string;
  cwd?: string;
  argv?: string[];
  args?: unknown;
};

export type CodeModeRunResult = CodeModeExecResult;
