#!/usr/bin/env node

import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_COUNT = 100;
const DEFAULT_TTL_HOURS = 12;
const DEFAULT_CONCURRENCY = 16;
const MAX_COUNT = 1_000;
const MAX_TTL_HOURS = 168;
const MAX_CONCURRENCY = 64;
const CSV_HEADER = "device_id,token_id,token";
const JOURNAL_VERSION = 1;

function fail(message) {
  throw new Error(message);
}

function parseInteger(name, value, minimum, maximum) {
  if (!/^[0-9]+$/.test(String(value))) {
    fail(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function safeCsvField(name, value) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n,]/.test(value)) {
    fail(`gateway returned an invalid ${name}`);
  }
  return value;
}

export function deviceIdForIndex(index) {
  const parsed = parseInteger("device index", index, 1, MAX_COUNT);
  return `edge-${String(parsed).padStart(3, "0")}`;
}

function canonicalDeviceIds(count) {
  return Array.from({ length: count }, (_, index) => deviceIdForIndex(index + 1));
}

function journalPathFor(tokenFile) {
  return `${tokenFile}.operation.json`;
}

function lockPathFor(tokenFile) {
  return `${tokenFile}.lock`;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function assertRegularFile(path) {
  const info = await stat(path);
  if (!info.isFile()) fail(`${path} is not a regular file`);
  await chmod(path, 0o600);
}

async function writeAtomic(path, contents, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  let handle;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, mode);
    await rename(temporary, path);
    await chmod(path, mode);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function parseCsv(contents, expectedCount) {
  const lines = contents.replace(/\r/g, "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.shift() !== CSV_HEADER) fail("invalid token CSV header");
  if (lines.length !== expectedCount) {
    fail(`token CSV has ${lines.length} rows; expected ${expectedCount}`);
  }

  const expectedIds = canonicalDeviceIds(expectedCount);
  const seenTokenIds = new Set();
  return lines.map((line, index) => {
    const fields = line.split(",");
    if (fields.length !== 3) fail(`invalid token CSV row ${index + 2}`);
    const [deviceId, tokenId, token] = fields;
    if (deviceId !== expectedIds[index]) {
      fail(`token CSV row ${index + 2} names ${deviceId}; expected ${expectedIds[index]}`);
    }
    safeCsvField("token id", tokenId);
    safeCsvField("raw token", token);
    if (seenTokenIds.has(tokenId)) fail(`duplicate token id in token CSV at row ${index + 2}`);
    seenTokenIds.add(tokenId);
    return { deviceId, tokenId, token };
  });
}

async function readTokenCsv(tokenFile, expectedCount) {
  await assertRegularFile(tokenFile);
  return parseCsv(await readFile(tokenFile, "utf8"), expectedCount);
}

function serializeCsv(rows) {
  return `${CSV_HEADER}\n${rows.map(({ deviceId, tokenId, token }) => (
    `${deviceId},${tokenId},${token}`
  )).join("\n")}\n`;
}

function validateTokenIds(value, name) {
  if (!Array.isArray(value)) fail(`invalid ${name} in token operation journal`);
  const seen = new Set();
  return value.map((tokenId) => {
    safeCsvField("token id", tokenId);
    if (seen.has(tokenId)) fail(`duplicate ${name} in token operation journal`);
    seen.add(tokenId);
    return tokenId;
  });
}

async function readJournal(tokenFile) {
  const path = journalPathFor(tokenFile);
  if (!await pathExists(path)) return null;
  await assertRegularFile(path);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail(`invalid token operation journal: ${path}`);
  }
  if (parsed?.version !== JOURNAL_VERSION) fail(`unsupported token operation journal: ${path}`);
  return {
    newTokenIds: validateTokenIds(parsed.newTokenIds, "newTokenIds"),
    oldTokenIds: validateTokenIds(parsed.oldTokenIds, "oldTokenIds"),
  };
}

async function writeJournal(tokenFile, journal) {
  await writeAtomic(journalPathFor(tokenFile), `${JSON.stringify({
    version: JOURNAL_VERSION,
    newTokenIds: journal.newTokenIds,
    oldTokenIds: journal.oldTokenIds,
  })}\n`);
}

async function removeJournal(tokenFile) {
  await rm(journalPathFor(tokenFile), { force: true });
}

async function acquireLock(tokenFile) {
  const lockPath = lockPathFor(tokenFile);
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, { encoding: "utf8" });
      await handle.close();
      return async () => rm(lockPath, { force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let ownerPid;
      try {
        ownerPid = Number((await readFile(lockPath, "utf8")).trim());
        if (Number.isSafeInteger(ownerPid) && ownerPid > 0) process.kill(ownerPid, 0);
        fail(`another token lifecycle command is running (pid ${ownerPid || "unknown"})`);
      } catch (ownerError) {
        if (ownerError?.code !== "ESRCH") throw ownerError;
        await rm(lockPath, { force: true });
      }
    }
  }
  fail("could not acquire token lifecycle lock");
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function settleBatches(items, options, worker, onBatch) {
  const { concurrency, paceMs, shouldAbort = () => false } = options;
  const outcomes = [];
  for (let offset = 0; offset < items.length; offset += concurrency) {
    if (shouldAbort()) fail("token operation interrupted");
    const batch = items.slice(offset, offset + concurrency);
    const settled = await Promise.allSettled(batch.map(worker));
    outcomes.push(...settled);
    await onBatch?.(settled, offset);
    if (paceMs > 0 && offset + concurrency < items.length) await delay(paceMs);
  }
  return outcomes;
}

async function revokeTokenIds(client, tokenIds, options) {
  if (tokenIds.length === 0) return [];
  let completed = 0;
  const outcomes = await settleBatches(
    tokenIds,
    options,
    async (tokenId) => {
      await client.call("sys.token.revoke", { tokenId, reason: options.reason });
      return tokenId;
    },
    (batch) => {
      completed += batch.length;
      options.onProgress?.("revoke", completed, tokenIds.length);
    },
  );
  return outcomes.flatMap((outcome, index) => (
    outcome.status === "rejected" ? [tokenIds[index]] : []
  ));
}

async function recoverInterruptedOperation(client, options) {
  const journal = await readJournal(options.tokenFile);
  if (!journal) return;

  let installed = false;
  if (await pathExists(options.tokenFile)) {
    try {
      const currentIds = (await readTokenCsv(options.tokenFile, options.count))
        .map(({ tokenId }) => tokenId);
      installed = currentIds.length === journal.newTokenIds.length
        && currentIds.every((tokenId, index) => tokenId === journal.newTokenIds[index]);
    } catch {
      installed = false;
    }
  }

  const pending = installed ? journal.oldTokenIds : journal.newTokenIds;
  const failures = await revokeTokenIds(client, pending, {
    ...options,
    reason: "demo fleet interrupted token operation cleanup",
  });
  if (failures.length > 0) {
    await writeJournal(options.tokenFile, installed
      ? { newTokenIds: journal.newTokenIds, oldTokenIds: failures }
      : { newTokenIds: failures, oldTokenIds: [] });
    fail(`could not clean up ${failures.length} token(s) from an interrupted operation`);
  }
  await removeJournal(options.tokenFile);
}

function validateCommonOptions(options) {
  const count = parseInteger("device count", options.count, 1, MAX_COUNT);
  const concurrency = parseInteger("token concurrency", options.concurrency, 1, MAX_CONCURRENCY);
  const paceMs = parseInteger("token batch pacing", options.paceMs, 0, 5_000);
  const tokenFile = resolve(options.tokenFile);
  return { ...options, count, concurrency, paceMs, tokenFile };
}

function validateIssuedToken(result, expected) {
  const issued = result?.token;
  const tokenId = safeCsvField("token id", issued?.tokenId);
  try {
    const token = safeCsvField("raw token", issued?.token);
    if (issued.kind !== "node"
      || issued.allowedRole !== "driver"
      || issued.allowedDeviceId !== expected.deviceId
      || issued.expiresAt !== expected.expiresAt) {
      fail(`gateway returned mismatched token metadata for ${expected.deviceId}`);
    }
    return { deviceId: expected.deviceId, tokenId, token };
  } catch (error) {
    // A valid token id is enough to clean up an issued credential even when the
    // remaining response cannot safely become a CSV row.
    error.issuedTokenId = tokenId;
    throw error;
  }
}

export async function createDeviceTokens(client, rawOptions) {
  const options = validateCommonOptions(rawOptions);
  const ttlHours = parseInteger("token TTL hours", options.ttlHours, 1, MAX_TTL_HOURS);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(options.fleetId)) {
    fail("fleet id must be 1-63 letters, digits, dots, underscores, or hyphens");
  }
  const releaseLock = await acquireLock(options.tokenFile);
  try {
    await recoverInterruptedOperation(client, options);
    const exists = await pathExists(options.tokenFile);
    if (exists && !options.force) {
      fail(`${options.tokenFile} already exists; pass --force to rotate it`);
    }
    const oldRows = exists ? await readTokenCsv(options.tokenFile, options.count) : [];
    const oldTokenIds = oldRows.map(({ tokenId }) => tokenId);
    const expiresAt = options.now() + ttlHours * 60 * 60 * 1_000;
    const devices = canonicalDeviceIds(options.count);
    const createdRows = [];
    const issuedTokenIds = [];
    const seenIssuedTokenIds = new Set();
    let installed = false;

    try {
      for (let offset = 0; offset < devices.length; offset += options.concurrency) {
        if (options.shouldAbort?.()) fail("token operation interrupted");
        const batch = devices.slice(offset, offset + options.concurrency);
        const settled = await Promise.allSettled(batch.map(async (deviceId) => {
          const result = await client.call("sys.token.create", {
            kind: "node",
            allowedRole: "driver",
            allowedDeviceId: deviceId,
            label: `demo fleet ${options.fleetId} ${deviceId}`,
            expiresAt,
          });
          return validateIssuedToken(result, { deviceId, expiresAt });
        }));
        for (const outcome of settled) {
          const tokenId = outcome.status === "fulfilled"
            ? outcome.value.tokenId
            : outcome.reason?.issuedTokenId;
          if (typeof tokenId === "string" && !seenIssuedTokenIds.has(tokenId)) {
            seenIssuedTokenIds.add(tokenId);
            issuedTokenIds.push(tokenId);
          }
          if (outcome.status === "fulfilled") createdRows.push(outcome.value);
        }
        await writeJournal(options.tokenFile, {
          newTokenIds: issuedTokenIds,
          oldTokenIds,
        });
        options.onProgress?.("create", createdRows.length, devices.length);
        if (settled.some((outcome) => outcome.status === "rejected")) {
          fail(`failed to create ${settled.filter((outcome) => outcome.status === "rejected").length} token(s)`);
        }
        if (options.paceMs > 0 && offset + options.concurrency < devices.length) {
          await delay(options.paceMs);
        }
      }

      await writeAtomic(options.tokenFile, serializeCsv(createdRows));
      installed = true;
      const oldFailures = await revokeTokenIds(client, oldTokenIds, {
        ...options,
        reason: "rotated demo fleet token set",
      });
      if (oldFailures.length > 0) {
        await writeJournal(options.tokenFile, {
          newTokenIds: createdRows.map(({ tokenId }) => tokenId),
          oldTokenIds: oldFailures,
        });
        fail(`installed replacement CSV but could not revoke ${oldFailures.length} previous token(s)`);
      }
      await removeJournal(options.tokenFile);
      return { created: createdRows.length, revokedPrevious: oldTokenIds.length, expiresAt };
    } catch (error) {
      if (!installed && issuedTokenIds.length > 0) {
        const failures = await revokeTokenIds(client, issuedTokenIds, {
          ...options,
          reason: "demo fleet token creation rollback",
          shouldAbort: () => false,
        });
        if (failures.length === 0) {
          await removeJournal(options.tokenFile);
        } else {
          await writeJournal(options.tokenFile, { newTokenIds: failures, oldTokenIds: [] });
        }
      }
      throw error;
    }
  } finally {
    await releaseLock();
  }
}

