#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const config = {
  baseUrl: requiredEnv("PDS_BASE_URL").replace(/\/+$/, ""),
  adminToken: requiredEnv("PDS_ADMIN_TOKEN"),
  plcRotationKeyP256Hex: requiredEnv("PDS_PLC_ROTATION_KEY_P256_HEX"),
  plcDirectoryUrl: optionalEnv("PDS_PLC_DIRECTORY_URL", "https://plc.directory").replace(/\/+$/, ""),
  handle: optionalEnv("PDS_MIGRATION_ACCOUNT_HANDLE"),
  handleSuffix: optionalEnv("PDS_MIGRATION_ACCOUNT_HANDLE_SUFFIX", "gsv.dev"),
  password: optionalEnv("PDS_MIGRATION_ACCOUNT_PASSWORD", "dev-migration-account-password"),
  collection: optionalEnv("PDS_MIGRATION_ACCOUNT_COLLECTION", "app.gsv.migrationSmoke"),
};

const base = new URL(config.baseUrl);
const baseOrigin = base.origin;
const serviceDid = `did:web:${base.host}`;
const stamp = Date.now().toString(36);
const handle = (config.handle ?? `migration-${stamp}.${config.handleSuffix}`).toLowerCase();
const rkey = `migration-${stamp}`;
const seed = `migration-smoke:${base.host}:${handle}:${stamp}`;
const createdAt = new Date().toISOString();

const generated = await runFixture({
  type: "generate",
  handle,
  oldPdsOrigin: "https://old-pds.invalid",
  collection: config.collection,
  rkey,
  recordText: `migrated source record ${stamp}`,
  blobText: `migrated source blob ${stamp}`,
  createdAt,
  seed,
});

await submitPlcOperation("submit external PLC genesis", generated.did, generated.genesisOp);
await expectPlcDocument(
  "external PLC genesis document",
  generated.did,
  generated.oldPdsOrigin,
  generated.externalSigningDidKey,
);

const reserved = await expectJson(
  "reserve migration signing key",
  "POST",
  "/xrpc/com.atproto.server.reserveSigningKey",
  { did: generated.did },
  (body) => {
    if (typeof body.signingKey !== "string" || !body.signingKey.startsWith("did:key:z")) {
      throw new Error(`unexpected reserveSigningKey response ${JSON.stringify(body)}`);
    }
  },
  { "x-pds-admin-token": config.adminToken },
);

const finalized = await runFixture({
  type: "finalize",
  generated,
  pdsOrigin: baseOrigin,
  serviceDid,
  reservedSigningKey: reserved.signingKey,
  serverRotationKeyP256Hex: config.plcRotationKeyP256Hex,
  exp: Math.floor(Date.now() / 1000) + 300,
});

const account = await expectJson(
  "create migrated account",
  "POST",
  "/xrpc/com.atproto.server.createAccount",
  {
    handle,
    password: config.password,
    did: generated.did,
    plcOp: finalized.plcOp,
  },
  (body) => {
    if (
      body.did !== generated.did ||
      body.handle !== handle ||
      body.active !== false ||
      body.status !== "deactivated" ||
      !body.accessJwt ||
      !body.refreshJwt
    ) {
      throw new Error(`unexpected migrated createAccount response ${JSON.stringify(body)}`);
    }
  },
  {
    authorization: `Bearer ${finalized.serviceAuth}`,
    "x-pds-admin-token": config.adminToken,
  },
);

await expectPlcDocument("migrated PLC document", generated.did, baseOrigin, reserved.signingKey);

await expectStatus(
  "deactivated migrated write rejected",
  "POST",
  "/xrpc/com.atproto.repo.createRecord",
  {
    repo: generated.did,
    collection: config.collection,
    rkey: `${rkey}-blocked`,
    validate: false,
    record: {
      $type: config.collection,
      text: "this write should be blocked until activation",
      createdAt,
    },
  },
  403,
  { authorization: `Bearer ${account.accessJwt}` },
);

const sourceCar = base64Bytes(generated.sourceRepoCarBase64);
await expectStatus("import migrated repo", "POST", "/xrpc/com.atproto.repo.importRepo", sourceCar, 200, {
  authorization: `Bearer ${account.accessJwt}`,
  "content-type": "application/vnd.ipld.car",
});

