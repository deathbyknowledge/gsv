import type { SysMcpTransportType } from "@gsv/protocol/syscalls/system";

export type McpServerRecord = {
  serverId: string;
  uid: number;
  name: string;
  url: string;
  transport: SysMcpTransportType;
  createdAt: number;
  updatedAt: number;
};

type McpServerRow = {
  server_id: string;
  uid: number;
  name: string;
  url: string;
  transport: string;
  created_at: number;
  updated_at: number;
};

export class McpServerStore {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        server_id  TEXT PRIMARY KEY NOT NULL,
        uid        INTEGER NOT NULL,
        name       TEXT NOT NULL,
        url        TEXT NOT NULL,
        transport  TEXT NOT NULL DEFAULT 'auto',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.sql.exec("DROP INDEX IF EXISTS idx_mcp_servers_uid_url");
    this.sql.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_uid_name_url
      ON mcp_servers(uid, name, url)
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_mcp_servers_uid
      ON mcp_servers(uid)
    `);
  }

  upsert(input: {
    serverId: string;
    uid: number;
    name: string;
    url: string;
    transport: SysMcpTransportType;
    now?: number;
  }): McpServerRecord {
    const now = input.now ?? Date.now();
    this.sql.exec(
      `INSERT INTO mcp_servers (
        server_id, uid, name, url, transport, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id) DO UPDATE SET
        name = excluded.name,
        url = excluded.url,
        transport = excluded.transport,
        updated_at = excluded.updated_at`,
      input.serverId,
      input.uid,
      input.name,
      input.url,
      input.transport,
      now,
      now,
    );
    const record = this.get(input.serverId);
    if (!record) {
      throw new Error("Failed to store MCP server record");
    }
    return record;
  }

  get(serverId: string): McpServerRecord | null {
    const rows = this.sql.exec<McpServerRow>(
      "SELECT * FROM mcp_servers WHERE server_id = ?",
      serverId,
    ).toArray();
    return rows[0] ? recordFromRow(rows[0]) : null;
  }

  findByUidNameUrl(uid: number, name: string, url: string): McpServerRecord | null {
    const rows = this.sql.exec<McpServerRow>(
      "SELECT * FROM mcp_servers WHERE uid = ? AND name = ? AND url = ?",
      uid,
      name,
      url,
    ).toArray();
    return rows[0] ? recordFromRow(rows[0]) : null;
  }

  list(uid?: number): McpServerRecord[] {
    const rows = uid === undefined
      ? this.sql.exec<McpServerRow>("SELECT * FROM mcp_servers ORDER BY updated_at DESC").toArray()
      : this.sql.exec<McpServerRow>(
        "SELECT * FROM mcp_servers WHERE uid = ? ORDER BY updated_at DESC",
        uid,
      ).toArray();
    return rows.map(recordFromRow);
  }

  delete(serverId: string, uid?: number): boolean {
    const record = this.get(serverId);
    if (!record) {
      return false;
    }
    if (uid !== undefined && record.uid !== uid) {
      return false;
    }
    const result = uid === undefined
      ? this.sql.exec("DELETE FROM mcp_servers WHERE server_id = ?", serverId)
      : this.sql.exec("DELETE FROM mcp_servers WHERE server_id = ? AND uid = ?", serverId, uid);
    return result.rowsWritten > 0;
  }
}

function recordFromRow(row: McpServerRow): McpServerRecord {
  return {
    serverId: row.server_id,
    uid: row.uid,
    name: row.name,
    url: row.url,
    transport: parseTransport(row.transport),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseTransport(value: string): SysMcpTransportType {
  if (value === "streamable-http" || value === "sse") {
    return value;
  }
  return "auto";
}
