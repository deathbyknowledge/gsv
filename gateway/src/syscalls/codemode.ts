import type { ToolDefinition } from ".";
import { CODEMODE_EXEC, SYSCALL_TOOL_NAMES } from "./constants";

export const CODEMODE_EXEC_DEFINITION: ToolDefinition = {
  name: SYSCALL_TOOL_NAMES[CODEMODE_EXEC],
  description:
    "Run an async JavaScript CodeMode block in an isolated Worker. Use this for multi-step tool workflows. Inside the block, call await shell(input, { target?, cwd?, sessionId? }) and fs.read/write/edit/delete/search(args). Shell may return status=\"running\"; poll with await shell(\"\", { sessionId }). Return a JSON-serializable value. The tool returns { status: \"completed\", result, logs? } or { status: \"failed\", error, logs? }.",
  inputSchema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "JavaScript or TypeScript-like code to execute. Top-level await is supported. Return the final value explicitly, or leave a final expression to return it.",
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
