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
        description: "Directory or file to search in (optional, defaults to current working directory)",
      },
      include: {
        type: "string",
        description: "Glob pattern to filter files (e.g. \"*.ts\", \"*.json\")",
      },
    },
    required: ["query"],
  },
};

export type {
  FsSearchArgs,
  FsSearchMatch,
  FsSearchResult,
} from "@humansandmachines/gsv/protocol";
