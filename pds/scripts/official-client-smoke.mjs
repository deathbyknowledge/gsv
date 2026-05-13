#!/usr/bin/env node
import { AtpAgent } from "@atproto/api";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const config = {
  baseUrl: requiredEnv("PDS_BASE_URL").replace(/\/+$/, ""),
  adminToken: requiredEnv("PDS_ADMIN_TOKEN"),
  handleSuffix: optionalEnv("PDS_OFFICIAL_CLIENT_HANDLE_SUFFIX", "gsv.dev"),
  password: optionalEnv("PDS_OFFICIAL_CLIENT_PASSWORD", "dev-official-client-password"),
  collection: optionalEnv("PDS_OFFICIAL_CLIENT_COLLECTION", "app.gsv.officialClientSmoke"),
};

if (typeof WebSocket === "undefined") {
  throw new Error("global WebSocket is unavailable in this Node runtime");
}

const stamp = Date.now().toString(36);
const handle = `client-${stamp}.${config.handleSuffix}`.toLowerCase();
const rkey = `client-${stamp}`;
const recordPath = `${config.collection}/${rkey}`;
const createdAt = new Date().toISOString();
const blobText = `hello from official client smoke ${stamp}`;

const agent = new AtpAgent({
  service: config.baseUrl,
});

const describedServer = await agent.com.atproto.server.describeServer();
if (describedServer.data.availableUserDomains?.length === 0) {
  throw new Error(`unexpected describeServer response ${JSON.stringify(describedServer.data)}`);
}

const createdAccount = await agent.com.atproto.server.createAccount(
  {
    handle,
    password: config.password,
  },
  {
    headers: {
      authorization: `Bearer ${config.adminToken}`,
    },
  },
);
if (!createdAccount.data.did || createdAccount.data.handle !== handle) {
  throw new Error(`unexpected createAccount response ${JSON.stringify(createdAccount.data)}`);
}

const session = await agent.login({
  identifier: handle,
  password: config.password,
});
const did = session.data.did;
if (did !== createdAccount.data.did || agent.did !== did) {
  throw new Error(`unexpected login session did=${did} agent.did=${agent.did}`);
}

const getSession = await agent.com.atproto.server.getSession();
if (getSession.data.did !== did || getSession.data.handle !== handle) {
  throw new Error(`unexpected getSession response ${JSON.stringify(getSession.data)}`);
}

const repoStatus = await agent.com.atproto.sync.getRepoStatus({ did });
if (repoStatus.data.did !== did || repoStatus.data.active !== true) {
  throw new Error(`unexpected getRepoStatus response ${JSON.stringify(repoStatus.data)}`);
}

