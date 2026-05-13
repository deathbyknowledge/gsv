#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const config = {
  baseUrl: requiredEnv("PDS_BASE_URL").replace(/\/+$/, ""),
  adminToken: requiredEnv("PDS_ADMIN_TOKEN"),
  plcRotationKeyP256Hex: requiredEnv("PDS_PLC_ROTATION_KEY_P256_HEX"),
  handle: optionalEnv("PDS_FIREHOSE_ACCOUNT_HANDLE"),
  handleSuffix: optionalEnv("PDS_FIREHOSE_ACCOUNT_HANDLE_SUFFIX", "gsv.dev"),
  password: optionalEnv("PDS_FIREHOSE_ACCOUNT_PASSWORD", "dev-firehose-account-password"),
  collection: optionalEnv("PDS_FIREHOSE_ACCOUNT_COLLECTION", "app.gsv.firehoseSmoke"),
};

if (typeof WebSocket === "undefined") {
  throw new Error("global WebSocket is unavailable in this Node runtime");
}

const base = new URL(config.baseUrl);
const stamp = Date.now().toString(36);
const handle = (config.handle ?? `firehose-${stamp}.${config.handleSuffix}`).toLowerCase();
const rkey = `firehose-${stamp}`;
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
let repoCar;
try {
  account = await expectJson(
    "create firehose account",
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

  createRecord = await expectJson(
    "create firehose record",
    "POST",
    "/xrpc/com.atproto.repo.createRecord",
    {
      repo: account.did,
      collection: config.collection,
      rkey,
      validate: false,
      record: {
        $type: config.collection,
        text: "created for firehose smoke",
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

  repoCar = await expectBytes(
    "get firehose repo",
    "GET",
    `/xrpc/com.atproto.sync.getRepo?did=${encodeQuery(account.did)}`,
    null,
    async (response, bytes) => {
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/vnd.ipld.car") || bytes.byteLength === 0) {
        throw new Error(`unexpected getRepo response content-type=${contentType} bytes=${bytes.byteLength}`);
      }
    },
  );

  await expectStatus("import firehose repo", "POST", "/xrpc/com.atproto.repo.importRepo", repoCar, 200, {
    authorization: `Bearer ${account.accessJwt}`,
    "content-type": "application/vnd.ipld.car",
  });

  const decoded = await waitForFirehoseAssertions(collector, account, createRecord, recordPath);
  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl: config.baseUrl,
        handle,
        did: account.did,
        observedKinds: [...new Set(decoded.filter((frame) => frame.did === account.did || frame.repo === account.did).map((frame) => frame.kind))],
        commit: createRecord.commit.cid,
        record: createRecord.uri,
        firehoseFrames: collector.framesBase64.length,
      },
      null,
      2,
    ),
  );
} finally {
  collector.close();
}

async function waitForFirehoseAssertions(collector, account, createRecord, path) {
  let lastError;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await sleep(250);
    try {
      const decoded = await decodeFrames(collector.framesBase64);
      assertFirehoseFrames(decoded, account, createRecord, path);
      return decoded;
    } catch (error) {
      lastError = error;
    }
  }
  const decoded = await decodeFrames(collector.framesBase64);
  throw new Error(
    `firehose assertions did not pass: ${lastError?.message ?? lastError}; decoded=${JSON.stringify(decoded)}`,
  );
}

function assertFirehoseFrames(frames, account, createRecord, path) {
  const repoFrames = frames.filter((frame) => frame.did === account.did || frame.repo === account.did);
  const identity = repoFrames.find(
    (frame) => frame.kind === "#identity" && frame.did === account.did && frame.handle === handle,
  );
  if (!identity) {
    throw new Error("missing #identity frame for created account");
  }
  const activeAccount = repoFrames.find(
    (frame) => frame.kind === "#account" && frame.did === account.did && frame.active === true,
  );
  if (!activeAccount) {
    throw new Error("missing active #account frame for created account");
  }
  const commit = repoFrames.find(
    (frame) =>
      frame.kind === "#commit" &&
      frame.repo === account.did &&
      frame.commit === createRecord.commit.cid &&
      frame.prevData &&
      frame.blocksBase64 &&
      frame.ops?.some((op) => op.action === "create" && op.path === path && op.cid === createRecord.cid),
  );
  if (!commit) {
    throw new Error("missing #commit frame with prevData and created record op");
  }
  const sync = repoFrames.find(
    (frame) => frame.kind === "#sync" && frame.did === account.did && frame.rev && frame.blocksBase64,
  );
  if (!sync) {
    throw new Error("missing #sync frame for repo import");
  }
  const seqs = repoFrames.map((frame) => frame.seq).filter((seq) => Number.isInteger(seq));
  for (let index = 1; index < seqs.length; index += 1) {
    if (seqs[index] <= seqs[index - 1]) {
      throw new Error(`non-increasing firehose seqs for repo ${account.did}: ${seqs.join(",")}`);
    }
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
