import type { ToolDefinition } from ".";
import { FS_READ, SYSCALL_TOOL_NAMES } from "./constants";

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
        description: "Maximum number of lines to read (optional)",
      },
    },
    required: ["path"],
  },
};

export type FsReadArgs = {
  path: string;
  offset?: number;
  limit?: number;
}

export type FsReadResult =
  | {
      ok: true;
      content: string | FsImageContent[];
      path: string;
      lines?: number;
      size: number;
    }
  | { ok: true; path: string; files: string[]; directories: string[] }
  | { ok: false; error: string };

export type FsImageContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };