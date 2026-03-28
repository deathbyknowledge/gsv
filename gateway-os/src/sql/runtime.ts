import type {
  SqlBindingValue,
  SqlExecArgs,
  SqlExecResult,
  SqlQueryArgs,
  SqlQueryResult,
  SqlRowValue,
} from "../syscalls/sql";

export type SqlTargetRef =
  | { kind: "kernel"; raw: "kernel" }
  | { kind: "process"; raw: string; pid: string };

const READ_STATEMENT_PREFIXES = new Set(["SELECT", "PRAGMA", "EXPLAIN"]);
const MUTATION_STATEMENT_PREFIXES = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
  "CREATE",
  "ALTER",
  "DROP",
  "VACUUM",
  "ATTACH",
  "DETACH",
  "REINDEX",
  "ANALYZE",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
]);

export type PreparedSqlQuery = {
  target: SqlTargetRef;
  statement: string;
  bindings: SqlBindingValue[];
};

export type PreparedSqlExec = PreparedSqlQuery;

export function requireSqlRoot(
  uid: number | null | undefined,
  syscall: "sql.query" | "sql.exec",
): void {
  if (uid !== 0) {
    throw new Error(`Permission denied: ${syscall} requires root`);
  }
}

export function parseSqlTarget(target: unknown): SqlTargetRef {
  const raw = typeof target === "string" ? target.trim() : "";
  if (!raw) {
    return { kind: "kernel", raw: "kernel" };
  }

  if (raw === "kernel") {
    return { kind: "kernel", raw: "kernel" };
  }

  if (raw.startsWith("process:")) {
    const pid = raw.slice("process:".length).trim();
    if (!pid) {
      throw new Error("SQL target process:<pid> requires a pid");
    }
    return { kind: "process", raw, pid };
  }

  throw new Error(`Unsupported SQL target: ${raw}`);
}

export function prepareSqlQuery(args: SqlQueryArgs): PreparedSqlQuery {
  const target = parseSqlTarget(args.target);
  const statement = requireStatement(args.statement, "sql.query");
  const bindings = normalizeBindings(args.bindings, "sql.query");
  const verb = leadingSqlVerb(statement);

  if (verb && MUTATION_STATEMENT_PREFIXES.has(verb)) {
    throw new Error(`sql.query only accepts read statements; use sql.exec for ${verb}`);
  }

  return { target, statement, bindings };
}

export function prepareSqlExec(args: SqlExecArgs): PreparedSqlExec {
  const target = parseSqlTarget(args.target);
  const statement = requireStatement(args.statement, "sql.exec");
  const bindings = normalizeBindings(args.bindings, "sql.exec");
  const verb = leadingSqlVerb(statement);

  if (verb && READ_STATEMENT_PREFIXES.has(verb)) {
    throw new Error(`sql.exec only accepts mutation statements; use sql.query for ${verb}`);
  }

  return { target, statement, bindings };
}

export function executeSqlQuery(
  sql: SqlStorage,
  target: SqlTargetRef,
  statement: string,
  bindings: SqlBindingValue[],
): SqlQueryResult {
  const cursor = sql.exec<Record<string, SqlStorageValue>>(statement, ...bindings);
  const columns = [...cursor.columnNames];
  const rows = cursor.toArray().map((row) => serializeRow(columns, row));

  return {
    ok: true,
    target: target.raw,
    columns,
    rows,
    rowCount: rows.length,
    rowsRead: cursor.rowsRead,
    rowsWritten: cursor.rowsWritten,
  };
}

export function executeSqlExec(
  sql: SqlStorage,
  target: SqlTargetRef,
  statement: string,
  bindings: SqlBindingValue[],
): SqlExecResult {
  const cursor = sql.exec<Record<string, SqlStorageValue>>(statement, ...bindings);
  if (cursor.columnNames.length > 0) {
    throw new Error("sql.exec does not return row sets; use sql.query");
  }

  return {
    ok: true,
    target: target.raw,
    rowsRead: cursor.rowsRead,
    rowsWritten: cursor.rowsWritten,
  };
}

export function isProcessSqlTargetSelf(target: SqlTargetRef, pid: string): boolean {
  return target.kind === "process" && target.pid === pid;
}

export function auditSql(
  source: "Kernel" | "Process",
  syscall: "sql.query" | "sql.exec",
  uid: number | null | undefined,
  target: string,
  statement: string,
  bindingCount: number,
): void {
  const verb = leadingSqlVerb(statement) ?? "UNKNOWN";
  console.info(`[${source}][${syscall}] uid=${uid ?? -1} target=${target} verb=${verb} bindings=${bindingCount}`);
}

function requireStatement(statement: unknown, syscall: string): string {
  const normalized = typeof statement === "string" ? statement.trim() : "";
  if (!normalized) {
    throw new Error(`${syscall} requires a SQL statement`);
  }
  return normalized;
}

function normalizeBindings(bindings: unknown, syscall: string): SqlBindingValue[] {
  if (bindings === undefined) {
    return [];
  }
  if (!Array.isArray(bindings)) {
    throw new Error(`${syscall} bindings must be an array`);
  }

  return bindings.map((value, index) => {
    if (value === null || typeof value === "string" || typeof value === "number") {
      return value;
    }
    throw new Error(`${syscall} binding ${index} must be a string, number, or null`);
  });
}

function leadingSqlVerb(statement: string): string | null {
  const match = statement.match(/^\s*([A-Za-z]+)/);
  return match ? match[1].toUpperCase() : null;
}

function serializeRow(
  columns: string[],
  row: Record<string, SqlStorageValue>,
): Record<string, SqlRowValue> {
  const serialized: Record<string, SqlRowValue> = {};
  for (const column of columns) {
    serialized[column] = serializeValue(row[column] ?? null);
  }
  return serialized;
}

function serializeValue(value: SqlStorageValue): SqlRowValue {
  if (value === null || typeof value === "string" || typeof value === "number") {
    return value;
  }

  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(0);
  return {
    type: "blob",
    base64: bytesToBase64(bytes),
    bytes: bytes.byteLength,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
