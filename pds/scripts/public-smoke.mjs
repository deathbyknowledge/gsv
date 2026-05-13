#!/usr/bin/env node

const config = {
  baseUrl: requiredEnv("PDS_BASE_URL").replace(/\/+$/, ""),
  handle: optionalEnv("PDS_PUBLIC_HANDLE", optionalEnv("PDS_ACCOUNT_HANDLE")),
  did: optionalEnv("PDS_PUBLIC_DID"),
  collection: optionalEnv("PDS_PUBLIC_COLLECTION", "app.gsv.accountSmoke"),
  rkey: optionalEnv("PDS_PUBLIC_RKEY"),
  blobCid: optionalEnv("PDS_PUBLIC_BLOB_CID"),
};

const base = new URL(config.baseUrl);
const baseOrigin = base.origin;
const handle = config.handle ?? base.hostname;
const did = config.did ?? `did:web:${handle}`;
const repo = repoNameFromDidOrHandle(did, handle);

await expectJson("health", "GET", "/xrpc/_health", null, (body) => {
  if (body.status !== "ok") {
    throw new Error(`expected health status ok, got ${JSON.stringify(body)}`);
  }
});

await expectJson("DID document", "GET", "/.well-known/did.json", null, (body) => {
  if (body.id !== did) {
    throw new Error(`DID document returned id ${body.id}, expected ${did}`);
  }
  const serviceEndpoint = atprotoServiceEndpoint(body);
  if (serviceEndpoint !== baseOrigin) {
    throw new Error(`DID document returned service endpoint ${serviceEndpoint}, expected ${baseOrigin}`);
  }
});

await expectText("handle DID", "GET", "/.well-known/atproto-did", null, (body) => {
  if (body.trim() !== did) {
    throw new Error(`handle DID returned ${body}, expected ${did}`);
  }
});

await expectJson(
  "resolve handle",
  "GET",
  `/xrpc/com.atproto.identity.resolveHandle?handle=${encodeQuery(handle)}`,
  null,
  (body) => {
    if (body.did !== did) {
      throw new Error(`resolveHandle returned ${JSON.stringify(body)}, expected DID ${did}`);
    }
  },
);

await expectJson(
  "resolve DID",
  "GET",
  `/xrpc/com.atproto.identity.resolveDid?did=${encodeQuery(did)}`,
  null,
  (body) => {
    if (body.didDoc?.id !== did) {
      throw new Error(`resolveDid returned ${JSON.stringify(body)}, expected DID document id ${did}`);
    }
    const serviceEndpoint = atprotoServiceEndpoint(body.didDoc);
    if (serviceEndpoint !== baseOrigin) {
      throw new Error(`resolveDid service endpoint ${serviceEndpoint}, expected ${baseOrigin}`);
    }
  },
);

await expectJson(
  "resolve identity by handle",
  "GET",
  `/xrpc/com.atproto.identity.resolveIdentity?identifier=${encodeQuery(handle)}`,
  null,
  (body) => {
    expectIdentityInfo(body);
  },
);

await expectJson(
  "resolve identity by DID",
  "GET",
  `/xrpc/com.atproto.identity.resolveIdentity?identifier=${encodeQuery(did)}`,
  null,
  (body) => {
    expectIdentityInfo(body);
  },
);

await expectJsonStatus(
  "unknown DID",
  "GET",
  `/xrpc/com.atproto.identity.resolveDid?did=${encodeQuery(`did:web:unknown-${handle}`)}`,
  null,
  404,
  (body) => {
    if (body.error !== "DidNotFound" || typeof body.message !== "string") {
      throw new Error(`unexpected unknown DID response ${JSON.stringify(body)}`);
    }
  },
);

await expectJsonStatus(
  "unknown identity",
  "GET",
  `/xrpc/com.atproto.identity.resolveIdentity?identifier=${encodeQuery(`unknown-${handle}`)}`,
  null,
  404,
  (body) => {
    if (body.error !== "HandleNotFound" || typeof body.message !== "string") {
      throw new Error(`unexpected unknown identity response ${JSON.stringify(body)}`);
    }
  },
);

await expectJsonStatus(
  "unknown handle",
  "GET",
  `/xrpc/com.atproto.identity.resolveHandle?handle=${encodeQuery(`unknown-${handle}`)}`,
  null,
  404,
  (body) => {
    if (body.error !== "HandleNotFound" || typeof body.message !== "string") {
      throw new Error(`unexpected unknown handle response ${JSON.stringify(body)}`);
    }
  },
);

await expectJson(
  "describe server",
  "GET",
  "/xrpc/com.atproto.server.describeServer",
  null,
  (body) => {
    if (body.did !== did) {
      throw new Error(`describeServer DID ${body.did}, expected ${did}`);
    }
    if (!body.availableUserDomains?.includes(base.hostname)) {
      throw new Error(`describeServer did not advertise ${base.hostname}: ${JSON.stringify(body)}`);
    }
    if (body.phoneVerificationRequired !== false) {
      throw new Error(`unexpected describeServer response ${JSON.stringify(body)}`);
    }
  },
);

