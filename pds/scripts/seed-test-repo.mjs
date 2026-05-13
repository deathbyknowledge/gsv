#!/usr/bin/env node

const config = {
  baseUrl: requiredEnv("PDS_BASE_URL").replace(/\/+$/, ""),
  adminToken: requiredEnv("PDS_ADMIN_TOKEN"),
  handle: optionalEnv("PDS_HANDLE"),
  did: optionalEnv("PDS_DID"),
  repo: optionalEnv("PDS_REPO"),
  accountPassword: optionalEnv(
    "PDS_SEED_ACCOUNT_PASSWORD",
    optionalEnv("PDS_ACCOUNT_PASSWORD", "dev-account-password"),
  ),
  recordPath: optionalEnv("PDS_RECORD_PATH", "app.gsv.record/seed"),
  recordJson: optionalEnv("PDS_RECORD_JSON"),
};

const base = new URL(config.baseUrl);
const host = config.handle ?? base.hostname;
const did = config.did ?? `did:web:${host}`;
const repo = config.repo ?? repoNameFromDidOrHandle(did, host);
const [collection, rkey] = parseRecordPath(config.recordPath);
const record = config.recordJson
  ? JSON.parse(config.recordJson)
  : {
      $type: collection,
      text: "Hello from a seeded GSV PDS test repo",
      createdAt: new Date().toISOString(),
    };
const baseOrigin = base.origin;

await expectJson("health", "GET", "/xrpc/_health", null, (body) => {
  if (body.status !== "ok") {
    throw new Error(`expected health status ok, got ${JSON.stringify(body)}`);
  }
});

await expectJsonStatus(
  "direct repo route is not public",
  "GET",
  `/repos/${encodeURIComponent(repo)}/status`,
  null,
  404,
);

await expectJsonStatus(
  "internal repo control route is not public",
  "GET",
  `/_pds_internal/repos/${encodeURIComponent(repo)}/status`,
  null,
  404,
);

await expectJsonStatus(
  "internal directory control route is not public",
  "GET",
  "/_pds_internal/directory/status",
  null,
  404,
);

const session = await ensureAccountSession();
const writeAuthHeaders = { authorization: `Bearer ${session.accessJwt}` };

const didDocument = await expectJson(
  "DID document",
  "GET",
  "/.well-known/did.json",
  null,
  (body) => {
    if (body.id !== did) {
      throw new Error(`DID document returned id ${body.id}, expected ${did}`);
    }
    const serviceEndpoint = atprotoServiceEndpoint(body);
    if (serviceEndpoint !== baseOrigin) {
      throw new Error(
        `DID document returned service endpoint ${serviceEndpoint}, expected ${baseOrigin}`,
      );
    }
  },
);

const handleDid = await expectText("handle DID", "GET", "/.well-known/atproto-did", null, (body) => {
  if (body.trim() !== did) {
    throw new Error(`handle DID returned ${body}, expected ${did}`);
  }
});

await expectJson(
  "put Lexicon",
  "POST",
  "/xrpc/com.atproto.repo.putRecord",
  {
    repo: did,
    collection: "com.atproto.lexicon.schema",
    rkey: collection,
    validate: false,
    record: publishedLexiconRecord(recordLexicon(collection)),
  },
  (body) => {
    if (
      body.uri !== `at://${did}/com.atproto.lexicon.schema/${collection}` ||
      !body.cid ||
      !body.commit?.cid
    ) {
      throw new Error(`unexpected put Lexicon response ${JSON.stringify(body)}`);
    }
  },
  writeAuthHeaders,
);

await expectJson(
  "published Lexicon record",
  "GET",
  `/xrpc/com.atproto.repo.getRecord?repo=${encodeQuery(did)}&collection=com.atproto.lexicon.schema&rkey=${encodeQuery(collection)}`,
  null,
  (body) => {
    if (
      body.uri !== `at://${did}/com.atproto.lexicon.schema/${collection}` ||
      body.value?.$type !== "com.atproto.lexicon.schema" ||
      body.value?.id !== collection
    ) {
      throw new Error(`unexpected published Lexicon record ${JSON.stringify(body)}`);
    }
  },
);

