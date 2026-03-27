import type { ToolDefinition } from ".";
import { FS_SEARCH, SYSCALL_TOOL_NAMES } from "./constants";

export const FS_SEARCH_DEFINITION: ToolDefinition = {
  name: SYSCALL_TOOL_NAMES[FS_SEARCH],
  description:
    "Search file contents using plain text. Returns matching lines with file paths and line numbers.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Plain text to search for",
      },
      path: {
        type: "string",
        description: "Directory or file to search in (optional, defaults to workspace root)",
      },
      include: {
        type: "string",
        description: "Glob pattern to filter files (e.g. \"*.ts\", \"*.json\")",
      },
    },
    required: ["query"],
  },
};

export type FsSearchArgs = {
  query: string;
  path?: string;
  include?: string;
};

export type FsSearchMatch = {
  path: string;
  line: number;
  content: string;
};

export type FsSearchResult =
  | { ok: true; matches: FsSearchMatch[]; count: number; truncated?: boolean }
  | { ok: false; error: string };