await expectJson(
  "OAuth protected resource metadata",
  "GET",
  "/.well-known/oauth-protected-resource",
  null,
  (body) => {
    if (body.resource !== baseOrigin || body.authorization_servers?.[0] !== baseOrigin) {
      throw new Error(`unexpected protected resource metadata ${JSON.stringify(body)}`);
    }
  },
);

await expectJson(
  "OAuth authorization server metadata",
  "GET",
  "/.well-known/oauth-authorization-server",
  null,
  (body) => {
    if (
      body.issuer !== baseOrigin ||
      body.authorization_endpoint !== `${baseOrigin}/oauth/authorize` ||
      body.token_endpoint !== `${baseOrigin}/oauth/token`
    ) {
      throw new Error(`unexpected authorization server metadata ${JSON.stringify(body)}`);
    }
  },
);

const describeRepo = await expectJson(
  "describe repo",
  "GET",
  `/xrpc/com.atproto.repo.describeRepo?repo=${encodeQuery(repo)}`,
  null,
  (body) => {
    if (body.did !== did || body.handle !== handle) {
      throw new Error(`unexpected describeRepo identity ${JSON.stringify(body)}`);
    }
    if (!body.collections?.includes(config.collection)) {
      throw new Error(`describeRepo did not include ${config.collection}: ${JSON.stringify(body)}`);
    }
    const serviceEndpoint = atprotoServiceEndpoint(body.didDoc);
    if (serviceEndpoint !== baseOrigin) {
      throw new Error(`describeRepo DID document service endpoint ${serviceEndpoint}, expected ${baseOrigin}`);
    }
  },
);

const repoStatus = await expectJson(
  "repo status",
  "GET",
  `/xrpc/com.atproto.sync.getRepoStatus?did=${encodeQuery(did)}`,
  null,
  (body) => {
    if (body.did !== did || body.active !== true || typeof body.rev !== "string") {
      throw new Error(`unexpected repo status ${JSON.stringify(body)}`);
    }
  },
);

const latest = await expectJson(
  "latest commit",
  "GET",
  `/xrpc/com.atproto.sync.getLatestCommit?did=${encodeQuery(did)}`,
  null,
  (body) => {
    if (!body.cid || body.rev !== repoStatus.rev) {
      throw new Error(`unexpected latest commit ${JSON.stringify(body)}, status=${JSON.stringify(repoStatus)}`);
    }
  },
);

await expectJson(
  "repo head",
  "GET",
  `/xrpc/com.atproto.sync.getHead?did=${encodeQuery(did)}`,
  null,
  (body) => {
    if (body.root !== latest.cid) {
      throw new Error(`unexpected repo head ${JSON.stringify(body)}, expected ${latest.cid}`);
    }
  },
);

const record = await publicRecord();
const [recordCollection, recordRkey] = recordPathFromUri(record.uri, did);
if (recordCollection !== config.collection) {
  throw new Error(`selected record collection ${recordCollection}, expected ${config.collection}`);
}

await expectJson(
  "get record by repo",
  "GET",
  `/xrpc/com.atproto.repo.getRecord?repo=${encodeQuery(repo)}&collection=${encodeQuery(recordCollection)}&rkey=${encodeQuery(recordRkey)}`,
  null,
  (body) => {
    if (body.uri !== record.uri || body.cid !== record.cid) {
      throw new Error(`getRecord mismatch ${JSON.stringify(body)}, selected=${JSON.stringify(record)}`);
    }
  },
);

await expectCar(
  "sync get record",
  `/xrpc/com.atproto.sync.getRecord?did=${encodeQuery(did)}&collection=${encodeQuery(recordCollection)}&rkey=${encodeQuery(recordRkey)}`,
);

await expectCar("get repo", `/xrpc/com.atproto.sync.getRepo?did=${encodeQuery(did)}`);
await expectCar("get checkout", `/xrpc/com.atproto.sync.getCheckout?did=${encodeQuery(did)}`);
await expectCar(
  "get latest commit block",
  `/xrpc/com.atproto.sync.getBlocks?did=${encodeQuery(did)}&cids=${encodeQuery(latest.cid)}`,
);

const listBlobs = await expectJson(
  "list blobs",
  "GET",
  `/xrpc/com.atproto.sync.listBlobs?did=${encodeQuery(did)}`,
  null,
  (body) => {
    if (!Array.isArray(body.cids)) {
      throw new Error(`unexpected listBlobs response ${JSON.stringify(body)}`);
    }
  },
);