const collector = await openSubscribeRepos();
let createRecord;
let uploadedBlob;
try {
  uploadedBlob = await agent.uploadBlob(new Blob([blobText], { type: "text/plain" }), {
    encoding: "text/plain",
  });
  const blobCid = uploadedBlob.data.blob.ref?.toString();
  if (!blobCid || uploadedBlob.data.blob.mimeType !== "text/plain") {
    throw new Error(`unexpected uploadBlob response ${JSON.stringify(uploadedBlob.data)}`);
  }

  createRecord = await agent.com.atproto.repo.createRecord({
    repo: did,
    collection: config.collection,
    rkey,
    validate: false,
    record: {
      $type: config.collection,
      text: "created through @atproto/api",
      blob: uploadedBlob.data.blob,
      createdAt,
    },
  });
  if (
    createRecord.data.uri !== `at://${did}/${recordPath}` ||
    !createRecord.data.cid ||
    !createRecord.data.commit?.cid ||
    !createRecord.data.commit?.rev
  ) {
    throw new Error(`unexpected createRecord response ${JSON.stringify(createRecord.data)}`);
  }

  const fetchedBlob = await agent.com.atproto.sync.getBlob({ did, cid: blobCid });
  const fetchedBlobBytes = await responseBytes(fetchedBlob.data);
  if (new TextDecoder().decode(fetchedBlobBytes) !== blobText) {
    throw new Error("sync.getBlob returned unexpected bytes");
  }

  const record = await agent.com.atproto.repo.getRecord({
    repo: did,
    collection: config.collection,
    rkey,
  });
  if (record.data.uri !== createRecord.data.uri || record.data.cid !== createRecord.data.cid) {
    throw new Error(`unexpected getRecord response ${JSON.stringify(record.data)}`);
  }

  const listed = await agent.com.atproto.repo.listRecords({
    repo: did,
    collection: config.collection,
    limit: 10,
  });
  if (!listed.data.records.some((item) => item.uri === createRecord.data.uri && item.cid === createRecord.data.cid)) {
    throw new Error(`listRecords missed created record ${JSON.stringify(listed.data)}`);
  }

  const syncRecord = await agent.com.atproto.sync.getRecord({
    did,
    collection: config.collection,
    rkey,
  });
  const syncRecordBytes = await responseBytes(syncRecord.data);
  if (syncRecordBytes.byteLength === 0) {
    throw new Error("sync.getRecord returned an empty CAR");
  }

  const latest = await agent.com.atproto.sync.getLatestCommit({ did });
  if (latest.data.cid !== createRecord.data.commit.cid || latest.data.rev !== createRecord.data.commit.rev) {
    throw new Error(`unexpected getLatestCommit response ${JSON.stringify(latest.data)}`);
  }

  const repoCar = await agent.com.atproto.sync.getRepo({ did });
  const repoCarBytes = await responseBytes(repoCar.data);
  if (repoCarBytes.byteLength === 0) {
    throw new Error("sync.getRepo returned an empty CAR");
  }

  const describedRepo = await agent.com.atproto.repo.describeRepo({ repo: did });
  if (
    describedRepo.data.did !== did ||
    describedRepo.data.handle !== handle ||
    !describedRepo.data.collections.includes(config.collection)
  ) {
    throw new Error(`unexpected describeRepo response ${JSON.stringify(describedRepo.data)}`);
  }

  const decoded = await waitForFirehoseCommit(collector, did, createRecord.data, recordPath);

  const deleteRecord = await agent.com.atproto.repo.deleteRecord({
    repo: did,
    collection: config.collection,
    rkey,
    swapRecord: createRecord.data.cid,
  });
  if (!deleteRecord.data.commit?.cid || !deleteRecord.data.commit?.rev) {
    throw new Error(`unexpected deleteRecord response ${JSON.stringify(deleteRecord.data)}`);
  }
  await expectXrpcFailureStatus(
    () =>
      agent.com.atproto.repo.getRecord({
        repo: did,
        collection: config.collection,
        rkey,
      }),
    404,
    "getRecord after delete",
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl: config.baseUrl,
        handle,
        did,
        record: createRecord.data.uri,
        recordCid: createRecord.data.cid,
        blobCid,
        latestCommit: latest.data.cid,
        repoCarBytes: repoCarBytes.byteLength,
        firehoseFrames: collector.framesBase64.length,
        observedKinds: [
          ...new Set(decoded.filter((frame) => frame.did === did || frame.repo === did).map((frame) => frame.kind)),
        ],
      },
      null,
      2,
    ),
  );
} finally {
  collector.close();
}

async function waitForFirehoseCommit(collector, did, createRecord, path) {
  let lastError;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await sleep(250);
    try {
      const decoded = await decodeFrames(collector.framesBase64);
      assertFirehoseCommit(decoded, did, createRecord, path);
      return decoded;
    } catch (error) {
      lastError = error;
    }
  }
  const decoded = await decodeFrames(collector.framesBase64);
  throw new Error(
    `official-client firehose assertion did not pass: ${lastError?.message ?? lastError}; decoded=${JSON.stringify(decoded)}`,
  );
}

function assertFirehoseCommit(frames, did, createRecord, path) {
  const commit = frames.find(
    (frame) =>
      frame.kind === "#commit" &&
      frame.repo === did &&
      frame.commit === createRecord.commit.cid &&
      frame.rev === createRecord.commit.rev &&
      frame.prevData &&
      frame.blocksBase64 &&
      frame.ops?.some((op) => op.action === "create" && op.path === path && op.cid === createRecord.cid),
  );
  if (!commit) {
    throw new Error("missing official-client #commit frame for created record");
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

async function responseBytes(data) {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  throw new Error(`unsupported binary response type ${Object.prototype.toString.call(data)}`);
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

async function expectXrpcFailureStatus(fn, status, label) {
  try {
    await fn();
  } catch (error) {
    const actualStatus = error?.status ?? error?.cause?.status;
    if (actualStatus === status) {
      return;
    }
    throw new Error(`${label} expected XRPC status ${status}, got ${actualStatus ?? "unknown"}`, {
      cause: error,
    });
  }
  throw new Error(`${label} unexpectedly succeeded`);
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
