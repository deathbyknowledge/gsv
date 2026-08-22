import type { JsonValue } from "../json";

export type CodeModeExecArgs = {
  code: string;
};

export type CodeModeExecResult =
  | {
      status: "completed";
      result: JsonValue;
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
  args?: JsonValue;
};

export type CodeModeRunResult = CodeModeExecResult;
