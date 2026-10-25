import { parseArgs } from "node:util";
import { signOperatorToken } from "../src/gsv/operator-token.ts";

/**
 * The operator's audit of the identities the host holds, for a suspected leak
 * of the host's PLC rotation key:
 *
 *   npm run pds:identities -- audit --pds https://pds.example.com [--did <did>]
 *
 * Every ten minutes the host reads the PLC directory's feed of every operation
 * it logs, and reads a hosted identity's log again only when the feed lists an
 * operation for it. The audit prints what that has found: how far the host has
 * read the feed, why its last run failed, if it did, the identities it stepped
 * aside for and the undone leaks (operations the host's key signed that the
 * host never submitted, which an undo later nullified), by DID and handle. It
 * reads no identity's log itself. With --did, the host reads that one
 * identity's log again, and the audit prints what it finds now. A summary line
 * follows; when the host found a leak of its key, undone or not, it ends with
 * "the host key has leaked; rotate it". Each request is signed with the host's
 * PLC rotation key, read from GSV_PLC_ROTATION_KEY or the variable --key-env
 * names; the key is never printed.
 */

const USAGE = "Use audit --pds <https-origin> [--did <did>] [--key-env <variable>]";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    pds: { type: "string" },
    did: { type: "string" },
    "key-env": { type: "string", default: "GSV_PLC_ROTATION_KEY" },
  },
});
if (positionals.length !== 1 || positionals[0] !== "audit" || !values.pds) fail(USAGE);
const origin = URL.parse(values.pds);
if (origin?.protocol !== "https:" || origin.origin !== values.pds) fail("--pds must be the PDS's HTTPS origin, such as https://pds.example.com");
if (values.did !== undefined && !values.did.startsWith("did:")) fail("--did must be the identity's DID, which starts with did:");
const rotationKey = process.env[values["key-env"]] ?? "";
if (!/^[0-9a-f]{64}$/.test(rotationKey)) fail(`${values["key-env"]} must hold the PDS's PLC rotation key, as 64 lowercase hex characters`);

const token = await signOperatorToken(rotationKey, { aud: origin.origin, act: "audit" });
const request = new URL("/operator/identities", origin);
if (values.did) request.searchParams.set("did", values.did);
const response = await fetch(request, { method: "POST", headers: { Authorization: `Bearer ${token}` } })
  .catch((error) => fail(`Could not reach ${origin.origin}: ${error.message}`));
const body = await response.json().catch(() => fail(`${origin.origin} answered ${response.status}, not as a PDS`));
if (!response.ok) fail(`${body.error}: ${body.message}`);
if (body.outcome === "busy") {
  fail(`The PLC directory asked the host to wait${body.retryAfter === null ? "" : ` ${body.retryAfter} s`}; run the audit again then`);
}
process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
const steppedAside = values.did ? [body.steppedAside].filter(Boolean) : body.steppedAside;
const leaked = body.undoneLeaks.length > 0 || steppedAside.some((event) => event.outcome === "leaked-key");
const found = `stepped aside ${steppedAside.length}, undone leaks ${body.undoneLeaks.length}`;
const summary = values.did
  ? `${body.did} (${body.handle}): ${found}`
  : `Read the PLC directory's feed up to ${body.loggedAt ?? "nothing yet"}; ${found}`
    + `${body.notBefore ? `; waiting for the directory until ${new Date(body.notBefore).toISOString()}` : ""}`
    + `${body.error ? `; its last run failed: ${body.error}` : ""}`;
process.stderr.write(`${summary}${leaked ? "; the host key has leaked; rotate it" : ""}\n`);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
