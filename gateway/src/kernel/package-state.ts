export class PackageState {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, _env: Env) {
    this.sql = ctx.storage.sql;
  }

  async sqlExec(statement: string, params: unknown[] = []): Promise<{ rowsWritten?: number }> {
    const cursor = this.sql.exec(statement, ...(Array.isArray(params) ? params : []));
    const rowsWritten = typeof cursor.rowsWritten === "number" ? cursor.rowsWritten : undefined;
    return { rowsWritten };
  }

  async sqlQuery(statement: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    const rows = this.sql.exec<Record<string, unknown>>(
      statement,
      ...(Array.isArray(params) ? params : []),
    ).toArray();
    return { rows };
  }
}