const seedRecord = await expectJson(
  "seed record",
  "POST",
  "/xrpc/com.atproto.repo.putRecord",
  {
    repo: did,
    collection,
    rkey,
    validate: true,
    record,
  },
  (body) => {
    if (
      body.uri !== `at://${did}/${collection}/${rkey}` ||
      !body.cid ||
      !body.commit?.cid ||
      body.validationStatus !== "valid"
    ) {
      throw new Error(`unexpected seed record response ${JSON.stringify(body)}`);
    }
  },
  writeAuthHeaders,
);

const xrpcRkey = "xrpc-seed";
const xrpcCreate = await expectJson(
  "XRPC createRecord",
  "POST",
  "/xrpc/com.atproto.repo.createRecord",
  {
    repo: did,
    collection,
    rkey: xrpcRkey,
    validate: true,
    record: {
      $type: collection,
      text: "created through XRPC",
      createdAt: new Date().toISOString(),
    },
  },
  (body) => {
    if (
      body.uri !== `at://${did}/${collection}/${xrpcRkey}` ||
      !body.cid ||
      !body.commit?.cid ||
      body.validationStatus !== "valid"
    ) {
      throw new Error(`unexpected createRecord response ${JSON.stringify(body)}`);
    }
  },
  writeAuthHeaders,
);

const xrpcPut = await expectJson(
  "XRPC putRecord",
  "POST",
  "/xrpc/com.atproto.repo.putRecord",
  {
    repo: host,
    collection,
    rkey: xrpcRkey,
    validate: true,
    record: {
      $type: collection,
      text: "updated through XRPC",
      updatedAt: new Date().toISOString(),
    },
  },
  (body) => {
    if (
      body.uri !== `at://${did}/${collection}/${xrpcRkey}` ||
      !body.cid ||
      !body.commit?.cid ||
      body.validationStatus !== "valid"
    ) {
      throw new Error(`unexpected putRecord response ${JSON.stringify(body)}`);
    }
  },
  writeAuthHeaders,
);

const xrpcDelete = await expectJson(
  "XRPC deleteRecord",
  "POST",
  "/xrpc/com.atproto.repo.deleteRecord",
  {
    repo: did,
    collection,
    rkey: xrpcRkey,
  },
  (body) => {
    if (!body.commit?.cid || !body.commit?.rev) {
      throw new Error(`unexpected deleteRecord response ${JSON.stringify(body)}`);
    }
  },
  writeAuthHeaders,
);

let latestCommit = xrpcDelete.commit.cid;
let latestRev = xrpcDelete.commit.rev;

const blobBytes = new TextEncoder().encode("hello from a GSV blob");
const uploadBlob = await expectJson(
  "upload blob",
  "POST",
  "/xrpc/com.atproto.repo.uploadBlob",
  blobBytes,
  (body) => {
    if (body.blob?.mimeType !== "text/plain" || body.blob?.size !== blobBytes.byteLength) {
      throw new Error(`unexpected uploadBlob response ${JSON.stringify(body)}`);
    }
  },
  { ...writeAuthHeaders, "content-type": "text/plain" },
);
const blobCid = uploadBlob.blob.ref?.$link;
if (!blobCid) {
  throw new Error(`uploadBlob response did not include blob ref: ${JSON.stringify(uploadBlob)}`);
}

const applySinceRev = latestRev;
const applySeedRkey = `apply-seed-${Date.now().toString(36)}`;
await expectJsonStatus(
  "stale swapCommit",
  "POST",
  "/xrpc/com.atproto.repo.putRecord",
  {
    repo: did,
    collection,
    rkey: "swap-stale",
    swapCommit: xrpcPut.commit.cid,
    record: {
      $type: collection,
      text: "this should not commit",
    },
  },
  400,
  writeAuthHeaders,
);

