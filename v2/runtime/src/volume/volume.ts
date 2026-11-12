import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { acceptLink, LINK_TABLE, type SpaceLink } from "../link.ts";
import { migrate, type Migration } from "../schema.ts";

const MIGRATIONS: Migration[] = [{
  version: 1,
  sql: `${LINK_TABLE}; CREATE TABLE volume (id INTEGER PRIMARY KEY CHECK (id = 1), volume TEXT NOT NULL, created_at INTEGER NOT NULL);`,
}];

/** File rows, revisions and folder indexes for one volume. Bytes live in the blob store, keyed by hash. */
export class Volume extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => { migrate(ctx.storage, MIGRATIONS); });
  }

  async init(input: SpaceLink & { owner: string; volume: string }): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      acceptLink(this.ctx.storage.sql, input.owner, input);
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO volume (id, volume, created_at) VALUES (1, ?, ?)", input.volume, Date.now());
    });
  }

  describe(): { class: string; schema: number } {
    return { class: "Volume", schema: MIGRATIONS.length };
  }
}