const blobCid = config.blobCid ?? blobCidFromRecord(record.value);
if (blobCid) {
  if (!listBlobs.cids.includes(blobCid)) {
    throw new Error(`listBlobs did not include ${blobCid}: ${JSON.stringify(listBlobs)}`);
  }
  const blobBytes = await expectBytes(
    "get blob",
    "GET",
    `/xrpc/com.atproto.sync.getBlob?did=${encodeQuery(did)}&cid=${encodeQuery(blobCid)}`,
    null,
    async (response, bytes) => {
      const contentType = response.headers.get("content-type") ?? "";
      if (bytes.byteLength === 0 || !contentType) {
        throw new Error(`unexpected blob response content-type=${contentType} bytes=${bytes.byteLength}`);
      }
    },
  );
  record.blobCid = blobCid;
  record.blobBytes = blobBytes.byteLength;
}

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl: config.baseUrl,
      handle,
      did,
      collection: config.collection,
      latestCommit: latest.cid,
      latestRev: latest.rev,
      describedCollections: describeRepo.collections.length,
      recordUri: record.uri,
      recordCid: record.cid,
      blobCid: record.blobCid,
      blobBytes: record.blobBytes,
      pdslsRepoUrl: `https://pdsls.dev/at://${did}`,
    },
    null,
    2,
  ),
);

async function publicRecord() {
  if (config.rkey) {
    return expectJson(
      "get configured public record",
      "GET",
      `/xrpc/com.atproto.repo.getRecord?repo=${encodeQuery(repo)}&collection=${encodeQuery(config.collection)}&rkey=${encodeQuery(config.rkey)}`,
    );
  }

  const listed = await expectJson(
    "list records",
    "GET",
    `/xrpc/com.atproto.repo.listRecords?repo=${encodeQuery(repo)}&collection=${encodeQuery(config.collection)}&limit=100&reverse=true`,
    null,
    (body) => {
      if (!Array.isArray(body.records) || body.records.length === 0) {
        throw new Error(`listRecords returned no records for ${config.collection}: ${JSON.stringify(body)}`);
      }
    },
  );
  return listed.records.find((entry) => blobCidFromRecord(entry.value)) ?? listed.records[0];
}

async function expectCar(label, path) {
  const response = await request("GET", path);
  const contentType = response.headers.get("content-type") ?? "";
  const bytes = await response.arrayBuffer();
  if (!response.ok || !contentType.includes("application/vnd.ipld.car") || bytes.byteLength === 0) {
    throw new Error(
      `${label} CAR check failed: status=${response.status} content-type=${contentType} bytes=${bytes.byteLength}`,
    );
  }
  return bytes;
}

async function expectJson(label, method, path, body = null, validate = undefined, extraHeaders = {}) {
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

async function expectText(label, method, path, body = null, validate = undefined, extraHeaders = {}) {
  const response = await request(method, path, body, extraHeaders);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed status=${response.status}: ${text}`);
  }
  validate?.(text, response);
  return text;
}

async function expectJsonStatus(
  label,
  method,
  path,
  body = null,
  expectedStatus,
  validate = undefined,
  extraHeaders = {},
) {
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
  if (response.status !== expectedStatus) {
    throw new Error(`${label} returned status=${response.status}, expected ${expectedStatus}: ${JSON.stringify(parsed)}`);
  }
  validate?.(parsed, response);
  return parsed;
}

async function expectBytes(label, method, path, body = null, validate = undefined, extraHeaders = {}) {
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
  if (typeof body === "string" || body instanceof Uint8Array) {
    requestBody = body;
  } else if (body) {
    headers["content-type"] = headers["content-type"] ?? "application/json";
    requestBody = JSON.stringify(body);
  }
  return fetch(`${config.baseUrl}${path}`, {
    method,
    headers,
    body: requestBody,
  });
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
  return value && value.length > 0 ? value : fallback;
}

function repoNameFromDidOrHandle(did, handle) {
  if (did.startsWith("did:gsv:")) {
    return did.slice("did:gsv:".length);
  }
  if (did.startsWith("did:web:")) {
    return did.slice("did:web:".length);
  }
  return handle;
}

function atprotoServiceEndpoint(didDocument) {
  return didDocument?.service?.find((service) => service.id === "#atproto_pds")?.serviceEndpoint;
}

function expectIdentityInfo(body) {
  if (body.did !== did || body.handle !== handle || body.didDoc?.id !== did) {
    throw new Error(`unexpected identityInfo ${JSON.stringify(body)}`);
  }
  const serviceEndpoint = atprotoServiceEndpoint(body.didDoc);
  if (serviceEndpoint !== baseOrigin) {
    throw new Error(`identityInfo service endpoint ${serviceEndpoint}, expected ${baseOrigin}`);
  }
}

function recordPathFromUri(uri, expectedDid) {
  const prefix = `at://${expectedDid}/`;
  if (!uri.startsWith(prefix)) {
    throw new Error(`record URI ${uri} does not start with ${prefix}`);
  }
  const parts = uri.slice(prefix.length).split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`record URI ${uri} does not contain collection/rkey`);
  }
  return parts;
}

function blobCidFromRecord(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const attachment = value.attachment;
  if (attachment?.$type === "blob" && typeof attachment.ref?.$link === "string") {
    return attachment.ref.$link;
  }
  return undefined;
}

function encodeQuery(value) {
  return encodeURIComponent(value);
}