export async function revokeDeviceTokens(client, rawOptions) {
  const options = validateCommonOptions(rawOptions);
  const releaseLock = await acquireLock(options.tokenFile);
  try {
    await recoverInterruptedOperation(client, options);
    if (!await pathExists(options.tokenFile)) {
      return { revoked: 0, removedFile: false };
    }
    const rows = await readTokenCsv(options.tokenFile, options.count);
    const failures = await revokeTokenIds(client, rows.map(({ tokenId }) => tokenId), options);
    if (failures.length > 0) {
      fail(`failed to revoke ${failures.length} token(s); token CSV was preserved for retry`);
    }
    if (!options.keepFile) await rm(options.tokenFile);
    return { revoked: rows.length, removedFile: !options.keepFile };
  } finally {
    await releaseLock();
  }
}

function usage() {
  return `Usage:
  bulk-device-tokens.mjs create [--force] [--ttl-hours N] [common options]
  bulk-device-tokens.mjs revoke [--keep-file] [--reason TEXT] [common options]

Common options:
  --count N          exact canonical fleet size, 1-1000
  --token-file PATH  output/input CSV path
  --fleet-id ID      token label namespace (create only)
  --concurrency N    requests in flight on one connection (default: 16)
  --pace-ms N        delay between request batches (default: 0)

Connection credentials are read only from GSV_URL, GSV_USER, and
GSV_USER_TOKEN. GSV_USER_TOKEN is required and is never printed.
`;
}

