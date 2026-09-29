export type McpServerRecord = {
  serverId: string;
  uid: number;
  name: string;
  createdAt: number;
  updatedAt: number;
};

type McpServerRow = {
  server_id: string;
  uid: number;
  display_name: string;
  created_at: number;
  updated_at: number;
};

export class McpServerStore {
  constructor(private readonly sql: SqlStorage) {}

  upsert(input: {
    serverId: string;
    uid: number;
    name: string;
    now?: number;
  }): McpServerRecord {
    const now = input.now ?? Date.now();
    this.sql.exec(
      `INSERT INTO user_mcp_servers (
        server_id, uid, display_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(server_id) DO UPDATE SET
        uid = excluded.uid,
        display_name = excluded.display_name,
        updated_at = excluded.updated_at`,
      input.serverId,
      input.uid,
      input.name,
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
      "SELECT * FROM user_mcp_servers WHERE server_id = ?",
      serverId,
    ).toArray();
    return rows[0] ? recordFromRow(rows[0]) : null;
  }

  findByUidName(uid: number, name: string): McpServerRecord[] {
    const rows = this.sql.exec<McpServerRow>(
      "SELECT * FROM user_mcp_servers WHERE uid = ? AND display_name = ?",
      uid,
      name,
    ).toArray();
    return rows.map(recordFromRow);
  }

  list(uid?: number): McpServerRecord[] {
    const rows = uid === undefined
      ? this.sql.exec<McpServerRow>("SELECT * FROM user_mcp_servers ORDER BY updated_at DESC").toArray()
      : this.sql.exec<McpServerRow>(
        "SELECT * FROM user_mcp_servers WHERE uid = ? ORDER BY updated_at DESC",
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
      ? this.sql.exec("DELETE FROM user_mcp_servers WHERE server_id = ?", serverId)
      : this.sql.exec("DELETE FROM user_mcp_servers WHERE server_id = ? AND uid = ?", serverId, uid);
    return result.rowsWritten > 0;
  }
}

function recordFromRow(row: McpServerRow): McpServerRecord {
  return {
    serverId: row.server_id,
    uid: row.uid,
    name: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