await expectJsonStatus(
  "swapRecord absent assertion",
  "POST",
  "/xrpc/com.atproto.repo.putRecord",
  {
    repo: did,
    collection,
    rkey,
    swapRecord: null,
    record: {
      $type: collection,
      text: "this should not overwrite an existing record",
    },
  },
  400,
  writeAuthHeaders,
);

const applyWrites = await expectJson(
  "XRPC applyWrites",
  "POST",
  "/xrpc/com.atproto.repo.applyWrites",
  {
    repo: did,
    swapCommit: latestCommit,
    validate: true,
    writes: [
      {
        $type: "com.atproto.repo.applyWrites#create",
        collection,
        rkey: applySeedRkey,
        value: {
          $type: collection,
          text: "created through applyWrites",
          attachment: blobRef(blobCid, "text/plain", blobBytes.byteLength),
        },
      },
      {
        $type: "com.atproto.repo.applyWrites#create",
        collection,
        value: {
          $type: collection,
          text: "created through applyWrites with generated rkey A",
        },
      },
      {
        $type: "com.atproto.repo.applyWrites#create",
        collection,
        value: {
          $type: collection,
          text: "created through applyWrites with generated rkey B",
        },
      },
    ],
  },
  (body) => {
    if (!body.commit?.cid || body.results?.length !== 3) {
      throw new Error(`unexpected applyWrites response ${JSON.stringify(body)}`);
    }
    if (body.results.some((result) => result.validationStatus && result.validationStatus !== "valid")) {
      throw new Error(`applyWrites did not validate known records ${JSON.stringify(body)}`);
    }
    const generatedUris = body.results.slice(2).map((result) => result.uri);
    if (
      generatedUris.some((uri) => typeof uri !== "string" || !uri.startsWith(`at://${did}/${collection}/`)) ||
      generatedUris[0] === generatedUris[1]
    ) {
      throw new Error(`applyWrites generated duplicate or invalid rkeys ${JSON.stringify(body)}`);
    }
  },
  writeAuthHeaders,
);
latestCommit = applyWrites.commit.cid;
latestRev = applyWrites.commit.rev;

const listRepos = await expectJson(
  "list repos",
  "GET",
  "/xrpc/com.atproto.sync.listRepos?limit=500",
  null,
  (body) => {
    const hostedRepo = body.repos?.find((repo) => repo.did === did);
    if (!hostedRepo) {
      throw new Error(`listRepos did not include ${did}: ${JSON.stringify(body)}`);
    }
    if (hostedRepo.head !== latestCommit || hostedRepo.rev !== latestRev) {
      throw new Error(`listRepos returned stale repo state: ${JSON.stringify(hostedRepo)}`);
    }
  },
);

const describe = await expectJson(
  "describe repo",
  "GET",
  `/xrpc/com.atproto.repo.describeRepo?repo=${encodeQuery(host)}`,
  null,
  (body) => {
    if (body.did !== did) {
      throw new Error(`describeRepo returned DID ${body.did}, expected ${did}`);
    }
    if (!body.collections?.includes(collection)) {
      throw new Error(`describeRepo did not include collection ${collection}`);
    }
  },
);

await expectJson(
  "repo status",
  "GET",
  `/xrpc/com.atproto.sync.getRepoStatus?did=${encodeQuery(did)}`,
  null,
  (body) => {
    if (body.did !== did || body.active !== true) {
      throw new Error(`unexpected repo status ${JSON.stringify(body)}`);
    }
  },
);

const head = await expectJson(
  "repo head",
  "GET",
  `/xrpc/com.atproto.sync.getHead?did=${encodeQuery(did)}`,
  null,
  (body) => {
    if (body.root !== latestCommit) {
      throw new Error(`unexpected repo head ${JSON.stringify(body)}, expected ${latestCommit}`);
    }
  },
);