function takeValue(args, index, flag) {
  if (index + 1 >= args.length) fail(`${flag} requires a value`);
  return args[index + 1];
}

function parseCli(argv) {
  const args = [...argv];
  const command = args.shift();
  if (command === "--help" || command === "-h" || !command) return { help: true };
  if (command !== "create" && command !== "revoke") fail(`unknown command: ${command}`);
  const options = {
    command,
    count: process.env.DEMO_FLEET_DEVICE_COUNT ?? DEFAULT_COUNT,
    tokenFile: process.env.DEMO_FLEET_TOKENS_FILE
      ?? fileURLToPath(new URL("./.generated/tokens.csv", import.meta.url)),
    fleetId: process.env.DEMO_FLEET_ID ?? "default",
    ttlHours: process.env.DEMO_FLEET_TOKEN_TTL_HOURS ?? DEFAULT_TTL_HOURS,
    concurrency: process.env.DEMO_FLEET_TOKEN_CONCURRENCY ?? DEFAULT_CONCURRENCY,
    paceMs: process.env.DEMO_FLEET_TOKEN_PACE_MS ?? 0,
    force: false,
    keepFile: false,
    reason: "demo fleet cleanup",
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag === "--force" && command === "create") options.force = true;
    else if (flag === "--keep-file" && command === "revoke") options.keepFile = true;
    else if (flag === "--count") options.count = takeValue(args, index++, flag);
    else if (flag === "--token-file") options.tokenFile = takeValue(args, index++, flag);
    else if (flag === "--fleet-id" && command === "create") options.fleetId = takeValue(args, index++, flag);
    else if (flag === "--ttl-hours" && command === "create") options.ttlHours = takeValue(args, index++, flag);
    else if (flag === "--concurrency") options.concurrency = takeValue(args, index++, flag);
    else if (flag === "--pace-ms") options.paceMs = takeValue(args, index++, flag);
    else if (flag === "--reason" && command === "revoke") options.reason = takeValue(args, index++, flag);
    else fail(`unknown argument for ${command}: ${flag}`);
  }
  return options;
}

