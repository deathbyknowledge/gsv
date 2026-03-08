import type { ToolDefinition } from ".";
import { FS_DELETE, SYSCALL_TOOL_NAMES } from "./constants";

export const FS_WRITE_DEFINITION: ToolDefinition = {
  name: SYSCALL_TOOL_NAMES[FS_DELETE],
  description:
    "Delete a file. Use with caution, deleted files cannot be recovered.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to delete",
      },
    },
    required: ["path"],
  },
};

export type FsDeleteArgs = {
  path: string;
};

export type FsDeleteResult =
  | { ok: true; path: string }
  | { ok: false; error: string };
