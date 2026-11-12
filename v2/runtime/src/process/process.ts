import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { LINK_TABLE } from "../link.ts";
import { migrate, type Migration, type ObjectDescription } from "../schema.ts";

const MIGRATIONS: Migration[] = [{ version: 1, sql: LINK_TABLE }];

/** One process: records, runs, epochs and its inbox. The loop arrives with M4. */
export class Process extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => { migrate(ctx.storage, MIGRATIONS); });
  }

  describe(): ObjectDescription {
    return { class: "Process", schema: MIGRATIONS.length };
  }
}
