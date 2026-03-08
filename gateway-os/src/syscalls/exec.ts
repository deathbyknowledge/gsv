import type { ToolDefinition } from ".";
import { PROC_EXEC, SYSCALL_TOOL_NAMES } from "./constants";

export const PROC_EXEC_DEFINITION: ToolDefinition = {
  name: SYSCALL_TOOL_NAMES[PROC_EXEC],
  description:
    "Execute shell commands. Supports async background mode with session tracking.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to execute",
      },
      workdir: {
        type: "string",
        description: "Working directory",
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (optional)",
      },
      background: {
        type: "boolean",
        description: "Run in background immediately and return a pid",
      },
      yieldMs: {
        type: "number",
        description:
          "Wait this many milliseconds, then background if still running",
      },
    },
    required: ["command"],
  },
};

export type ExecArgs = {
  command: string;
  workdir?: string;
  timeout?: number;
  background?: boolean;
  yieldMs?: number;
};

export type ExecResult =
  | {
      ok: true;
      pid: number;
      exitCode: number;
      stdout: string;
      stderr: string;
    }
  | {
      ok: true;
      pid: number;
      backgrounded: true;
    }
  | { ok: false; error: string };

export type ProcessInfo = {
  pid: number;
  command: string;
  running: boolean;
  startedAt: number;
  exitCode?: number;
};
