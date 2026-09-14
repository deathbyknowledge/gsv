import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as z from "zod/mini";
import { migrationD1Read, type MigrationD1Database } from "./installation-migration-d1.ts";

export type OperatorBootstrapAction = "issue" | "reissue-bootstrap" | "rotate-operator" | "revoke-operator";
export type OperatorBootstrapResult = { state: "issued" | "unchanged" | "rotated" | "revoked"; secret?: string };
const bootstrapSchema = z.object({ token_hash: z.string(), started_at: z.nullable(z.number()), access_mode: z.enum(["access", "operator"]) });

/** Deployment-owner access only. The returned secret must be disclosed to a local terminal, never deployment logs. */
export async function administerOperatorBootstrap(input: {
  database: MigrationD1Database;
  action: OperatorBootstrapAction;
  mode: "access" | "operator";
  now?: number;
}): Promise<OperatorBootstrapResult> {
  const { database, action, mode } = input;
  const now = String(input.now ?? Date.now());
  const rows = await migrationD1Read(database, "SELECT token_hash, started_at, access_mode FROM operator_bootstrap WHERE id = 1");
  const existing = rows.length ? bootstrapSchema.parse(rows[0]) : null;
  if (existing && existing.access_mode !== mode) throw new Error("Bootstrap access mode differs from deployed configuration");
  if (action === "revoke-operator") {
    if (mode !== "operator") throw new Error("This deployment uses Cloudflare Access");
    await database.batch([{ sql: "UPDATE operator_credentials SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = 1", params: [now, now] }]);
    return { state: "revoked" };
  }
  if (action === "issue" && existing) return { state: "unchanged" };
  if (action === "rotate-operator" && (!existing || existing.started_at === null || mode !== "operator")) {
    throw new Error("Operator recovery requires an already-started operator bootstrap; it never creates another first installation");
  }
  if (action === "reissue-bootstrap" && (!existing || existing.started_at !== null)) {
    throw new Error("Only an unstarted bootstrap can be reissued; recover operator access after redemption starts");
  }
  const secret = `${action === "rotate-operator" ? "operator" : "bootstrap"}_${Buffer.from(randomBytes(32)).toString("base64url")}`;
  const hash = createHash("sha256").update(secret).digest("hex");
  const prefix = secret.slice(0, 16);
  if (action === "rotate-operator") {
    await database.batch([{ sql: `INSERT INTO operator_credentials (id, token_prefix, token_hash, revoked_at, created_at, updated_at)
      SELECT 1, ?, ?, NULL, ?, ? FROM operator_bootstrap WHERE id = 1 AND access_mode = 'operator' AND started_at IS NOT NULL
      ON CONFLICT (id) DO UPDATE SET token_prefix = excluded.token_prefix, token_hash = excluded.token_hash,
        revoked_at = NULL, updated_at = excluded.updated_at`, params: [prefix, hash, now, now] }]);
    const credential = await migrationD1Read(database, "SELECT token_hash FROM operator_credentials WHERE id = 1 AND revoked_at IS NULL");
    if (credential[0]?.token_hash !== hash) throw new Error("Operator recovery did not commit this credential; retry explicit recovery");
    return { state: "rotated", secret };
  }
  const expiresAt = String(Number(now) + 60 * 60 * 1000);
  if (action === "issue") {
    const claimId = randomUUID();
    await database.batch([{ sql: `INSERT INTO operator_bootstrap
      (id, claim_id, token_prefix, token_hash, expires_at, access_mode, operation_id, created_at)
      SELECT 1, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM installations)
      ON CONFLICT (id) DO NOTHING`, params: [claimId, prefix, hash, expiresAt, mode, `bootstrap_${claimId}`, now] }]);
  } else {
    if (!existing) throw new Error("Bootstrap is unavailable");
    await database.batch([{ sql: `UPDATE operator_bootstrap SET token_prefix = ?, token_hash = ?, expires_at = ?
      WHERE id = 1 AND token_hash = ? AND started_at IS NULL AND NOT EXISTS (SELECT 1 FROM installations)`,
      params: [prefix, hash, expiresAt, existing.token_hash] }]);
  }
  const after = await migrationD1Read(database, "SELECT token_hash FROM operator_bootstrap WHERE id = 1");
  if (after[0]?.token_hash !== hash) {
    if (action === "issue") return { state: "unchanged" };
    throw new Error("Bootstrap changed or an installation already exists; no replacement link was disclosed");
  }
  return { state: "issued", secret };
}