const hostStatus = await expectJson(
  "host status",
  "GET",
  `/xrpc/com.atproto.sync.getHostStatus?hostname=${encodeQuery(base.hostname)}`,
  null,
  (body) => {
    if (body.hostname !== base.hostname || body.status !== "active" || typeof body.seq !== "number") {
      throw new Error(`unexpected host status ${JSON.stringify(body)}`);
    }
  },
);

const reposByCollection = await expectJson(
  "list repos by collection",
  "GET",
  `/xrpc/com.atproto.sync.listReposByCollection?collection=${encodeQuery(collection)}&limit=500`,
  null,
  (body) => {
    const hostedRepo = body.repos?.find((repo) => repo.did === did);
    if (!hostedRepo) {
      throw new Error(`listReposByCollection did not include ${did}: ${JSON.stringify(body)}`);
    }
  },
);

const listBlobs = await expectJson(
  "list blobs",
  "GET",
  `/xrpc/com.atproto.sync.listBlobs?did=${encodeQuery(did)}`,
  null,
  (body) => {
    if (!Array.isArray(body.cids) || !body.cids.includes(blobCid)) {
      throw new Error(`expected blob ${blobCid}, got ${JSON.stringify(body)}`);
    }
  },
);

const missingBlobRefs = await expectJson(
  "list missing blobs",
  "GET",
  "/xrpc/com.atproto.repo.listMissingBlobs",
  null,
  (body) => {
    if (!Array.isArray(body.blobs)) {
      throw new Error(`unexpected missing blob response ${JSON.stringify(body)}`);
    }
  },
  writeAuthHeaders,
);

await expectBytes(
  "get blob",
  "GET",
  `/xrpc/com.atproto.sync.getBlob?did=${encodeQuery(did)}&cid=${encodeQuery(blobCid)}`,
  null,
  async (response, bytes) => {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/plain") || new TextDecoder().decode(bytes) !== "hello from a GSV blob") {
      throw new Error(
        `unexpected blob response content-type=${contentType} bytes=${new TextDecoder().decode(bytes)}`,
      );
    }
  },
);

await expectJson(
  "get record",
  "GET",
  `/xrpc/com.atproto.repo.getRecord?repo=${encodeQuery(host)}&collection=${encodeQuery(collection)}&rkey=${encodeQuery(rkey)}`,
  null,
  (body) => {
    if (body.uri !== `at://${did}/${collection}/${rkey}`) {
      throw new Error(`unexpected record URI ${body.uri}`);
    }
  },
);

const missingBlob = await expectJsonStatus(
  "missing blob",
  "GET",
  `/xrpc/com.atproto.sync.getBlob?did=${encodeQuery(did)}&cid=${encodeQuery(seedRecord.commit.cid)}`,
  null,
  404,
);

await expectJsonStatus(
  "subscribeRepos requires websocket",
  "GET",
  "/xrpc/com.atproto.sync.subscribeRepos",
  null,
  426,
);
const subscribeRepos = await expectSubscribeReposEvent(
  `/xrpc/com.atproto.sync.subscribeRepos?cursor=0`,
);

const repoCar = await request("GET", `/xrpc/com.atproto.sync.getRepo?did=${encodeQuery(did)}`);
const contentType = repoCar.headers.get("content-type") ?? "";
const carBytes = await repoCar.arrayBuffer();
if (!repoCar.ok || !contentType.includes("application/vnd.ipld.car") || carBytes.byteLength === 0) {
  throw new Error(
    `getRepo CAR check failed: status=${repoCar.status} content-type=${contentType} bytes=${carBytes.byteLength}`,
  );
}

const checkoutCar = await request(
  "GET",
  `/xrpc/com.atproto.sync.getCheckout?did=${encodeQuery(did)}`,
);
const checkoutContentType = checkoutCar.headers.get("content-type") ?? "";
const checkoutCarBytes = await checkoutCar.arrayBuffer();
if (
  !checkoutCar.ok ||
  !checkoutContentType.includes("application/vnd.ipld.car") ||
  checkoutCarBytes.byteLength === 0
) {
  throw new Error(
    `getCheckout CAR check failed: status=${checkoutCar.status} content-type=${checkoutContentType} bytes=${checkoutCarBytes.byteLength}`,
  );
}

