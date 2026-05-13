#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const config = {
  baseUrl: requiredEnv("PDS_BASE_URL").replace(/\/+$/, ""),
  adminToken: requiredEnv("PDS_ADMIN_TOKEN"),
  plcRotationKeyP256Hex: requiredEnv("PDS_PLC_ROTATION_KEY_P256_HEX"),
  handleSuffix: optionalEnv("PDS_FIREHOSE_OVERSIZE_HANDLE_SUFFIX", "gsv.dev"),
  password: optionalEnv("PDS_FIREHOSE_OVERSIZE_PASSWORD", "dev-firehose-oversize-password"),
  collection: optionalEnv("PDS_FIREHOSE_OVERSIZE_COLLECTION", "app.gsv.firehoseOversizeSmoke"),
  payloadBytes: Number.parseInt(optionalEnv("PDS_FIREHOSE_OVERSIZE_TEXT_BYTES", "2100000"), 10),
};

if (typeof WebSocket === "undefined") {
  throw new Error("global WebSocket is unavailable in this Node runtime");
}
if (!Number.isInteger(config.payloadBytes) || config.payloadBytes <= 2_000_000) {
  throw new Error("PDS_FIREHOSE_OVERSIZE_TEXT_BYTES must be an integer greater than 2000000");
}

const stamp = Date.now().toString(36);
const handle = `oversize-${stamp}.${config.handleSuffix}`.toLowerCase();
const rkey = `oversize-${stamp}`;
const recordPath = `${config.collection}/${rkey}`;
const createdAt = new Date().toISOString();

await expectStatus(
  "subscribeRepos requires websocket",
  "GET",
  "/xrpc/com.atproto.sync.subscribeRepos",
  null,
  426,
);

const collector = await openSubscribeRepos();
let account;
let createRecord;
let latestBefore;
try {
  account = await expectJson(
    "create oversize firehose account",
    "POST",
    "/xrpc/com.atproto.server.createAccount",
    {
      handle,
      password: config.password,
    },
    (body) => {
      if (!body.did?.startsWith("did:plc:") || body.handle !== handle || !body.accessJwt) {
        throw new Error(`unexpected createAccount response ${JSON.stringify(body)}`);
      }
    },
    { authorization: `Bearer ${config.adminToken}` },
  );

  latestBefore = await expectJson(
    "get latest commit before oversized record",
    "GET",
    `/xrpc/com.atproto.sync.getLatestCommit?did=${encodeQuery(account.did)}`,
    null,
    (body) => {
      if (!body.cid || !body.rev) {
        throw new Error(`unexpected getLatestCommit response ${JSON.stringify(body)}`);
      }
    },
  );

  createRecord = await expectJson(
    "create oversized firehose record",
    "POST",
    "/xrpc/com.atproto.repo.createRecord",
    {
      repo: account.did,
      collection: config.collection,
      rkey,
      validate: false,
      record: {
        $type: config.collection,
        text: "x".repeat(config.payloadBytes),
        createdAt,
      },
    },
    (body) => {
      if (
        body.uri !== `at://${account.did}/${recordPath}` ||
        !body.cid ||
        !body.commit?.cid ||
        !body.commit?.rev
      ) {
        throw new Error(`unexpected createRecord response ${JSON.stringify(body)}`);
      }
    },
    { authorization: `Bearer ${account.accessJwt}` },
  );

  const decoded = await waitForOversizedSync(collector, account, createRecord);
  const sync = decoded.find(
    (frame) => frame.kind === "#sync" && frame.did === account.did && frame.rev === createRecord.commit.rev,
  );
  const syncBytes = Buffer.from(sync.blocksBase64, "base64").byteLength;

  const fullRepo = await expectBytes(
    "get full repo after oversized sync",
    "GET",
    `/xrpc/com.atproto.sync.getRepo?did=${encodeQuery(account.did)}`,
    null,
    async (response, bytes) => {
      assertCarResponse(response, bytes, config.payloadBytes);
    },
  );

  const sinceRepo = await expectBytes(
    "get repo since pre-oversize rev",
    "GET",
    `/xrpc/com.atproto.sync.getRepo?did=${encodeQuery(account.did)}&since=${encodeQuery(latestBefore.rev)}`,
    null,
    async (response, bytes) => {
      assertCarResponse(response, bytes, config.payloadBytes);
    },
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl: config.baseUrl,
        handle,
        did: account.did,
        record: createRecord.uri,
        commit: createRecord.commit.cid,
        syncBlocksBytes: syncBytes,
        fullRepoBytes: fullRepo.byteLength,
        sinceRepoBytes: sinceRepo.byteLength,
        firehoseFrames: collector.framesBase64.length,
      },
      null,
      2,
    ),
  );
} finally {
  collector.close();
}

