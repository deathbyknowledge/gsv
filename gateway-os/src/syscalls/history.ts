import type { ToolDefinition } from ".";
import { FS_HISTORY, SYSCALL_TOOL_NAMES } from "./constants";

export const FS_HISTORY_DEFINITION: ToolDefinition = {
  name: SYSCALL_TOOL_NAMES[FS_HISTORY],
  description:
    "Show recent workspace changes for a file or directory, including checkpoint commit messages and touched paths.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Workspace file or directory to inspect (optional, defaults to the current workspace path)",
      },
      limit: {
        type: "number",
        description: "Maximum number of history entries to return (optional, default 12)",
      },
    },
    required: [],
  },
};

export type FsHistoryArgs = {
  path?: string;
  limit?: number;
};

export type FsHistoryChangeKind = "added" | "modified" | "deleted" | "renamed";

export type FsHistoryChange = {
  path: string;
  previousPath?: string | null;
  kind: FsHistoryChangeKind;
};

export type FsHistoryEntry = {
  commit: string;
  author: string;
  timestamp: number;
  message: string;
  changes: FsHistoryChange[];
};

export type FsHistoryResult =
  | { ok: true; entries: FsHistoryEntry[]; count: number; truncated?: boolean }
  | { ok: false; error: string };
