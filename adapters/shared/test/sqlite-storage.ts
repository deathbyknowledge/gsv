import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

type SqlRow = Record<string, SqlStorageValue>;
type NodeSqlRow = Record<string, SQLOutputValue>;

/** Node-backed fixture for the synchronous Durable Object SQLite surface. */
export class TestDurableObjectStorage {
  private readonly database = new DatabaseSync(":memory:");
  alarm: number | null = null;
  clearAlarmOnChunkWrite = false;

  // SAFETY: The fixture implements every SqlStorage member exercised by the
  // production stores; unsupported members are deliberately unreachable here.
  readonly sql = {
    exec: <T extends SqlRow>(query: string, ...bindings: SqlStorageValue[]) => {
      const statement = this.database.prepare(query);
      // SAFETY: Test query callsites supply T from their SELECT projection, and
      // normalizeRow converts Node BLOBs and integers to SqlStorageValue.
      const rows = statement.all(...bindings.map(databaseBinding)).map(normalizeRow) as T[];
      if (
        this.clearAlarmOnChunkWrite
        && query.includes("INSERT INTO adapter_peer_delivery_chunks")
      ) {
        this.clearAlarmOnChunkWrite = false;
        this.alarm = null;
      }
      return sqlCursor(rows);
    },
  } as SqlStorage;

  asDurableStorage(): DurableObjectStorage {
    // SAFETY: The fixture implements the SQL, transaction, and alarm methods
    // exercised by adapter peer state.
    return this as DurableObjectStorage;
  }

  transactionSync<T>(closure: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = closure();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async transaction<T>(
    closure: (txn: TestDurableObjectStorage) => Promise<T>,
  ): Promise<T> {
    const previousAlarm = this.alarm;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = await closure(this);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      this.alarm = previousAlarm;
      throw error;
    }
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(value: number | Date): Promise<void> {
    this.alarm = value instanceof Date ? value.getTime() : value;
  }

  rows<T extends SqlRow>(query: string, ...bindings: SqlStorageValue[]): T[] {
    return this.sql.exec<T>(query, ...bindings).toArray();
  }
}

function databaseBinding(value: SqlStorageValue): string | number | null | Uint8Array {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

function normalizeRow(row: NodeSqlRow): SqlRow {
  // SAFETY: SQLOutputValue differs from SqlStorageValue only for Node BLOBs and
  // bigint; both are normalized to the corresponding Workers representation.
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    value instanceof Uint8Array
      ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
      : value as SqlStorageValue,
  ])) as SqlRow;
}

function sqlCursor<T extends SqlRow>(rows: T[]): SqlStorageCursor<T> {
  // SAFETY: The fixture implements the cursor operations used by production
  // code and tests over the fully materialized row set.
  return {
    toArray: () => [...rows],
    one: () => {
      if (rows.length !== 1) {
        throw new Error(`Expected exactly one SQL row, got ${rows.length}`);
      }
      return rows[0];
    },
  } as SqlStorageCursor<T>;
}
