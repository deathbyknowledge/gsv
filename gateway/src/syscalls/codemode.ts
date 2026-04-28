import type { ToolDefinition } from ".";
import { CODEMODE_EXEC, SYSCALL_TOOL_NAMES } from "./constants";

export const CODEMODE_EXEC_DEFINITION: ToolDefinition = {
  name: SYSCALL_TOOL_NAMES[CODEMODE_EXEC],
  description:
    "Run a JavaScript CodeMode script in an isolated Worker for multi-step tool workflows. The code is treated as the body of an async function: top-level await works, and the final value must be returned explicitly. Available globals: shell(input, { target?, cwd?, sessionId? }), fs.read/write/edit/delete/search(args), argv, and args. Shell may return status=\"running\"; poll with await shell(\"\", { sessionId }). Return a JSON-serializable value. The tool returns { status: \"completed\", result, logs? } or { status: \"failed\", error, logs? }.",
  inputSchema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "JavaScript code to execute as an async function body. Top-level await is supported. Use an explicit return statement for the final value; do not use TypeScript-only syntax.",
      },
    },
    required: ["code"],
  },
};

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
