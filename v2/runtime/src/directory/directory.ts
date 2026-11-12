import { DurableObject } from "cloudflare:workers";
import { GsvFailure } from "@gsv/catalog";
import type { Env } from "../env.ts";
import { migrate, type Migration } from "../schema.ts";
import { sha256Hex } from "../token.ts";

const MIGRATIONS: Migration[] = [{
  version: 1,
  sql: `
    CREATE TABLE names (name TEXT PRIMARY KEY, kind TEXT NOT NULL, space TEXT NOT NULL, owner TEXT, generation INTEGER NOT NULL);
    CREATE TABLE operations (id TEXT PRIMARY KEY, kind TEXT NOT NULL, input TEXT NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER);
    CREATE TABLE setup (code_hash TEXT PRIMARY KEY, operation TEXT NOT NULL REFERENCES operations (id));
  `,
}];

export type NameEntry = { space: string; owner: string | null; generation: number };
type SetupInput = { space: string; uid: string; handle: string; name: string };

/** Hostnames and handles to ids, and signup provisioning. Off the signed-in path: only first contact by name reads it. */
export class Directory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => { migrate(ctx.storage, MIGRATIONS); });
  }

  resolve(name: string): NameEntry | null {
    return this.ctx.storage.sql.exec<NameEntry>("SELECT space, owner, generation FROM names WHERE name = ?", name).toArray()[0] ?? null;
  }

  /**
   * Redeems the deployment's one-time setup code for the operator space. The code is single use and
   * expires; a retry after a partial failure resumes the same provisioning operation.
   */
  async setup(code: string, name: string): Promise<{ host: string; token: string; expiresAt: number }> {
    const [expiresAt, expected] = (this.env.GSV_SETUP ?? "").split(".");
    const codeHash = await sha256Hex(code);
    if (!expected || codeHash !== expected || Number(expiresAt) <= Date.now()) throw new GsvFailure("forbidden", "This setup link isn't valid. Print a new one with gsv deploy --setup, or gsv dev --setup locally.");
    const sql = this.ctx.storage.sql;
    const handle = this.env.GSV_OPERATOR_SPACE;
    const operation = this.ctx.storage.transactionSync(() => {
      const existing = sql.exec<{ id: string; input: string; finished_at: number | null }>(
        "SELECT o.id, o.input, o.finished_at FROM setup s JOIN operations o ON o.id = s.operation WHERE s.code_hash = ?", codeHash,
      ).toArray()[0];
      if (existing?.finished_at) throw new GsvFailure("forbidden", "This setup link was already used.");
      if (existing) return { id: existing.id, input: JSON.parse(existing.input) as SetupInput };
      if (this.resolve(handle)) throw new GsvFailure("conflict", "The operator space already exists.");
      const input: SetupInput = { space: crypto.randomUUID(), uid: crypto.randomUUID(), handle, name };
      const id = crypto.randomUUID();
      sql.exec("INSERT INTO operations (id, kind, input, created_at) VALUES (?, 'setup', ?, ?)", id, JSON.stringify(input), Date.now());
      sql.exec("INSERT INTO setup (code_hash, operation) VALUES (?, ?)", codeHash, id);
      sql.exec("INSERT INTO names (name, kind, space, owner, generation) VALUES (?, 'handle', ?, NULL, 1)", handle, input.space);
      return { id, input };
    });
    const { space, uid } = operation.input;
    const host = `${handle}.${this.env.GSV_DOMAIN}`;
    const session = await this.env.SPACE.getByName(space).create({ space, handle, host, person: { uid, name: operation.input.name } });
    sql.exec("UPDATE operations SET finished_at = ? WHERE id = ?", Date.now(), operation.id);
    return { host, ...session };
  }

  describe(): { class: string; schema: number } {
    return { class: "Directory", schema: MIGRATIONS.length };
  }
}
