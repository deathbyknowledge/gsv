import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const manifestPayload = z.strictObject({
  version: z.literal(1), importId: z.uuid(), database: z.string().min(1).max(128), remote: z.boolean(),
  cutoff: z.number().int().nonnegative(),
  recipients: z.array(z.strictObject({ id: z.string().min(1).max(256),
    email: z.email().max(254).refine((email) => email === email.trim().toLowerCase()),
    verifiedAt: z.number().int().nonnegative(),
  })).max(5000),
});
const manifestSchema = manifestPayload.extend({ digest: z.string().regex(/^[a-f0-9]{64}$/) });

export function recipientQuery(cutoff) {
  if (!Number.isSafeInteger(cutoff) || cutoff < 0 || cutoff > Date.now()) throw new Error("Cutoff must be a past timestamp");
  return `SELECT p.id, p.primary_email_normalized AS email, p.email_verified_at AS verifiedAt
    FROM principals p WHERE p.state='active' AND p.email_verified_at IS NOT NULL
      AND p.created_at<=${cutoff} AND p.email_verified_at<=${cutoff}
      AND EXISTS (SELECT 1 FROM installations i WHERE i.owner_principal_id=p.id AND i.state='active' AND i.created_at<=${cutoff})
    ORDER BY p.primary_email_normalized, p.id`;
}

export function createManifest(database, remote, cutoff, recipients) {
  const payload = manifestPayload.parse({ version: 1, importId: randomUUID(), database, remote, cutoff, recipients });
  return { ...payload, digest: digest(payload) };
}

export function importSql(manifest, now = Date.now()) {
  const { digest: checksum, ...payload } = manifestSchema.parse(manifest);
  if (checksum !== digest(payload)) throw new Error("Manifest changed; create and review a new preview");
  recipientQuery(payload.cutoff);
  const seen = new Set();
  return payload.recipients.map((row) => {
    if (row.verifiedAt > payload.cutoff || seen.has(row.email)) throw new Error("Invalid or duplicate recipient");
    seen.add(row.email);
    const requestId = `${payload.importId}:${digest(row.email)}`;
    return `INSERT INTO product_email_signups
      (email,principal_id,request_id,wording_version,locale,requested_at,verified_at,due_at,source,consented_at,consent_basis,import_id)
      SELECT p.primary_email_normalized,p.id,${quote(requestId)},'unknown','und',${now},p.email_verified_at,${now},
        'ship-existing-user-backfill',NULL,'operator-confirmed-existing-opt-ins',${quote(payload.importId)}
      FROM principals p WHERE p.id=${quote(row.id)} AND p.primary_email_normalized=${quote(row.email)}
        AND p.email_verified_at=${row.verifiedAt} AND p.state='active' AND p.created_at<=${payload.cutoff}
        AND EXISTS (SELECT 1 FROM installations i WHERE i.owner_principal_id=p.id AND i.state='active' AND i.created_at<=${payload.cutoff})
      ON CONFLICT(email) DO UPDATE SET
        request_id=CASE WHEN consent_basis='unconfirmed-legacy-replay' THEN product_email_signups.request_id ELSE excluded.request_id END,
        wording_version=CASE WHEN consent_basis='unconfirmed-legacy-replay' THEN product_email_signups.wording_version ELSE excluded.wording_version END,
        locale=CASE WHEN consent_basis='unconfirmed-legacy-replay' THEN product_email_signups.locale ELSE excluded.locale END,
        requested_at=CASE WHEN consent_basis='unconfirmed-legacy-replay' THEN product_email_signups.requested_at ELSE excluded.requested_at END,
        verified_at=CASE WHEN consent_basis='unconfirmed-legacy-replay' THEN product_email_signups.verified_at ELSE excluded.verified_at END,
        consented_at=CASE WHEN consent_basis='unconfirmed-legacy-replay' THEN product_email_signups.consented_at ELSE NULL END,
        consent_basis=CASE WHEN consent_basis='unconfirmed-legacy-replay' THEN 'signup-checkbox' ELSE excluded.consent_basis END,
        due_at=excluded.due_at,import_id=excluded.import_id,attempts=0,last_error=NULL
      WHERE product_email_signups.principal_id=excluded.principal_id
        AND product_email_signups.consent_basis IN ('unconfirmed-legacy-backfill','unconfirmed-legacy-replay')
        AND product_email_signups.completed_at IS NULL;`;
  }).join("\n");
}

function execute(database, remote, sql, config, readOnly = false) {
  const directory = mkdtempSync(join(tmpdir(), "product-email-import-"));
  try {
    const file = join(directory, "query.sql");
    writeFileSync(file, sql, { mode: 0o600 });
    const args = ["exec", "--", "wrangler", "d1", "execute", database, remote ? "--remote" : "--local", "--json",
      ...(readOnly ? ["--command", sql] : ["--file", file])];
    if (config) args.push("--config", config);
    const result = JSON.parse(execFileSync("npm", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
    if (!Array.isArray(result) || result.some((item) => item.success === false)) throw new Error("D1 command failed");
    return result.flatMap((item) => item.results ?? []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    database: { type: "string" }, remote: { type: "boolean", default: false }, cutoff: { type: "string" },
    out: { type: "string" }, manifest: { type: "string" }, config: { type: "string" },
    "confirm-existing-opt-ins": { type: "boolean", default: false },
  } });
  if (positionals[0] === "preview" && values.database && values.cutoff && values.out) {
    const cutoff = Date.parse(values.cutoff);
    const recipients = execute(values.database, values.remote, recipientQuery(cutoff), values.config, true);
    const manifest = createManifest(values.database, values.remote, cutoff, recipients);
    importSql(manifest);
    writeFileSync(values.out, JSON.stringify(manifest, null, 2)+"\n", { mode: 0o600, flag: "wx" });
    console.log(`Preview saved: ${recipients.length} recipients. Review ${values.out} before applying.`);
    return;
  }
  if (positionals[0] === "apply" && values.manifest && values["confirm-existing-opt-ins"]) {
    const manifest = JSON.parse(readFileSync(values.manifest, "utf8"));
    const sql = importSql(manifest);
    if (manifest.remote !== values.remote || manifest.database !== values.database) throw new Error("Database and remote mode must match the reviewed manifest");
    if (sql) execute(manifest.database, manifest.remote, sql, values.config);
    const result = execute(manifest.database, manifest.remote,
      `SELECT COUNT(*) AS queued FROM product_email_signups WHERE import_id=${quote(manifest.importId)} AND completed_at IS NULL`, values.config, true);
    console.log(`Import ${manifest.importId}: ${result[0]?.queued ?? 0} pending. Existing signup choices and completed deliveries were preserved.`);
    return;
  }
  throw new Error("Use preview --database NAME --cutoff ISO --out FILE, then apply --database NAME --manifest FILE --confirm-existing-opt-ins. Add --remote explicitly for a remote database and --config PATH when needed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) { console.error(error instanceof Error ? error.message : "Product email import failed"); process.exitCode = 1; }
}
