import type { ToolDefinition } from ".";
import { SHELL_EXEC, SYSCALL_TOOL_NAMES } from "./constants";

export const SHELL_EXEC_DEFINITION: ToolDefinition = {
  name: SYSCALL_TOOL_NAMES[SHELL_EXEC],
  description:
    "Run a shell command or continue a running shell session. New commands use input as the command; calls with sessionId use input as stdin, with an empty string polling for more output.",
  inputSchema: {
    type: "object",
    properties: {
      input: {
        type: "string",
        description:
          "Command to start when sessionId is absent. Stdin to send when sessionId is present. Use an empty string with sessionId to poll for more output.",
      },
      cwd: {
        type: "string",
        description: "Working directory for a new command.",
      },
      sessionId: {
        type: "string",
        description:
          "Existing shell session to poll or write stdin to. Omit for a new command.",
      },
    },
    required: ["input"],
  },
};

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
