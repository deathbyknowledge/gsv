import { parseArgs } from "node:util";
import { signOperatorToken } from "../src/gsv/operator-token.ts";

/**
 * The operator's command for the deployment's lexicon account:
 *
 *   npm run pds:lexicons -- status  --pds https://pds.example.com
 *   npm run pds:lexicons -- create  --pds https://pds.example.com --handle lexicons.example.com
 *   npm run pds:lexicons -- publish --pds https://pds.example.com
 *
 * `create` registers the account's DID with the PLC directory, which keeps it
 * for good. Each request is signed with the host's PLC rotation key, read from
 * GSV_PLC_ROTATION_KEY or the variable --key-env names; the key is never printed.
 */

const USAGE = "Use <status|create|publish> --pds <https-origin> [--handle <handle>] [--key-env <variable>]";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { pds: { type: "string" }, handle: { type: "string" }, "key-env": { type: "string", default: "GSV_PLC_ROTATION_KEY" } },
});
const [action] = positionals;
if (positionals.length !== 1 || !["status", "create", "publish"].includes(action) || !values.pds) fail(USAGE);
if (action === "create" && !values.handle) fail("create names the handle the deployment configures, with --handle");
const origin = URL.parse(values.pds);
if (origin?.protocol !== "https:" || origin.origin !== values.pds) fail("--pds must be the PDS's HTTPS origin, such as https://pds.example.com");
const rotationKey = process.env[values["key-env"]] ?? "";
if (!/^[0-9a-f]{64}$/.test(rotationKey)) fail(`${values["key-env"]} must hold the PDS's PLC rotation key, as 64 lowercase hex characters`);

const token = await signOperatorToken(rotationKey, { aud: origin.origin, act: action, handle: values.handle });
const response = await fetch(`${origin.origin}/operator/lexicons`, { method: "POST", headers: { Authorization: `Bearer ${token}` } })
  .catch((error) => fail(`Could not reach ${origin.origin}: ${error.message}`));
const body = await response.json().catch(() => fail(`${origin.origin} answered ${response.status}, not as a PDS`));
if (!response.ok) fail(`${body.error}: ${body.message}`);
process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
if (body.account) {
  process.stdout.write(`\nThe handle verifies with this DNS record:\n  _atproto.${body.account.handle}  TXT  "did=${body.account.did}"\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
