import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { signOperatorToken } from "../src/gsv/operator-token.ts";

/**
 * The operator's audit of every identity the host holds, for a suspected leak
 * of the host's PLC rotation key:
 *
 *   npm run pds:identities -- audit --pds https://pds.example.com
 *
 * The host reads each identity's log again, a page per request and one read a
 * second unless --reads-per-second asks for up to ten, and steps aside for any
 * a key it doesn't trust has changed. When the directory answers 429, the host
 * ends the page there; the command waits as long as the directory's Retry-After
 * asks, or backs off when it names no time, and resumes at the identity it
 * refused. While it runs, the command prints only counts. It then prints the
 * identities the host steps aside for, the undone leaks (operations the host's
 * key signed that the host never submitted, which an undo later nullified) and
 * any identity it couldn't read, by DID and handle, and a summary line of
 * counts. Any leak of the key, undone or not, ends that line with "the host key
 * has leaked; rotate it". Each request is signed with the host's PLC rotation
 * key, read from GSV_PLC_ROTATION_KEY or the variable --key-env names; the key
 * is never printed.
 */

const USAGE = "Use audit --pds <https-origin> [--reads-per-second <1-10>] [--key-env <variable>]";
/** The first wait when the directory asks for one without naming its length; each later one doubles, up to five minutes. */
const FIRST_BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 5 * 60_000;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    pds: { type: "string" },
    "reads-per-second": { type: "string", default: "1" },
    "key-env": { type: "string", default: "GSV_PLC_ROTATION_KEY" },
  },
});
if (positionals.length !== 1 || positionals[0] !== "audit" || !values.pds) fail(USAGE);
const origin = URL.parse(values.pds);
if (origin?.protocol !== "https:" || origin.origin !== values.pds) fail("--pds must be the PDS's HTTPS origin, such as https://pds.example.com");
if (!/^([1-9]|10)$/.test(values["reads-per-second"])) fail("--reads-per-second must be a whole number from 1 to 10");
const rotationKey = process.env[values["key-env"]] ?? "";
if (!/^[0-9a-f]{64}$/.test(rotationKey)) fail(`${values["key-env"]} must hold the PDS's PLC rotation key, as 64 lowercase hex characters`);

const report = { checked: 0, steppedAside: [], undoneLeaks: [], unread: [] };
let cursor;
let backoffMs = FIRST_BACKOFF_MS;
for (;;) {
  const token = await signOperatorToken(rotationKey, { aud: origin.origin, act: "audit" });
  const page = new URL("/operator/identities", origin);
  page.searchParams.set("readsPerSecond", values["reads-per-second"]);
  if (cursor) page.searchParams.set("cursor", cursor);
  const response = await fetch(page, { method: "POST", headers: { Authorization: `Bearer ${token}` } })
    .catch((error) => fail(`Could not reach ${origin.origin}: ${error.message}`));
  const body = await response.json().catch(() => fail(`${origin.origin} answered ${response.status}, not as a PDS`));
  if (!response.ok) fail(`${body.error}: ${body.message}`);
  report.checked += body.checked;
  report.steppedAside.push(...body.steppedAside);
  report.undoneLeaks.push(...body.undoneLeaks);
  report.unread.push(...body.unread);
  cursor = body.cursor;
  if (body.retryAfter === undefined) {
    backoffMs = FIRST_BACKOFF_MS;
    if (!cursor) break;
    progress();
    continue;
  }
  const waitMs = body.retryAfter === null ? backoffMs : body.retryAfter * 1000;
  if (body.retryAfter === null) backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  progress(`the directory asked for a pause, resuming in ${Math.ceil(waitMs / 1000)} s`);
  await sleep(waitMs);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
const leaked = report.undoneLeaks.length > 0 || report.steppedAside.some((event) => event.outcome === "leaked-key");
progress(leaked ? "the host key has leaked; rotate it" : undefined);

/** Prints the audit's counts so far, and a note. */
function progress(note) {
  const counts = `Checked ${report.checked}, stepped aside ${report.steppedAside.length}, undone leaks ${report.undoneLeaks.length}, unread ${report.unread.length}`;
  process.stderr.write(`${note ? `${counts}; ${note}` : counts}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
