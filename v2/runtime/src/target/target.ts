import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { LINK_TABLE } from "../link.ts";
import { migrate, type Migration, type ObjectDescription } from "../schema.ts";

const MIGRATIONS: Migration[] = [{ version: 1, sql: LINK_TABLE }];

/** One machine: its key, presence, sessions, TTYs and transfers. The machine protocol arrives with M6. */
export class Target extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => { migrate(ctx.storage, MIGRATIONS); });
  }

  describe(): ObjectDescription {
    return { class: "Target", schema: MIGRATIONS.length };
  }
}
