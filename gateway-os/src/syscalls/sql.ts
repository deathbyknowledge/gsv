import type { ToolDefinition } from ".";
import { SQL_EXEC, SQL_QUERY, SYSCALL_TOOL_NAMES } from "./constants";

export type SqlBindingValue = string | number | null;

export type SqlTarget = string;

export type SqlRowValue =
  | string
  | number
  | null
  | {
      type: "blob";
      base64: string;
      bytes: number;
    };

export type SqlQueryArgs = {
  target?: SqlTarget;
  statement: string;
  bindings?: SqlBindingValue[];
};

export type SqlQueryRow = Record<string, SqlRowValue>;

export type SqlQueryResult =
  | {
      ok: true;
      target: SqlTarget;
      columns: string[];
      rows: SqlQueryRow[];
      rowCount: number;
      rowsRead: number;
      rowsWritten: number;
    }
  | { ok: false; error: string };

export type SqlExecArgs = {
  target?: SqlTarget;
  statement: string;
  bindings?: SqlBindingValue[];
};

export type SqlExecResult =
  | {
      ok: true;
      target: SqlTarget;
      rowsRead: number;
      rowsWritten: number;
    }
  | { ok: false; error: string };

export const SQL_QUERY_DEFINITION: ToolDefinition = {
  name: SYSCALL_TOOL_NAMES[SQL_QUERY],
  description:
    "Run a root-only SQL read against a live operator target. Defaults to target \"kernel\" for the main system database. A later target may include process:<pid>.",
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "SQL target. Defaults to \"kernel\" today. A later target may include process:<pid>.",
      },
      statement: {
        type: "string",
        description: "SQL statement to execute. Use sql.query for read/introspection statements.",
      },
      bindings: {
        type: "array",
        description: "Optional positional bindings for ? placeholders.",
        items: {
          anyOf: [
            { type: "string" },
            { type: "number" },
            { type: "null" },
          ],
        },
      },
    },
    required: ["statement"],
  },
};

export const SQL_EXEC_DEFINITION: ToolDefinition = {
  name: SYSCALL_TOOL_NAMES[SQL_EXEC],
  description:
    "Run a root-only SQL mutation against a live operator target. Defaults to target \"kernel\" today. This is a break-glass repair surface.",
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "SQL target. Defaults to \"kernel\" today. A later target may include process:<pid>.",
      },
      statement: {
        type: "string",
        description: "SQL statement to execute. Use sql.exec for mutations, DDL, and repairs.",
      },
      bindings: {
        type: "array",
        description: "Optional positional bindings for ? placeholders.",
        items: {
          anyOf: [
            { type: "string" },
            { type: "number" },
            { type: "null" },
          ],
        },
      },
    },
    required: ["statement"],
  },
};
