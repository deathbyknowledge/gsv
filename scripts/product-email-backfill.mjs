import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function recipientQuery(cutoff) {
  if (!Number.isSafeInteger(cutoff) || cutoff < 0 || cutoff > Date.now()) throw new Error("Cutoff must be a past timestamp");
  return `SELECT p.id, p.primary_email_normalized AS email, p.email_verified_at AS verifiedAt
    FROM principals p WHERE p.state='active' AND p.email_verified_at IS NOT NULL
      AND p.created_at<=${cutoff} AND p.email_verified_at<=${cutoff}
      AND EXISTS (SELECT 1 FROM installations i WHERE i.owner_principal_id=p.id AND i.state='active' AND i.created_at<=${cutoff})
    ORDER BY p.primary_email_normalized, p.id`;
}

export function createManifest(database, remote, cutoff, recipients) {
  const payload = { version: 1, importId: randomUUID(), database, remote, cutoff, recipients };
  return { ...payload, digest: digest(payload) };
}

export function importSql(manifest, now = Date.now()) {
  const { digest: checksum, ...payload } = manifest;
  if (checksum !== digest(payload)) throw new Error("Manifest changed; create and review a new preview");
  if (payload.version !== 1 || typeof payload.database !== "string" || !payload.database || payload.database.length > 128
    || typeof payload.remote !== "boolean" || !/^[a-f0-9-]{36}$/.test(payload.importId)) throw new Error("Invalid manifest");
  recipientQuery(payload.cutoff);
  if (!Array.isArray(payload.recipients) || payload.recipients.length > 5000) throw new Error("Import supports at most 5000 recipients");
  const seen = new Set();
  return payload.recipients.map((row) => {
    if (typeof row.id !== "string" || !row.id || row.id.length > 256 || typeof row.email !== "string"
      || row.email.length > 254 || row.email !== row.email.trim().toLowerCase() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)
      || !Number.isSafeInteger(row.verifiedAt) || row.verifiedAt < 0 || row.verifiedAt > payload.cutoff
      || seen.has(row.email)) throw new Error("Invalid or duplicate recipient");
    seen.add(row.email);
    const requestId = `${payload.importId}:${digest(row.email)}`;
    return `INSERT INTO product_email_signups
      (email,principal_id,request_id,wording_version,locale,requested_at,verified_at,due_at,source,consented_at,consent_basis,import_id)
      SELECT p.primary_email_normalized,p.id,${quote(requestId)},'unknown','und',${now},p.email_verified_at,${now},
        'ship-existing-user-backfill',NULL,'operator-confirmed-existing-opt-ins',${quote(payload.importId)}
      FROM principals p WHERE p.id=${quote(row.id)} AND p.primary_email_normalized=${quote(row.email)}
        AND p.email_verified_at=${row.verifiedAt} AND p.state='active' AND p.created_at<=${payload.cutoff}
        AND EXISTS (SELECT 1 FROM installations i WHERE i.owner_principal_id=p.id AND i.state='active' AND i.created_at<=${payload.cutoff})
      ON CONFLICT(email) DO UPDATE SET request_id=excluded.request_id,wording_version=excluded.wording_version,
        locale=excluded.locale,requested_at=excluded.requested_at,verified_at=excluded.verified_at,due_at=excluded.due_at,
        consented_at=NULL,consent_basis=excluded.consent_basis,import_id=excluded.import_id,attempts=0,last_error=NULL
      WHERE product_email_signups.principal_id=excluded.principal_id
        AND product_email_signups.consent_basis='unconfirmed-legacy-backfill' AND product_email_signups.completed_at IS NULL;`;
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