function validateConnectionEnvironment() {
  if (process.env.GSV_PASSWORD) fail("GSV_PASSWORD is not accepted; set GSV_USER_TOKEN");
  const url = process.env.GSV_URL?.trim();
  const username = process.env.GSV_USER?.trim();
  const token = process.env.GSV_USER_TOKEN?.trim();
  if (!url || (!url.startsWith("ws://") && !url.startsWith("wss://"))) {
    fail("GSV_URL must be a ws:// or wss:// URL");
  }
  if (!username || /[\r\n]/.test(username)) fail("GSV_USER is required");
  if (!token || /[\r\n]/.test(token)) fail("GSV_USER_TOKEN is required");
  return { url, username, token };
}

function safeErrorMessage(error) {
  const name = typeof error?.name === "string" ? error.name : "Error";
  const code = Number.isFinite(error?.code) ? ` (code ${error.code})` : "";
  if (error instanceof Error && error.constructor === Error) return error.message;
  return `${name}${code}`;
}

async function connectClient() {
  const { url, username, token } = validateConnectionEnvironment();
  const [{ GSVClient }, websocketModule] = await Promise.all([
    import(new URL("../../packages/gsv/dist/client.js", import.meta.url)),
    import("ws"),
  ]);
  const WebSocket = websocketModule.WebSocket ?? websocketModule.default;
  const client = new GSVClient({
    WebSocket,
    url,
    username,
    token,
    client: {
      id: "gsv-demo-bulk-token-lifecycle",
      version: "1",
      platform: process.platform,
      role: "user",
    },
  });
  await client.connect();
  return client;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  let interrupted = false;
  const handleSignal = () => { interrupted = true; };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  const onProgress = (operation, completed, total) => {
    process.stderr.write(`\r${operation === "create" ? "Creating" : "Revoking"} device tokens: ${completed}/${total}`);
  };
  const client = await connectClient();
  try {
    const common = {
      ...options,
      now: () => Date.now(),
      shouldAbort: () => interrupted,
      onProgress,
    };
    const result = options.command === "create"
      ? await createDeviceTokens(client, common)
      : await revokeDeviceTokens(client, common);
    process.stderr.write("\n");
    if (options.command === "create") {
      process.stdout.write(`Wrote ${result.created} device tokens to ${resolve(options.tokenFile)}\n`);
    } else {
      process.stdout.write(`Revoked ${result.revoked} demo fleet tokens\n`);
    }
  } finally {
    client.disconnect();
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`\nerror: ${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
