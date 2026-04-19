import type { ToolDefinition } from ".";
import { FS_EDIT, SYSCALL_TOOL_NAMES } from "./constants";

export const FS_EDIT_DEFINITION: ToolDefinition = {
  name: SYSCALL_TOOL_NAMES[FS_EDIT],
  description:
    "Edit a file by replacing text. Paths are relative to the workspace unless absolute.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to edit",
      },
      oldString: {
        type: "string",
        description: "The exact text to find and replace",
      },
      newString: {
        type: "string",
        description: "The text to replace it with",
      },
      replaceAll: {
        type: "boolean",
        description:
          "Replace all occurrences (default: false, replace first only)",
      },
    },
    required: ["path", "oldString", "newString"],
  },
};

export type FsEditArgs = {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
};

export type FsEditResult =
  | { ok: true; path: string; replacements: number }
  | { ok: false; error: string };