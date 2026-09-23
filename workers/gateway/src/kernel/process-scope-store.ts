import { processScopePolicySchema, type ProcessScope, type ProcessScopePolicy } from "@humansandmachines/gsv/protocol";

type ScopeRow = {
  id: string; owner_uid: number; root_pid: string; revision: number; state: "active" | "revoked";
  policy_json: string; processes_used: number; generations_used: number; messages_used: number;
  expires_at: number; created_at: number;
};
type ScopeEffect = "processes" | "generations" | "messages";

/** Call multi-write admission methods inside the Kernel's synchronous transaction. */
export class ProcessScopeStore {
  constructor(private readonly sql: SqlStorage) {}

  create(ownerUid: number, rootPid: string, policy: ProcessScopePolicy, now = Date.now()): ProcessScope {
    const parsed = processScopePolicySchema.parse(policy);
    if (parsed.automatic) throw new Error("Automatic social help has been removed; enable Ship attention per contact instead");
    if (parsed.expiresAtMs <= now || parsed.expiresAtMs > now + 7 * 86_400_000) throw new Error("Process scope must expire within seven days");
    if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > 96 * 1_024) throw new Error("Process scope exceeds 96 KiB");
    if (new Set(parsed.materials.map((material) => material.name)).size !== parsed.materials.length) throw new Error("Material names must be unique");
    if (new Set(parsed.conversations.map((conversation) => conversation.conversationId)).size !== parsed.conversations.length) throw new Error("Conversation grants must be unique");
    this.prune(now);
    const retained = this.sql.exec<{ total: number; owned: number }>(
      "SELECT count(*) AS total, coalesce(sum(owner_uid = ?), 0) AS owned FROM process_scopes", ownerUid,
    ).one();
    if (retained.total >= 512 || retained.owned >= 64) throw new Error("Process scope capacity reached; remove finished helper processes first");
    const id = `scope:${crypto.randomUUID()}`;
    this.sql.exec("INSERT INTO process_scopes (id, owner_uid, root_pid, revision, state, policy_json, expires_at, created_at) VALUES (?, ?, ?, 1, 'active', ?, ?, ?)",
      id, ownerUid, rootPid, JSON.stringify(parsed), parsed.expiresAtMs, now);
    return this.get(id, now)!;
  }

  get(id: string, now = Date.now()): ProcessScope | null {
    const row = this.sql.exec<ScopeRow>("SELECT * FROM process_scopes WHERE id = ?", id).toArray()[0];
    return row ? {
      id: row.id, ownerUid: row.owner_uid, rootPid: row.root_pid, revision: row.revision,
      state: row.state === "revoked" ? "revoked" : row.expires_at <= now ? "expired" : "active",
      policy: processScopePolicySchema.parse(JSON.parse(row.policy_json)),
      used: { processes: row.processes_used, generations: row.generations_used, messages: row.messages_used }, createdAtMs: row.created_at,
    } : null;
  }

  forProcess(pid: string, now = Date.now()): ProcessScope | null {
    const row = this.sql.exec<{ scope_id: string | null }>("SELECT scope_id FROM processes WHERE process_id = ?", pid).toArray()[0];
    if (!row?.scope_id) return null;
    const scope = this.get(row.scope_id, now);
    if (!scope) throw new Error("Process scope is unavailable");
    return scope;
  }

  requireActive(id: string, expectedRevision?: number, now = Date.now()): ProcessScope {
    const scope = this.get(id, now);
    if (!scope || scope.state !== "active" || (expectedRevision !== undefined && scope.revision !== expectedRevision)) {
      throw new Error("Process scope is no longer active");
    }
    return scope;
  }

  /** Exact effect identities survive retries, eviction and parallel descendants. */
  consume(id: string, kind: ScopeEffect, effectId: string, expectedRevision: number, now = Date.now()): void {
    const scope = this.requireActive(id, expectedRevision, now);
    if (this.sql.exec("SELECT 1 FROM process_scope_effects WHERE scope_id = ? AND kind = ? AND effect_id = ?", id, kind, effectId).toArray().length) return;
    if (scope.used[kind] >= scope.policy.budgets[kind]) throw new Error(`Helper ${kind} allowance is exhausted; owner review is required`);
    const column = { processes: "processes_used", generations: "generations_used", messages: "messages_used" }[kind];
    this.sql.exec(`UPDATE process_scopes SET ${column} = ${column} + 1 WHERE id = ?`, id);
    this.sql.exec("INSERT INTO process_scope_effects (scope_id, kind, effect_id) VALUES (?, ?, ?)", id, kind, effectId);
  }

  revoke(id: string, ownerUid: number, expectedRevision: number): ProcessScope {
    const scope = this.get(id);
    if (!scope || scope.ownerUid !== ownerUid) throw new Error("Process scope not found");
    if (scope.state === "revoked" && scope.revision === expectedRevision + 1) return scope;
    if (scope.revision !== expectedRevision) throw new Error("Process scope changed; review it again");
    this.sql.exec("UPDATE process_scopes SET state = 'revoked', revision = revision + 1 WHERE id = ?", id);
    return this.get(id)!;
  }

  members(id: string): string[] {
    return this.sql.exec<{ process_id: string }>("SELECT process_id FROM processes WHERE scope_id = ? ORDER BY process_id", id).toArray().map((row) => row.process_id);
  }

  prune(now = Date.now()): void {
    const rows = this.sql.exec<{ id: string }>(`SELECT id FROM process_scopes WHERE created_at < ?
      AND NOT EXISTS (SELECT 1 FROM processes WHERE scope_id = process_scopes.id) LIMIT 64`, now - 86_400_000).toArray();
    for (const row of rows) {
      this.sql.exec("DELETE FROM process_scope_effects WHERE scope_id = ?", row.id);
      this.sql.exec("DELETE FROM process_scopes WHERE id = ?", row.id);
    }
  }
}
