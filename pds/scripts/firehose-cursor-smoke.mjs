#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const config = {
  baseUrl: requiredEnv("PDS_BASE_URL").replace(/\/+$/, ""),
  adminToken: requiredEnv("PDS_ADMIN_TOKEN"),
  replayLimit: Number.parseInt(optionalEnv("PDS_FIREHOSE_REPLAY_LIMIT", "64"), 10),
  handleSuffix: optionalEnv("PDS_FIREHOSE_CURSOR_HANDLE_SUFFIX", "gsv.dev"),
  password: optionalEnv("PDS_FIREHOSE_CURSOR_PASSWORD", "dev-firehose-cursor-password"),
  collection: optionalEnv("PDS_FIREHOSE_CURSOR_COLLECTION", "app.gsv.firehoseCursorSmoke"),
};

if (typeof WebSocket === "undefined") {
  throw new Error("global WebSocket is unavailable in this Node runtime");
}
if (!Number.isInteger(config.replayLimit) || config.replayLimit <= 0 || config.replayLimit > 500) {
  throw new Error("PDS_FIREHOSE_REPLAY_LIMIT must be an integer from 1 through 500 for this smoke");
}

const base = new URL(config.baseUrl);
const stamp = Date.now().toString(36);
const handle = `cursor-${stamp}.${config.handleSuffix}`.toLowerCase();
const rkey = `cursor-${stamp}`;
const recordPath = `${config.collection}/${rkey}`;
const createdAt = new Date().toISOString();
const initialSeq = await currentSeq();

const account = await expectJson(
  "create cursor account",
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

const createRecord = await expectJson(
  "create cursor record",
  "POST",
  "/xrpc/com.atproto.repo.createRecord",
  {
    repo: account.did,
    collection: config.collection,
    rkey,
    validate: false,
    record: {
      $type: config.collection,
      text: "created for firehose cursor smoke",
      createdAt,
    },
  },
  (body) => {
    if (body.uri !== `at://${account.did}/${recordPath}` || !body.cid || !body.commit?.cid) {
      throw new Error(`unexpected createRecord response ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${account.accessJwt}` },
);

const replayFrames = await collectReplayFrames(initialSeq);
assertReplayContainsTarget(replayFrames, account, createRecord, recordPath);

const futureSeq = (await currentSeq()) + 1000;
const futureFrames = await collectReplayFrames(futureSeq, { waitForClose: true, timeoutMs: 3000 });
if (!futureFrames.some((frame) => frame.kind === "#error" && frame.error === "FutureCursor")) {
  throw new Error(`expected FutureCursor error frame, got ${JSON.stringify(futureFrames)}`);
}

for (let index = 0; index < config.replayLimit + 3; index += 1) {
  await expectJson(
    `fill replay window ${index + 1}`,
    "POST",
    "/xrpc/com.atproto.repo.createRecord",
    {
      repo: account.did,
      collection: config.collection,
      rkey: `${rkey}-fill-${index}`,
      validate: false,
      record: {
        $type: config.collection,
        text: `replay window fill ${index}`,
        createdAt: new Date().toISOString(),
      },
    },
    undefined,
    { authorization: `Bearer ${account.accessJwt}` },
  );
}

const outdatedFrames = await collectReplayFrames(initialSeq);
const info = outdatedFrames.find((frame) => frame.kind === "#info" && frame.name === "OutdatedCursor");
if (!info) {
  throw new Error(`expected OutdatedCursor info frame, got ${JSON.stringify(outdatedFrames.slice(0, 5))}`);
}
if (outdatedFrames.some((frame) => frame.repo === account.did && frame.commit === createRecord.commit.cid)) {
  throw new Error("outdated replay unexpectedly included the commit that fell outside the replay window");
}
const replayedEvents = outdatedFrames.filter((frame) => Number.isInteger(frame.seq));
if (replayedEvents.length > config.replayLimit) {
  throw new Error(`outdated replay exceeded configured limit ${config.replayLimit}: ${replayedEvents.length}`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl: config.baseUrl,
      handle,
      did: account.did,
      initialSeq,
      replayLimit: config.replayLimit,
      futureCursor: futureSeq,
      validReplayFrames: replayFrames.length,
      outdatedReplayFrames: outdatedFrames.length,
    },
    null,
    2,
  ),
);

async function collectReplayFrames(cursor, options = {}) {
  const { timeoutMs = 1500, waitForClose = false } = options;
  const url = new URL(`/xrpc/com.atproto.sync.subscribeRepos?cursor=${encodeURIComponent(String(cursor))}`, `${config.baseUrl}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const framesBase64 = [];
  await new Promise((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(() => rejectOpen(new Error("subscribeRepos WebSocket did not open")), 5000);
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
  await new Promise((resolveWait) => {
    const timeout = setTimeout(resolveWait, timeoutMs);
    if (waitForClose) {
      socket.addEventListener(
        "close",
        () => {
          clearTimeout(timeout);
          resolveWait();
        },
        { once: true },
      );
    }
  });
  socket.close();
  return decodeFrames(framesBase64);
}

function assertReplayContainsTarget(frames, account, createRecord, path) {
  if (!frames.some((frame) => frame.kind === "#identity" && frame.did === account.did && frame.handle === handle)) {
    throw new Error(`valid replay missed identity frame: ${JSON.stringify(frames)}`);
  }
  if (!frames.some((frame) => frame.kind === "#account" && frame.did === account.did && frame.active === true)) {
    throw new Error(`valid replay missed account frame: ${JSON.stringify(frames)}`);
  }
  if (
    !frames.some(
      (frame) =>
        frame.kind === "#commit" &&
        frame.repo === account.did &&
        frame.commit === createRecord.commit.cid &&
        frame.prevData &&
        frame.ops?.some((op) => op.action === "create" && op.path === path && op.cid === createRecord.cid),
    )
  ) {
    throw new Error(`valid replay missed target commit frame: ${JSON.stringify(frames)}`);
  }
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

async function currentSeq() {
  const status = await expectJson(
    "get host status",
    "GET",
    `/xrpc/com.atproto.sync.getHostStatus?hostname=${encodeQuery(base.host)}`,
  );
  if (!Number.isInteger(status.seq)) {
    throw new Error(`unexpected host status ${JSON.stringify(status)}`);
  }
  return status.seq;
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

function encodeQuery(value) {
  return encodeURIComponent(value);
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