await expectJson(
  "list missing blobs before upload",
  "GET",
  "/xrpc/com.atproto.repo.listMissingBlobs",
  null,
  (body) => {
    const missing = body.blobs ?? [];
    if (!missing.some((blob) => blob.cid === generated.blobCid && blob.recordUri === generated.recordUri)) {
      throw new Error(`expected missing blob ${generated.blobCid}, got ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${account.accessJwt}` },
);

const blobBytes = base64Bytes(generated.blobBytesBase64);
await expectJson(
  "upload migrated blob",
  "POST",
  "/xrpc/com.atproto.repo.uploadBlob",
  blobBytes,
  (body) => {
    if (
      body.blob?.ref?.$link !== generated.blobCid ||
      body.blob?.mimeType !== generated.blobMimeType ||
      body.blob?.size !== blobBytes.byteLength
    ) {
      throw new Error(`unexpected migrated uploadBlob response ${JSON.stringify(body)}`);
    }
  },
  {
    authorization: `Bearer ${account.accessJwt}`,
    "content-type": generated.blobMimeType,
  },
);

await expectJson(
  "list missing blobs after upload",
  "GET",
  "/xrpc/com.atproto.repo.listMissingBlobs",
  null,
  (body) => {
    if ((body.blobs ?? []).some((blob) => blob.cid === generated.blobCid)) {
      throw new Error(`migrated blob still missing after upload: ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${account.accessJwt}` },
);

await expectStatus("activate migrated account", "POST", "/xrpc/com.atproto.server.activateAccount", null, 200, {
  authorization: `Bearer ${account.accessJwt}`,
});

await expectJson(
  "get activated migrated session",
  "GET",
  "/xrpc/com.atproto.server.getSession",
  null,
  (body) => {
    if (body.did !== generated.did || body.handle !== handle || body.active !== true || body.status) {
      throw new Error(`unexpected activated getSession response ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${account.accessJwt}` },
);

await expectJson(
  "get migrated record",
  "GET",
  `/xrpc/com.atproto.repo.getRecord?repo=${encodeQuery(generated.did)}&collection=${encodeQuery(config.collection)}&rkey=${encodeQuery(rkey)}`,
  null,
  (body) => {
    if (
      body.uri !== generated.recordUri ||
      body.cid !== generated.recordCid ||
      body.value?.text !== `migrated source record ${stamp}` ||
      body.value?.attachment?.ref?.$link !== generated.blobCid
    ) {
      throw new Error(`unexpected migrated getRecord response ${JSON.stringify(body)}`);
    }
  },
);

await expectBytes(
  "get migrated blob",
  "GET",
  `/xrpc/com.atproto.sync.getBlob?did=${encodeQuery(generated.did)}&cid=${encodeQuery(generated.blobCid)}`,
  null,
  async (response, bytes) => {
    const contentType = response.headers.get("content-type") ?? "";
    const text = new TextDecoder().decode(bytes);
    if (!contentType.includes(generated.blobMimeType) || text !== `migrated source blob ${stamp}`) {
      throw new Error(`unexpected migrated blob response content-type=${contentType} bytes=${text}`);
    }
  },
);

const postActivationRecord = await expectJson(
  "post-activation migrated write",
  "POST",
  "/xrpc/com.atproto.repo.createRecord",
  {
    repo: generated.did,
    collection: config.collection,
    rkey: `${rkey}-active`,
    validate: false,
    record: {
      $type: config.collection,
      text: "created after migration activation",
      createdAt: new Date().toISOString(),
    },
  },
  (body) => {
    if (body.uri !== `at://${generated.did}/${config.collection}/${rkey}-active` || !body.cid || !body.commit?.cid) {
      throw new Error(`unexpected post-activation createRecord response ${JSON.stringify(body)}`);
    }
    if (body.commit.cid === generated.latestCommit) {
      throw new Error(`post-activation commit did not advance from imported head ${generated.latestCommit}`);
    }
  },
  { authorization: `Bearer ${account.accessJwt}` },
);

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl: config.baseUrl,
      handle,
      did: generated.did,
      importedRecord: generated.recordUri,
      importedCommit: generated.latestCommit,
      postActivationRecord: postActivationRecord.uri,
      latestCommit: postActivationRecord.commit.cid,
      blobCid: generated.blobCid,
      pdslsRepoUrl: `https://pdsls.dev/at://${generated.did}`,
    },
    null,
    2,
  ),
);

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

async function submitPlcOperation(label, did, operation) {
  const response = await fetch(`${config.plcDirectoryUrl}/${encodeURIComponent(did)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(operation),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed status=${response.status}: ${text}`);
  }
}

async function expectPlcDocument(label, did, serviceEndpoint, signingDidKey) {
  const publicKeyMultibase = signingDidKey.replace(/^did:key:/, "");
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(`${config.plcDirectoryUrl}/${encodeURIComponent(did)}`);
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`status=${response.status}: ${text}`);
      }
      const body = JSON.parse(text);
      const atprotoMethod = (body.verificationMethod ?? []).find((method) => method.id === `${did}#atproto`);
      if (
        body.id === did &&
        body.service?.some(
          (service) =>
            service.id === "#atproto_pds" &&
            service.type === "AtprotoPersonalDataServer" &&
            service.serviceEndpoint === serviceEndpoint,
        ) &&
        atprotoMethod?.publicKeyMultibase === publicKeyMultibase
      ) {
        return body;
      }
      throw new Error(`unexpected DID document ${JSON.stringify(body)}`);
    } catch (error) {
      lastError = error;
      await sleep(250 * (attempt + 1));
    }
  }
  throw new Error(`${label} did not become visible: ${lastError?.message ?? lastError}`);
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

function base64Bytes(value) {
  return new Uint8Array(Buffer.from(value, "base64"));
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
