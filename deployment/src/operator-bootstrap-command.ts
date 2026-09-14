import { closeSync, openSync, writeSync } from "node:fs";
import { isatty } from "node:tty";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as z from "zod/mini";
import { cloudflareMigrationD1 } from "./installation-migration-d1.ts";
import { administerOperatorBootstrap } from "./operator-bootstrap.ts";

/** Opening the controlling terminal is required before mutation; redirected stdout never receives credentials. */
export async function operatorBootstrapMain(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    account: { type: "string" }, database: { type: "string" }, origin: { type: "string" }, mode: { type: "string" },
  } });
  const action = z.enum(["issue", "reissue-bootstrap", "rotate-operator", "revoke-operator"]).parse(positionals[0]);
  const mode = z.enum(["access", "operator"]).parse(values.mode);
  if (positionals.length !== 1 || !values.origin) throw new Error("Use <issue|reissue-bootstrap|rotate-operator|revoke-operator> --account <id> --database <id> --origin <https-origin> --mode <access|operator>");
  const origin = new URL(values.origin);
  if (origin.protocol !== "https:" || origin.origin !== values.origin) throw new Error("An exact HTTPS administration origin is required");
  const database = cloudflareMigrationD1({ accountId: values.account ?? "", databaseId: values.database ?? "", apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "" });
  let terminal: number;
  try { terminal = openSync("/dev/tty", "w"); }
  catch { throw new Error("Operator bootstrap requires a local controlling terminal; no database change was attempted"); }
  try {
    if (!isatty(terminal)) throw new Error("Operator bootstrap requires a local controlling terminal; no database change was attempted");
    const result = await administerOperatorBootstrap({ database, action, mode });
    if (result.secret) {
      const disclosed = result.state === "rotated" ? result.secret : `${origin.origin}/bootstrap#${result.secret}`;
      writeSync(terminal, `\n${result.state === "rotated" ? "Save the replacement operator credential" : "Open the one-time bootstrap link"} now. It will not be printed again.\n${disclosed}\n\n`);
    }
    process.stdout.write(`${JSON.stringify({ state: result.state })}\n`);
  } finally { closeSync(terminal); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await operatorBootstrapMain(); }
  catch {
    process.stderr.write("Operator command did not complete. No credentials were logged. Inspect status and use explicit reissue/recovery if the database request may have committed.\n");
    process.exitCode = 1;
  }
}