async function waitForOversizedSync(collector, account, createRecord) {
  let lastError;
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await sleep(250);
    try {
      const decoded = await decodeFrames(collector.framesBase64);
      assertOversizedSyncFrames(decoded, account, createRecord);
      return decoded;
    } catch (error) {
      lastError = error;
    }
  }
  const decoded = await decodeFrames(collector.framesBase64);
  throw new Error(
    `oversized firehose assertions did not pass: ${lastError?.message ?? lastError}; decoded=${JSON.stringify(decoded)}`,
  );
}

function assertOversizedSyncFrames(frames, account, createRecord) {
  const repoFrames = frames.filter((frame) => frame.did === account.did || frame.repo === account.did);
  const sync = repoFrames.find(
    (frame) =>
      frame.kind === "#sync" &&
      frame.did === account.did &&
      frame.rev === createRecord.commit.rev &&
      frame.blocksBase64,
  );
  if (!sync) {
    throw new Error("missing #sync frame for oversized commit");
  }
  const syncBytes = Buffer.from(sync.blocksBase64, "base64").byteLength;
  if (syncBytes === 0 || syncBytes > 10_000) {
    throw new Error(`unexpected #sync blocks size ${syncBytes}`);
  }

  const oversizedCommit = repoFrames.find(
    (frame) => frame.kind === "#commit" && frame.repo === account.did && frame.commit === createRecord.commit.cid,
  );
  if (oversizedCommit) {
    throw new Error("oversized commit was emitted as #commit instead of #sync");
  }
}

function assertCarResponse(response, bytes, minimumBytes) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/vnd.ipld.car") || bytes.byteLength <= minimumBytes) {
    throw new Error(`unexpected CAR response content-type=${contentType} bytes=${bytes.byteLength}`);
  }
}

async function openSubscribeRepos() {
  const url = new URL("/xrpc/com.atproto.sync.subscribeRepos", `${config.baseUrl}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const framesBase64 = [];
  await new Promise((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(() => {
      rejectOpen(new Error("subscribeRepos WebSocket did not open before timeout"));
    }, 5000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolveOpen();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        rejectOpen(new Error("subscribeRepos WebSocket failed to open"));
      },
      { once: true },
    );
  });
  socket.addEventListener("message", async (event) => {
    const bytes = await messageBytes(event.data);
    if (bytes.byteLength > 0) {
      framesBase64.push(Buffer.from(bytes).toString("base64"));
    }
  });
  return {
    framesBase64,
    close() {
      socket.close();
    },
  };
}

async function messageBytes(data) {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  return new Uint8Array();
}

async function decodeFrames(framesBase64) {
  if (framesBase64.length === 0) {
    return [];
  }
  return runFixture({
    type: "decodeSubscribeReposFrames",
    framesBase64,
  });
}

async function runFixture(request) {
  const child = spawn("cargo", ["run", "--quiet", "--bin", "migration_fixture"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(JSON.stringify(request));
  const code = await new Promise((resolveCode, reject) => {
    child.on("error", reject);
    child.on("close", resolveCode);
  });
  const out = Buffer.concat(stdout).toString("utf8");
  const err = Buffer.concat(stderr).toString("utf8");
  if (code !== 0) {
    throw new Error(`migration_fixture failed with status=${code}\n${err}\n${out}`);
  }
  try {
    return JSON.parse(out);
  } catch (error) {
    throw new Error(`migration_fixture returned non-JSON output:\n${out}\n${err}`, {
      cause: error,
    });
  }
}

async function expectJson(label, method, path, body, validate = undefined, extraHeaders = {}) {
  const response = await request(method, path, body, extraHeaders);
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} returned non-JSON status=${response.status}: ${text}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new Error(`${label} failed status=${response.status}: ${JSON.stringify(parsed)}`);
  }
  validate?.(parsed, response);
  return parsed;
}

async function expectStatus(label, method, path, body, status, extraHeaders = {}) {
  const response = await request(method, path, body, extraHeaders);
  const text = await response.text();
  if (response.status !== status) {
    throw new Error(`${label} expected status=${status}, got ${response.status}: ${text}`);
  }
}

async function expectBytes(label, method, path, body, validate = undefined, extraHeaders = {}) {
  const response = await request(method, path, body, extraHeaders);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`${label} failed status=${response.status}: ${new TextDecoder().decode(bytes)}`);
  }
  await validate?.(response, bytes);
  return bytes;
}

async function request(method, path, body = null, extraHeaders = {}) {
  const headers = {
    ...extraHeaders,
  };
  let requestBody = body;
  if (typeof body === "string") {
    requestBody = body;
  } else if (body && !(body instanceof Uint8Array)) {
    headers["content-type"] = headers["content-type"] ?? "application/json";
    requestBody = JSON.stringify(body);
  }
  return fetch(`${config.baseUrl}${path}`, {
    method,
    headers,
    body: requestBody,
  });
}

function encodeQuery(value) {
  return encodeURIComponent(value);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalEnv(name, fallback = undefined) {
  const value = process.env[name];
  return value && value.trim() ? value : fallback;
}