const blocksCar = await request(
  "GET",
  `/xrpc/com.atproto.sync.getBlocks?did=${encodeQuery(did)}&cids=${encodeQuery(latestCommit)}&cids=${encodeQuery(seedRecord.commit.cid)}`,
);
const blocksContentType = blocksCar.headers.get("content-type") ?? "";
const blocksCarBytes = await blocksCar.arrayBuffer();
if (
  !blocksCar.ok ||
  !blocksContentType.includes("application/vnd.ipld.car") ||
  blocksCarBytes.byteLength === 0
) {
  throw new Error(
    `getBlocks CAR check failed: status=${blocksCar.status} content-type=${blocksContentType} bytes=${blocksCarBytes.byteLength}`,
  );
}

const missingBlock = await expectJsonStatus(
  "missing repo block",
  "GET",
  `/xrpc/com.atproto.sync.getBlocks?did=${encodeQuery(did)}&cids=${encodeQuery(blobCid)}`,
  null,
  404,
);

const repoDiffCar = await request(
  "GET",
  `/xrpc/com.atproto.sync.getRepo?did=${encodeQuery(did)}&since=${encodeQuery(applySinceRev)}`,
);
const diffContentType = repoDiffCar.headers.get("content-type") ?? "";
const diffCarBytes = await repoDiffCar.arrayBuffer();
if (!repoDiffCar.ok || !diffContentType.includes("application/vnd.ipld.car") || diffCarBytes.byteLength === 0) {
  throw new Error(
    `getRepo diff CAR check failed: status=${repoDiffCar.status} content-type=${diffContentType} bytes=${diffCarBytes.byteLength}`,
  );
}

const importSourceCommit = latestCommit;
const importSourceRev = latestRev;
const importSourceBytes = new Uint8Array(carBytes);
const importSourceStatus = await checkAccountStatus(
  "status before import probe",
  (body) => {
    if (body.repoCommit !== importSourceCommit || body.repoRev !== importSourceRev) {
      throw new Error(`unexpected status before import probe ${JSON.stringify(body)}`);
    }
    if (typeof body.importedBlobs !== "number" || typeof body.expectedBlobs !== "number") {
      throw new Error(`repo status did not include blob counters ${JSON.stringify(body)}`);
    }
  },
);
const importProbeBlobBytes = new TextEncoder().encode(`temporary import blob ${Date.now()}`);
const importProbeBlob = await expectJson(
  "import probe upload blob",
  "POST",
  "/xrpc/com.atproto.repo.uploadBlob",
  importProbeBlobBytes,
  (body) => {
    if (body.blob?.mimeType !== "text/plain" || body.blob?.size !== importProbeBlobBytes.byteLength) {
      throw new Error(`unexpected import probe uploadBlob response ${JSON.stringify(body)}`);
    }
  },
  { ...writeAuthHeaders, "content-type": "text/plain" },
);
const importProbeBlobCid = importProbeBlob.blob.ref?.$link;
if (!importProbeBlobCid) {
  throw new Error(`import probe uploadBlob response did not include blob ref: ${JSON.stringify(importProbeBlob)}`);
}
const importProbeRkey = `import-probe-${Date.now().toString(36)}`;
const importProbe = await expectJson(
  "import probe createRecord",
  "POST",
  "/xrpc/com.atproto.repo.createRecord",
  {
    repo: did,
    collection,
    rkey: importProbeRkey,
    validate: true,
    record: {
      $type: collection,
      text: "temporary record that importRepo should remove",
      attachment: blobRef(importProbeBlobCid, "text/plain", importProbeBlobBytes.byteLength),
      createdAt: new Date().toISOString(),
    },
  },
  (body) => {
    if (!body.commit?.cid || !body.commit?.rev || body.validationStatus !== "valid") {
      throw new Error(`unexpected import probe createRecord response ${JSON.stringify(body)}`);
    }
  },
  writeAuthHeaders,
);
latestCommit = importProbe.commit.cid;
latestRev = importProbe.commit.rev;

