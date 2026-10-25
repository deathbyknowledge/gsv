import { parseArgs } from "node:util";
import { signOperatorToken } from "../src/gsv/operator-token.ts";

/**
 * The operator's audit of every identity the host holds, for a suspected leak
 * of the host's PLC rotation key:
 *
 *   npm run pds:identities -- audit --pds https://pds.example.com
 *
 * The host reads each identity's log again, a page per request and at most four
 * reads a second, and steps aside for any a key it doesn't trust has changed.
 * The command prints those identities and any it couldn't read, by DID and
 * handle. Each request is signed with the host's PLC rotation key, read from
 * GSV_PLC_ROTATION_KEY or the variable --key-env names; the key is never printed.
 */

const USAGE = "Use audit --pds <https-origin> [--key-env <variable>]";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { pds: { type: "string" }, "key-env": { type: "string", default: "GSV_PLC_ROTATION_KEY" } },
});
if (positionals.length !== 1 || positionals[0] !== "audit" || !values.pds) fail(USAGE);
const origin = URL.parse(values.pds);
if (origin?.protocol !== "https:" || origin.origin !== values.pds) fail("--pds must be the PDS's HTTPS origin, such as https://pds.example.com");
const rotationKey = process.env[values["key-env"]] ?? "";
if (!/^[0-9a-f]{64}$/.test(rotationKey)) fail(`${values["key-env"]} must hold the PDS's PLC rotation key, as 64 lowercase hex characters`);

const report = { checked: 0, steppedAside: [], unread: [] };
let cursor;
do {
  const token = await signOperatorToken(rotationKey, { aud: origin.origin, act: "audit" });
  const page = new URL("/operator/identities", origin);
  if (cursor) page.searchParams.set("cursor", cursor);
  const response = await fetch(page, { method: "POST", headers: { Authorization: `Bearer ${token}` } })
    .catch((error) => fail(`Could not reach ${origin.origin}: ${error.message}`));
  const body = await response.json().catch(() => fail(`${origin.origin} answered ${response.status}, not as a PDS`));
  if (!response.ok) fail(`${body.error}: ${body.message}`);
  report.checked += body.checked;
  report.steppedAside.push(...body.steppedAside);
  report.unread.push(...body.unread);
  process.stderr.write(`Read ${report.checked} identities\n`);
  cursor = body.cursor;
} while (cursor);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
