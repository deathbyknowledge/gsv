import type { ToolDefinition } from ".";
import { FS_WRITE, SYSCALL_TOOL_NAMES } from "./constants";

export const FS_WRITE_DEFINITION: ToolDefinition = {
  name: SYSCALL_TOOL_NAMES[FS_WRITE],
  description:
    "Write or update a file. Creates parent directories if needed. Paths are relative to the current working directory unless absolute.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to write",
      },
      content: {
        type: "string",
        description: "Content to write to the file",
      },
    },
    required: ["path", "content"],
  },
};

export type {
  FsWriteArgs,
  FsWriteResult,
} from "@humansandmachines/gsv/protocol";