await checkAccountStatus("status with import probe blob", (body) => {
  if (
    body.importedBlobs !== importSourceStatus.importedBlobs + 1 ||
    body.expectedBlobs !== importSourceStatus.expectedBlobs + 1
  ) {
    throw new Error(
      `import probe blob was not tracked as a new blob: before=${JSON.stringify(importSourceStatus)} after=${JSON.stringify(body)}`,
    );
  }
});

await expectJson(
  "import probe exists",
  "GET",
  `/xrpc/com.atproto.repo.getRecord?repo=${encodeQuery(did)}&collection=${encodeQuery(collection)}&rkey=${encodeQuery(importProbeRkey)}`,
  null,
  (body) => {
    if (body.uri !== `at://${did}/${collection}/${importProbeRkey}`) {
      throw new Error(`unexpected import probe record ${JSON.stringify(body)}`);
    }
  },
);

await expectStatus(
  "import repo",
  "POST",
  "/xrpc/com.atproto.repo.importRepo",
  importSourceBytes,
  200,
  { ...writeAuthHeaders, "content-type": "application/vnd.ipld.car" },
);

const importedHead = await expectJson(
  "latest after import",
  "GET",
  `/xrpc/com.atproto.sync.getLatestCommit?did=${encodeQuery(did)}`,
  null,
  (body) => {
    if (body.cid !== importSourceCommit || body.rev !== importSourceRev) {
      throw new Error(`importRepo did not restore source head: ${JSON.stringify(body)}`);
    }
  },
);
latestCommit = importedHead.cid;
latestRev = importedHead.rev;

await expectJsonStatus(
  "import removed probe",
  "GET",
  `/xrpc/com.atproto.repo.getRecord?repo=${encodeQuery(did)}&collection=${encodeQuery(collection)}&rkey=${encodeQuery(importProbeRkey)}`,
  null,
  404,
);

await expectJsonStatus(
  "import removed probe blob",
  "GET",
  `/xrpc/com.atproto.sync.getBlob?did=${encodeQuery(did)}&cid=${encodeQuery(importProbeBlobCid)}`,
  null,
  404,
);

await checkAccountStatus("status after import blob GC", (body) => {
  if (
    body.importedBlobs !== importSourceStatus.importedBlobs ||
    body.expectedBlobs !== importSourceStatus.expectedBlobs
  ) {
    throw new Error(
      `importRepo did not GC the probe blob: before=${JSON.stringify(importSourceStatus)} after=${JSON.stringify(body)}`,
    );
  }
});

const listReposAfterImport = await expectJson(
  "list repos after import",
  "GET",
  "/xrpc/com.atproto.sync.listRepos?limit=500",
  null,
  (body) => {
    const hostedRepo = body.repos?.find((repo) => repo.did === did);
    if (!hostedRepo || hostedRepo.head !== latestCommit || hostedRepo.rev !== latestRev) {
      throw new Error(`listRepos returned stale imported repo state: ${JSON.stringify(body)}`);
    }
  },
);

const reposByCollectionAfterImport = await expectJson(
  "list repos by collection after import",
  "GET",
  `/xrpc/com.atproto.sync.listReposByCollection?collection=${encodeQuery(collection)}&limit=500`,
  null,
  (body) => {
    const hostedRepo = body.repos?.find((repo) => repo.did === did);
    if (!hostedRepo) {
      throw new Error(`listReposByCollection lost imported repo ${did}: ${JSON.stringify(body)}`);
    }
  },
);

