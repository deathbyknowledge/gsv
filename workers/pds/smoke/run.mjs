// End-to-end check of a clean local host with goat, the reference ATProto CLI.
// One wrangler session runs the host as it deploys; a second runs what
// surrounds it: a PLC directory, Accounts, and the Kernel's publisher binding.
// goat then reads the repository as a client does and follows the firehose as
// a relay does, verifying every commit. Nothing leaves this machine.
//
//   GOAT=/path/to/goat npm run smoke --workspace @humansandmachines/gsv-pds
//
// goat 0.2.5 and later refuse loopback addresses, so the check needs goat 0.2.4:
//   gh release download v0.2.4 -R bluesky-social/goat -p goat_Linux_x86_64.tar.gz
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin", "wrangler.js");
const goat = process.env.GOAT ?? "goat";
const COLLECTION = "com.example.note";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const { stdout: version } = await run(goat, ["--version"]);
assert.match(version, /goat version 0\.2\.4\b/, `The smoke check needs goat 0.2.4, which allows loopback addresses; found ${version.trim()}`);

const work = await mkdtemp(join(tmpdir(), "gsv-pds-smoke-"));
const [hostPort, smokePort, hostInspector, smokeInspector] = await freePorts(4);
const host = `http://127.0.0.1:${hostPort}`;
const smoke = `http://127.0.0.1:${smokePort}`;
const goatEnv = { ...process.env, ATP_PLC_HOST: smoke };
const sessions = [];
const followers = [];
let passed = false;

try {
  // A fresh rotation key for this run; the host's other settings point at the smoke session.
  const envFile = join(work, "host.env");
  await writeFile(envFile, `PLC_ROTATION_KEY=${randomBytes(32).toString("hex")}\nPDS_ORIGIN=${host}\nPLC_URL=${smoke}\n`, { mode: 0o600 });
  sessions.push(
    await startSession("smoke", ["-c", "smoke/wrangler.jsonc", "--port", smokePort, "--inspector-port", smokeInspector]),
    await startSession("host", ["-c", "smoke/pds.jsonc", "--port", hostPort, "--inspector-port", hostInspector, "--env-file", envFile]),
  );
  await waitFor("the host and its Accounts", async () => (await fetch(`${smoke}/_smoke/ready`)).ok);

  const live = follow("live", []);
  const [hostSession] = sessions.filter((session) => session.name === "host");
  await waitFor("the live firehose subscription", async () => /subscribeRepos 101/.test(hostSession.log()));
  const response = await fetch(`${smoke}/_smoke/publish`, { method: "POST" });
  assert.equal(response.status, 200, await response.clone().text());
  const published = await response.json();
  const { did, handle, blob, video, revs } = published;
  console.log(`published ${did} (${handle}) in ${revs.length} commits`);

  // #account, #identity and #sync announce the account, then one #commit per write call.
  const expected = ["account", "identity", "sync", "commit", "commit", "commit"];
  await waitFor("the live firehose events", async () => events(live).length >= expected.length);
  const replay = follow("replay", ["--cursor", "0"]);
  await waitFor("the replayed firehose events", async () => events(replay).length >= expected.length);
  for (const stream of [live, replay]) {
    assert.deepEqual(events(stream).map((event) => event.type), expected, `${stream.name} events`);
    assert.equal(verifiedCommits(stream), revs.length, `${stream.name} commits whose MST goat verified`);
    assert.deepEqual(problems(stream), [], `${stream.name} warnings`);
  }
  console.log("firehose: live and replayed events verified (signatures, MST inversion, prevData chain)");

  const document = JSON.parse(await goatOut(["resolve", did]));
  assert.deepEqual(document.alsoKnownAs, [`at://${handle}`]);
  // The PDS hosting the repository, then the Ship other Ships call at its own address.
  assert.deepEqual(document.service.map(({ id, serviceEndpoint }) => [id, serviceEndpoint]), [["#atproto_pds", host], ["#ship", `https://${handle}`]]);

  const car = join(work, "repo.car");
  await goatOut(["repo", "export", did, "-o", car]);
  const inspected = await goatOut(["repo", "inspect", car]);
  assert.match(inspected, new RegExp(`DID: ${did}`));
  assert.match(inspected, new RegExp(`Revision: ${revs.at(-1)}`));
  assert.deepEqual(lines(await goatOut(["repo", "ls", car])).map((line) => line.split("\t")[0]), [`${COLLECTION}/first`]);

  const record = JSON.parse(await goatOut(["get", `at://${did}/${COLLECTION}/first`]));
  assert.equal(record.text, "first, edited");
  assert.equal(record.attachment.ref.$link, blob);
  await assert.rejects(goatOut(["get", `at://${did}/${COLLECTION}/second`]), /RecordNotFound/);
  assert.deepEqual(lines(await goatOut(["ls", did])).map((line) => line.split("\t").slice(0, 2).join("/")), [`${COLLECTION}/first`]);
  assert.deepEqual(lines(await goatOut(["blob", "ls", did])).sort(), [blob, video].sort());
  const blobs = join(work, "blobs");
  await mkdir(blobs);
  await goatOut(["blob", "export", did], { cwd: blobs });
  const [exported] = await readdir(blobs);
  assert.equal(await readFile(join(blobs, exported, blob), "utf8"), "smoke attachment");
  // The 48 MiB upload streamed across the binding; the bytes served back hash to its CID.
  const large = await readFile(join(blobs, exported, video));
  assert.equal(large.byteLength, 48 * 1024 * 1024);
  assert.equal(rawCid(large), video);
  assert.deepEqual(lines(await goatOut(["pds", "--pds-host", host, "account", "ls"])), [`${did}\tactive\t${revs.at(-1)}`]);
  console.log("goat: identity, repository export, records, blobs and account listing match what was published");
  passed = true;
} finally {
  for (const owned of [...followers, ...sessions]) stop(owned);
  if (passed) {
    await rm(work, { recursive: true, force: true });
    console.log("PDS smoke check passed");
  } else {
    await Promise.all([...sessions, ...followers].map((owned) => writeFile(join(work, `${owned.name}.log`), owned.log())));
    console.error(`PDS smoke check failed; logs are in ${work}`);
    process.exitCode = 1;
  }
}

