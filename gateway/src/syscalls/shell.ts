import type { ToolDefinition } from ".";
import { SHELL_EXEC, SYSCALL_TOOL_NAMES } from "./constants";

export const SHELL_EXEC_DEFINITION: ToolDefinition = {
  name: SYSCALL_TOOL_NAMES[SHELL_EXEC],
  description:
    "Execute shell commands on a device. Supports async background mode with session tracking.",
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

export type ShellExecArgs = {
  command: string;
  workdir?: string;
  timeout?: number;
  background?: boolean;
  yieldMs?: number;
};

export type ShellExecResult =
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