const atRepoUri = `at://${did}`;
const atRecordUri = `${atRepoUri}/${collection}/${rkey}`;
const pdslsRepoUrl = `https://pdsls.dev/${atRepoUri}`;
const pdslsRecordUrl = `https://pdsls.dev/${atRecordUri}`;

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl: config.baseUrl,
      repo,
      did,
      handle: host,
      handleDid: handleDid.trim(),
      didDocumentServiceEndpoint: atprotoServiceEndpoint(didDocument),
      seedRecordCommit: seedRecord.commit.cid,
      latestCommit,
      latestRev,
      xrpcCreateCommit: xrpcCreate.commit.cid,
      xrpcPutCommit: xrpcPut.commit.cid,
      xrpcDeleteCommit: xrpcDelete.commit.cid,
      applyWritesCommit: applyWrites.commit.cid,
      listedRepos: listRepos.repos.length,
      listedReposByCollection: reposByCollection.repos.length,
      listedBlobs: listBlobs.cids.length,
      missingBlobRefs: missingBlobRefs.blobs.length,
      subscribeRepos,
      blobCid,
      missingBlobStatus: missingBlob.status,
      head: head.root,
      hostStatus,
      collection,
      rkey,
      atRepoUri,
      atRecordUri,
      carBytes: carBytes.byteLength,
      checkoutCarBytes: checkoutCarBytes.byteLength,
      blocksCarBytes: blocksCarBytes.byteLength,
      diffCarBytes: diffCarBytes.byteLength,
      missingBlockStatus: missingBlock.status,
      importSourceCommit,
      importSourceRev,
      importProbeCommit: importProbe.commit.cid,
      importProbeRemoved: true,
      listedReposAfterImport: listReposAfterImport.repos.length,
      listedReposByCollectionAfterImport: reposByCollectionAfterImport.repos.length,
      pdslsRepoUrl,
      pdslsRecordUrl,
      handleIsCorrect: describe.handleIsCorrect,
    },
    null,
    2,
  ),
);

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
  validate?.(parsed);
  return parsed;
}

async function ensureAccountSession() {
  const created = await maybeCreateAccount();
  if (!created) {
    await expectStatus(
      "admin update seed account password",
      "POST",
      "/xrpc/com.atproto.admin.updateAccountPassword",
      { did, password: config.accountPassword },
      200,
      { authorization: `Bearer ${config.adminToken}` },
    );
  }
  return expectJson(
    "seed create session",
    "POST",
    "/xrpc/com.atproto.server.createSession",
    {
      identifier: host,
      password: config.accountPassword,
    },
    (body) => {
      if (body.did !== did || body.handle !== host || !body.accessJwt || !body.refreshJwt) {
        throw new Error(`unexpected seed createSession response ${JSON.stringify(body)}`);
      }
    },
  );
}

async function maybeCreateAccount() {
  const requestBody = {
    handle: host,
    password: config.accountPassword,
  };
  if (!did.startsWith("did:web:")) {
    requestBody.did = did;
  }
  const response = await request(
    "POST",
    "/xrpc/com.atproto.server.createAccount",
    requestBody,
    { authorization: `Bearer ${config.adminToken}` },
  );
  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`createAccount returned non-JSON status=${response.status}: ${text}`, {
      cause: error,
    });
  }
  if (response.ok) {
    if (parsed.did !== did || parsed.handle !== host || !parsed.accessJwt) {
      throw new Error(`unexpected createAccount response ${JSON.stringify(parsed)}`);
    }
    return true;
  }
  const error = String(parsed.error ?? "");
  if (
    response.status === 400 &&
    (error.includes("HandleNotAvailable") || error.includes("DidNotAvailable"))
  ) {
    return false;
  }
  if (response.status === 409 && error.includes("repo already initialized")) {
    return false;
  }
  throw new Error(`createAccount failed status=${response.status}: ${JSON.stringify(parsed)}`);
}

