import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { migrate, type Migration, type ObjectDescription } from "../schema.ts";
import { issueSession } from "../token.ts";

const MIGRATIONS: Migration[] = [{
  version: 1,
  sql: `
    CREATE TABLE space (id INTEGER PRIMARY KEY CHECK (id = 1), space TEXT NOT NULL, handle TEXT NOT NULL, lifecycle TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE people (uid TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin', 'member')), epoch INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE owners (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('person', 'team')), created_at INTEGER NOT NULL);
  `,
}];

type CreateSpace = { space: string; handle: string; host: string; person: { uid: string; name: string } };

/** People, membership, grants and sign-in for one space. Its only connection traffic is sign-in. */
export class Space extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => { migrate(ctx.storage, MIGRATIONS); });
  }

  /** Creates the space with its first person as admin, idempotently, and signs that person in. */
  async create(input: CreateSpace): Promise<{ token: string; expiresAt: number }> {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      sql.exec("INSERT OR IGNORE INTO space (id, space, handle, lifecycle, created_at) VALUES (1, ?, ?, 'active', ?)", input.space, input.handle, now);
      sql.exec("INSERT OR IGNORE INTO people (uid, name, role, epoch, created_at) VALUES (?, ?, 'admin', 1, ?)", input.person.uid, input.person.name, now);
      sql.exec("INSERT OR IGNORE INTO owners (id, kind, created_at) VALUES (?, 'person', ?)", input.person.uid, now);
    });
    const { epoch } = sql.exec<{ epoch: number }>("SELECT epoch FROM people WHERE uid = ?", input.person.uid).one();
    await this.env.OWNER.getByName(input.person.uid).init({ owner: input.person.uid, kind: "person", space: input.space, generation: 1, epoch });
    return issueSession(this.env.GSV_SECRET, { uid: input.person.uid, space: input.space, host: input.host, epoch });
  }

  describe(): ObjectDescription {
    return { class: "Space", schema: MIGRATIONS.length };
  }
}