/** Starts a wrangler dev session in its own process group and waits until it serves requests. */
async function startSession(name, args) {
  const child = spawn(process.execPath, [wrangler, "dev", ...args, "--ip", "127.0.0.1", "--local",
    "--persist-to", join(work, `${name}-state`), "--show-interactive-dev-session=false"], {
    cwd: root,
    detached: true,
    env: { ...process.env, CLOUDFLARE_INCLUDE_PROCESS_ENV: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const session = { name, child, log: () => output };
  await waitFor(`the ${name} session`, async () => {
    if (child.exitCode !== null) throw new Error(`The ${name} session exited:\n${output}`);
    return output.includes("Ready on");
  });
  return session;
}

/** Follows the host firehose with goat's relay-style verification, keeping its events and logs. */
function follow(name, args) {
  const child = spawn(goat, ["--log-level", "debug", "firehose", "--relay-host", host.replace("http", "ws"),
    "--verify-basic", "--verify-sig", "--verify-mst", ...args], { env: goatEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  const stream = { name: `${name}-firehose`, child, out: () => out, err: () => err, log: () => `${err}${out}` };
  followers.push(stream);
  return stream;
}

function events(stream) {
  return lines(stream.out()).map((line) => JSON.parse(line));
}

function verifiedCommits(stream) {
  return logs(stream).filter((entry) => entry.msg === "prevData matched").length;
}

function problems(stream) {
  return logs(stream).filter((entry) => entry.level === "WARN" || entry.level === "ERROR");
}

function logs(stream) {
  return lines(stream.err()).map((line) => JSON.parse(line));
}

/** Runs a goat command against the local PLC directory and returns what it prints. */
async function goatOut(args, options = {}) {
  const { stdout } = await run(goat, args, { env: goatEnv, ...options });
  return stdout;
}

/** The CID ATProto gives a blob: CIDv1, raw codec, sha2-256, in base32. */
function rawCid(bytes) {
  const cid = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), createHash("sha256").update(bytes).digest()]);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "b";
  let value = 0;
  let bits = 0;
  for (const byte of cid) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return bits > 0 ? out + alphabet[(value << (5 - bits)) & 31] : out;
}

function lines(text) {
  return text.split("\n").filter((line) => line.trim() !== "");
}

async function waitFor(what, check, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await check()) return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(250);
  }
}

function stop({ child }) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

/** Ports the operating system reports free; each is released before a session binds it. */
async function freePorts(count) {
  const ports = [];
  while (ports.length < count) {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    if (!ports.includes(String(port))) ports.push(String(port));
  }
  return ports;
}