async function checkAccountStatus(label, validate = undefined) {
  return expectJson(
    label,
    "GET",
    "/xrpc/com.atproto.server.checkAccountStatus",
    null,
    (body) => {
      if (body.activated !== true || body.validDid !== true) {
        throw new Error(`unexpected account status ${JSON.stringify(body)}`);
      }
      validate?.(body);
    },
    { authorization: `Bearer ${session.accessJwt}` },
  );
}

async function expectText(label, method, path, body, validate = undefined) {
  const response = await request(method, path, body);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed status=${response.status}: ${text}`);
  }
  validate?.(text);
  return text;
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

async function expectStatus(label, method, path, body, expectedStatus, extraHeaders = {}) {
  const response = await request(method, path, body, extraHeaders);
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${label} returned status=${response.status}, expected ${expectedStatus}: ${text}`);
  }
  return { status: response.status, body: text };
}

async function expectJsonStatus(label, method, path, body, expectedStatus, extraHeaders = {}) {
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
    throw new Error(
      `${label} returned status=${response.status}, expected ${expectedStatus}: ${JSON.stringify(parsed)}`,
    );
  }
  if (parsed.error === "MethodNotFound") {
    throw new Error(`${label} still returned MethodNotFound`);
  }
  return { status: response.status, body: parsed };
}

async function expectSubscribeReposEvent(path) {
  if (typeof WebSocket === "undefined") {
    return { skipped: "global WebSocket is unavailable in this Node runtime" };
  }

  const url = new URL(path, `${config.baseUrl}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`subscribeRepos did not deliver a binary frame before timeout`));
    }, 3000);

    socket.addEventListener("message", (event) => {
      const byteLength = binaryMessageLength(event.data);
      if (byteLength <= 0) {
        clearTimeout(timeout);
        socket.close();
        reject(new Error(`subscribeRepos returned an empty or non-binary frame`));
        return;
      }
      clearTimeout(timeout);
      socket.close();
      resolve({ binaryFrames: 1, firstFrameBytes: byteLength });
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`subscribeRepos WebSocket failed`));
    });
  });
}

function binaryMessageLength(data) {
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength;
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.size;
  }
  return 0;
}

async function request(method, path, body = null, extraHeaders = {}) {
  const headers = {
    authorization: `Bearer ${config.adminToken}`,
    ...extraHeaders,
  };
  let payload;
  if (body !== null) {
    if (body instanceof Uint8Array) {
      payload = body;
      headers["content-length"] = headers["content-length"] ?? String(body.byteLength);
    } else {
      headers["content-type"] = headers["content-type"] ?? "application/json";
      payload = JSON.stringify(body);
    }
  }
  return fetch(new URL(path, `${config.baseUrl}/`), {
    method,
    headers,
    body: payload,
  });
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return value;
}

function optionalEnv(name, fallback = undefined) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
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
  return didDocument.service?.find((service) => service.id === "#atproto_pds")
    ?.serviceEndpoint;
}

function recordLexicon(id) {
  return {
    lexicon: 1,
    id,
    defs: {
      main: {
        type: "record",
        key: "any",
        record: {
          type: "object",
          required: ["$type", "text"],
          properties: {
            $type: { type: "string", const: id },
            text: { type: "string", maxLength: 4096 },
            createdAt: { type: "string", format: "datetime" },
            updatedAt: { type: "string", format: "datetime" },
            attachment: {
              type: "blob",
              accept: ["*/*"],
              maxSize: 10485760,
            },
          },
        },
      },
    },
  };
}

function publishedLexiconRecord(lexicon) {
  return {
    ...lexicon,
    $type: "com.atproto.lexicon.schema",
  };
}

function blobRef(cid, mimeType, size) {
  return {
    $type: "blob",
    ref: { $link: cid },
    mimeType,
    size,
  };
}

function parseRecordPath(path) {
  const parts = path.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`PDS_RECORD_PATH must be collection/rkey, got ${path}`);
  }
  return parts;
}

function encodeQuery(value) {
  return encodeURIComponent(value);
}
