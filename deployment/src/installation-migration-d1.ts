import * as z from "zod/mini";

export type MigrationD1Statement = { sql: string; params?: readonly string[] };
export type MigrationD1Row = Record<string, string | number | null | number[]>;
export type MigrationD1Database = {
  readonly identity: { accountId: string; databaseId: string };
  /** Every statement succeeds in one transaction, or none commits. */
  batch(statements: readonly MigrationD1Statement[]): Promise<MigrationD1Row[][]>;
};

const responseSchema = z.object({
  success: z.literal(true),
  result: z.array(z.object({ success: z.literal(true), results: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null(), z.array(z.number())]))) })),
});

/** The token is retained in memory only. Errors never include SQL, parameters, or response bodies. */
export function cloudflareMigrationD1(input: {
  accountId: string;
  databaseId: string;
  apiToken: string;
  fetch?: typeof fetch;
}): MigrationD1Database {
  if (!/^[a-f0-9]{32}$/.test(input.accountId)
    || !/^[a-f0-9-]{36}$/.test(input.databaseId) || !input.apiToken.trim()) {
    throw new Error("Migration runner requires explicit Cloudflare account, database, and authentication");
  }
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/d1/database/${input.databaseId}/query`;
  return {
    identity: { accountId: input.accountId, databaseId: input.databaseId },
    async batch(statements) {
      if (statements.length === 0) return [];
      if (statements.some((statement) => Buffer.byteLength(statement.sql, "utf8") > 100_000
        || (statement.params?.length ?? 0) > 100)) {
        throw new Error("Migration batch exceeds D1 query limits; no request was sent");
      }
      let response: Response;
      try {
        response = await (input.fetch ?? fetch)(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${input.apiToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ batch: statements }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch {
        throw new Error("D1 migration request failed; reconcile the durable operation before retrying");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`D1 migration request returned HTTP ${response.status}; reconcile before retrying`);
      }
      let decoded: z.infer<typeof responseSchema>;
      try {
        decoded = responseSchema.parse(await response.json());
      } catch {
        throw new Error("D1 migration batch failed or returned invalid evidence; reconcile before retrying");
      }
      if (decoded.result.length !== statements.length) {
        throw new Error("D1 migration batch returned an unexpected result count; reconcile before retrying");
      }
      return decoded.result.map((entry) => entry.results);
    },
  };
}

export async function migrationD1Read(
  database: MigrationD1Database, sql: string, params?: readonly string[],
): Promise<MigrationD1Row[]> {
  return (await database.batch([{ sql, params }]))[0];
}
