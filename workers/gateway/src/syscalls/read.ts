import type { ToolDefinition } from ".";
import { FS_READ, SYSCALL_TOOL_NAMES } from "./constants";

export const AGENT_READ_DEFAULT_LINE_LIMIT = 2_000;
export const AGENT_READ_MAX_BYTES = 64 * 1024;

export const FS_READ_DEFINITION: ToolDefinition = {
  name: SYSCALL_TOOL_NAMES[FS_READ],
  description:
    "Read a file or list a directory. If the path points to a file, returns its content. If the path points to a directory, lists the files and subdirectories.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file or directory to read.",
      },
      offset: {
        type: "number",
        description: "Line number to start reading from (0-based, optional)",
      },
      limit: {
        type: "number",
        description: `Maximum number of lines to read (optional; defaults to ${AGENT_READ_DEFAULT_LINE_LIMIT})`,
      },
    },
    required: ["path"],
  },
};

export type {
  FsReadArgs,
  FsReadResult,
} from "@humansandmachines/gsv/protocol";
