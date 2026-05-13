#!/usr/bin/env node
import { AtpAgent } from "@atproto/api";

const config = {
  baseUrl: requiredEnv("PDS_BASE_URL").replace(/\/+$/, ""),
  adminToken: requiredEnv("PDS_ADMIN_TOKEN"),
  handleSuffix: optionalEnv("PDS_CONFORMANCE_HANDLE_SUFFIX", "gsv.dev"),
  password: optionalEnv("PDS_CONFORMANCE_PASSWORD", "dev-conformance-password"),
  collection: optionalEnv("PDS_CONFORMANCE_COLLECTION", "app.gsv.conformanceSmoke"),
  lexiconNsid: optionalEnv("PDS_CONFORMANCE_LEXICON_NSID", "app.gsv.record"),
};

const base = new URL(config.baseUrl);
const stamp = Date.now().toString(36);
const initialHandle = `conformance-${stamp}.${config.handleSuffix}`.toLowerCase();
const updatedHandle = `conformance-renamed-${stamp}.${config.handleSuffix}`.toLowerCase();
let handle = initialHandle;
const rkey = `conformance-${stamp}`;
const putRkey = `${rkey}-put`;
const applyCreateRkey = `${rkey}-apply-create`;
const applyUpdateRkey = `${rkey}-apply-update`;
const appPasswordName = `conformance-${stamp}`;
const createdAt = new Date().toISOString();
const blobText = `hello from xrpc conformance ${stamp}`;
const checkedMethods = [];
const rawCheckedMethods = [];

const publicAgent = new AtpAgent({
  service: config.baseUrl,
});

const describedServer = await checked("com.atproto.server.describeServer", () =>
  publicAgent.com.atproto.server.describeServer(),
);
if (!describedServer.data.did || !describedServer.data.availableUserDomains?.length) {
  throw new Error(`unexpected describeServer response ${JSON.stringify(describedServer.data)}`);
}

await rawChecked("com.atproto.lexicon.resolveLexicon", async () => {
  const data = await rawJson(
    `/xrpc/com.atproto.lexicon.resolveLexicon?nsid=${encodeURIComponent(config.lexiconNsid)}`,
  );
  if (
    data.schema?.$type !== "com.atproto.lexicon.schema" ||
    data.schema?.id !== config.lexiconNsid ||
    !data.cid ||
    !data.uri
  ) {
    throw new Error(`unexpected resolveLexicon response ${JSON.stringify(data)}`);
  }
});

const agent = new AtpAgent({
  service: config.baseUrl,
});

const createdAccount = await checked("com.atproto.server.createAccount", () =>
  agent.com.atproto.server.createAccount(
    {
      handle,
      password: config.password,
    },
    {
      headers: {
        authorization: `Bearer ${config.adminToken}`,
      },
    },
  ),
);
if (!createdAccount.data.did || createdAccount.data.handle !== handle || !createdAccount.data.accessJwt) {
  throw new Error(`unexpected createAccount response ${JSON.stringify(createdAccount.data)}`);
}
const did = createdAccount.data.did;

const session = await checked("com.atproto.server.createSession", () =>
  agent.login({
    identifier: handle,
    password: config.password,
  }),
);
if (session.data.did !== did || agent.did !== did) {
  throw new Error(`unexpected createSession response ${JSON.stringify(session.data)}`);
}

await checked("com.atproto.server.getSession", () => agent.com.atproto.server.getSession(), (data) => {
  if (data.did !== did || data.handle !== handle) {
    throw new Error(`unexpected getSession response ${JSON.stringify(data)}`);
  }
});

await checked("com.atproto.admin.updateAccountHandle", () =>
  publicAgent.com.atproto.admin.updateAccountHandle(
    {
      did,
      handle: updatedHandle,
    },
    {
      headers: {
        authorization: `Bearer ${config.adminToken}`,
      },
    },
  ),
);
handle = updatedHandle;

await checked("com.atproto.server.getSession", () => agent.com.atproto.server.getSession(), (data) => {
  if (data.did !== did || data.handle !== handle) {
    throw new Error(`unexpected getSession after handle update ${JSON.stringify(data)}`);
  }
});

await checked("com.atproto.server.checkAccountStatus", () =>
  agent.com.atproto.server.checkAccountStatus(),
);

await checked("com.atproto.server.getAccountInviteCodes", () =>
  agent.com.atproto.server.getAccountInviteCodes({ includeUsed: true }),
);

await checked("com.atproto.server.createInviteCodes", () =>
  publicAgent.com.atproto.server.createInviteCodes(
    {
      codeCount: 1,
      useCount: 1,
      forAccounts: [did],
    },
    {
      headers: {
        authorization: `Bearer ${config.adminToken}`,
      },
    },
  ),
  (data) => {
    if (!data.codes.some((entry) => entry.account === did && entry.codes.length === 1)) {
      throw new Error(`unexpected createInviteCodes response ${JSON.stringify(data)}`);
    }
  },
);

await checked("com.atproto.server.getServiceAuth", () =>
  agent.com.atproto.server.getServiceAuth({
    aud: describedServer.data.did,
    lxm: "com.atproto.repo.createRecord",
  }),
  (data) => {
    if (typeof data.token !== "string" || data.token.length === 0) {
      throw new Error(`unexpected getServiceAuth response ${JSON.stringify(data)}`);
    }
  },
);

const appPassword = await checked("com.atproto.server.createAppPassword", () =>
  agent.com.atproto.server.createAppPassword({
    name: appPasswordName,
    privileged: false,
  }),
);
if (appPassword.data.name !== appPasswordName || !appPassword.data.password) {
  throw new Error(`unexpected createAppPassword response ${JSON.stringify(appPassword.data)}`);
}

await checked("com.atproto.server.listAppPasswords", () =>
  agent.com.atproto.server.listAppPasswords(),
  (data) => {
    if (!data.passwords.some((password) => password.name === appPasswordName)) {
      throw new Error(`listAppPasswords missed ${appPasswordName}: ${JSON.stringify(data)}`);
    }
  },
);

await checked("com.atproto.server.revokeAppPassword", () =>
  agent.com.atproto.server.revokeAppPassword({
    name: appPasswordName,
  }),
);

await checked("com.atproto.identity.resolveHandle", () =>
  publicAgent.com.atproto.identity.resolveHandle({
    handle,
  }),
  (data) => {
    if (data.did !== did) {
      throw new Error(`unexpected resolveHandle response ${JSON.stringify(data)}`);
    }
  },
);

await checked("com.atproto.identity.resolveDid", () =>
  publicAgent.com.atproto.identity.resolveDid({
    did,
  }),
  (data) => {
    if (data.didDoc?.id !== did) {
      throw new Error(`unexpected resolveDid response ${JSON.stringify(data)}`);
    }
  },
);

for (const identifier of [handle, did]) {
  await checked(`com.atproto.identity.resolveIdentity(${identifier.startsWith("did:") ? "did" : "handle"})`, () =>
    publicAgent.com.atproto.identity.resolveIdentity({
      identifier,
    }),
    (data) => {
      if (data.did !== did || data.handle !== handle || data.didDoc?.id !== did) {
        throw new Error(`unexpected resolveIdentity response ${JSON.stringify(data)}`);
      }
    },
  );
}

await checked("com.atproto.identity.getRecommendedDidCredentials", () =>
  agent.com.atproto.identity.getRecommendedDidCredentials(),
  (data) => {
    if (data.alsoKnownAs?.[0] !== `at://${handle}` || !data.services?.atproto_pds) {
      throw new Error(`unexpected getRecommendedDidCredentials response ${JSON.stringify(data)}`);
    }
  },
);

await checked("com.atproto.identity.refreshIdentity", () =>
  agent.com.atproto.identity.refreshIdentity({
    identifier: did,
  }),
  (data) => {
    if (data.did !== did || data.handle !== handle) {
      throw new Error(`unexpected refreshIdentity response ${JSON.stringify(data)}`);
    }
  },
);

const uploadedBlob = await checked("com.atproto.repo.uploadBlob", () =>
  agent.com.atproto.repo.uploadBlob(new Blob([blobText], { type: "text/plain" }), {
    encoding: "text/plain",
  }),
);
const blobCid = uploadedBlob.data.blob.ref?.toString();
if (!blobCid || uploadedBlob.data.blob.mimeType !== "text/plain") {
  throw new Error(`unexpected uploadBlob response ${JSON.stringify(uploadedBlob.data)}`);
}

const createdRecord = await checked("com.atproto.repo.createRecord", () =>
  agent.com.atproto.repo.createRecord({
    repo: did,
    collection: config.collection,
    rkey,
    validate: false,
    record: {
      $type: config.collection,
      text: "created through xrpc conformance smoke",
      attachment: uploadedBlob.data.blob,
      createdAt,
    },
  }),
);
expectRecordRef(createdRecord.data, did, config.collection, rkey);

await checked("com.atproto.repo.getRecord", () =>
  publicAgent.com.atproto.repo.getRecord({
    repo: did,
    collection: config.collection,
    rkey,
  }),
  (data) => {
    if (data.uri !== createdRecord.data.uri || data.cid !== createdRecord.data.cid) {
      throw new Error(`unexpected getRecord response ${JSON.stringify(data)}`);
    }
  },
);

await checked("com.atproto.repo.listRecords", () =>
  publicAgent.com.atproto.repo.listRecords({
    repo: did,
    collection: config.collection,
    limit: 50,
  }),
  (data) => {
    if (!data.records.some((record) => record.uri === createdRecord.data.uri && record.cid === createdRecord.data.cid)) {
      throw new Error(`listRecords missed created record ${JSON.stringify(data)}`);
    }
  },
);

const putRecord = await checked("com.atproto.repo.putRecord", () =>
  agent.com.atproto.repo.putRecord({
    repo: did,
    collection: config.collection,
    rkey: putRkey,
    validate: false,
    swapRecord: null,
    record: {
      $type: config.collection,
      text: "created through putRecord",
      createdAt,
    },
  }),
);
expectRecordRef(putRecord.data, did, config.collection, putRkey);

const applyWrites = await checked("com.atproto.repo.applyWrites", () =>
  agent.com.atproto.repo.applyWrites({
    repo: did,
    validate: false,
    writes: [
      {
        $type: "com.atproto.repo.applyWrites#create",
        collection: config.collection,
        rkey: applyCreateRkey,
        value: {
          $type: config.collection,
          text: "created through applyWrites",
          createdAt,
        },
      },
      {
        $type: "com.atproto.repo.applyWrites#create",
        collection: config.collection,
        rkey: applyUpdateRkey,
        value: {
          $type: config.collection,
          text: "created then updated through applyWrites",
          createdAt,
        },
      },
      {
        $type: "com.atproto.repo.applyWrites#update",
        collection: config.collection,
        rkey: applyUpdateRkey,
        value: {
          $type: config.collection,
          text: "updated through applyWrites",
          updatedAt: new Date().toISOString(),
        },
      },
      {
        $type: "com.atproto.repo.applyWrites#delete",
        collection: config.collection,
        rkey: putRkey,
      },
    ],
  }),
);
if (!applyWrites.data.commit?.cid || applyWrites.data.results?.length !== 4) {
  throw new Error(`unexpected applyWrites response ${JSON.stringify(applyWrites.data)}`);
}

await checked("com.atproto.repo.listMissingBlobs", () =>
  agent.com.atproto.repo.listMissingBlobs({
    limit: 50,
  }),
);

const describedRepo = await checked("com.atproto.repo.describeRepo", () =>
  publicAgent.com.atproto.repo.describeRepo({
    repo: did,
  }),
);
if (describedRepo.data.did !== did || describedRepo.data.handle !== handle) {
  throw new Error(`unexpected describeRepo response ${JSON.stringify(describedRepo.data)}`);
}
if (!describedRepo.data.collections.includes(config.collection)) {
  throw new Error(`describeRepo missed ${config.collection}: ${JSON.stringify(describedRepo.data)}`);
}

const repoStatus = await checked("com.atproto.sync.getRepoStatus", () =>
  publicAgent.com.atproto.sync.getRepoStatus({
    did,
  }),
);
if (repoStatus.data.did !== did || repoStatus.data.active !== true || !repoStatus.data.rev) {
  throw new Error(`unexpected getRepoStatus response ${JSON.stringify(repoStatus.data)}`);
}

const latestCommit = await checked("com.atproto.sync.getLatestCommit", () =>
  publicAgent.com.atproto.sync.getLatestCommit({
    did,
  }),
);
if (!latestCommit.data.cid || latestCommit.data.rev !== repoStatus.data.rev) {
  throw new Error(`unexpected getLatestCommit response ${JSON.stringify(latestCommit.data)}`);
}

await checked("com.atproto.sync.getHead", () =>
  publicAgent.com.atproto.sync.getHead({
    did,
  }),
  (data) => {
    if (data.root !== latestCommit.data.cid) {
      throw new Error(`unexpected getHead response ${JSON.stringify(data)}`);
    }
  },
);

await expectBytes(
  "com.atproto.sync.getRecord",
  () =>
    publicAgent.com.atproto.sync.getRecord({
      did,
      collection: config.collection,
      rkey,
    }),
  "sync.getRecord returned an empty CAR",
);

await expectBytes(
  "com.atproto.sync.getRepo",
  () =>
    publicAgent.com.atproto.sync.getRepo({
      did,
    }),
  "sync.getRepo returned an empty CAR",
);

await expectBytes(
  "com.atproto.sync.getCheckout",
  () =>
    publicAgent.com.atproto.sync.getCheckout({
      did,
    }),
  "sync.getCheckout returned an empty CAR",
);

await expectBytes(
  "com.atproto.sync.getBlocks",
  () =>
    publicAgent.com.atproto.sync.getBlocks({
      did,
      cids: [latestCommit.data.cid],
    }),
  "sync.getBlocks returned an empty CAR",
);

const listedBlobs = await checked("com.atproto.sync.listBlobs", () =>
  publicAgent.com.atproto.sync.listBlobs({
    did,
    limit: 50,
  }),
);
if (!listedBlobs.data.cids.includes(blobCid)) {
  throw new Error(`listBlobs missed ${blobCid}: ${JSON.stringify(listedBlobs.data)}`);
}

const fetchedBlob = await expectBytes(
  "com.atproto.sync.getBlob",
  () =>
    publicAgent.com.atproto.sync.getBlob({
      did,
      cid: blobCid,
    }),
  "sync.getBlob returned an empty body",
);
if (new TextDecoder().decode(fetchedBlob) !== blobText) {
  throw new Error("sync.getBlob returned unexpected bytes");
}

await expectListReposContains(did, repoStatus.data.rev);
await expectListReposByCollectionContains(did, config.collection);

await checked("com.atproto.sync.getHostStatus", () =>
  publicAgent.com.atproto.sync.getHostStatus({
    hostname: base.hostname,
  }),
  (data) => {
    if (data.hostname !== base.hostname || data.status !== "active") {
      throw new Error(`unexpected getHostStatus response ${JSON.stringify(data)}`);
    }
  },
);

await checked("com.atproto.sync.listHosts", () =>
  publicAgent.com.atproto.sync.listHosts({
    limit: 10,
  }),
  (data) => {
    if (!data.hosts.some((host) => host.hostname === base.hostname && host.status === "active")) {
      throw new Error(`listHosts missed ${base.hostname}: ${JSON.stringify(data)}`);
    }
  },
);

const deletedRecord = await checked("com.atproto.repo.deleteRecord", () =>
  agent.com.atproto.repo.deleteRecord({
    repo: did,
    collection: config.collection,
    rkey,
    swapRecord: createdRecord.data.cid,
  }),
);
if (!deletedRecord.data.commit?.cid || !deletedRecord.data.commit?.rev) {
  throw new Error(`unexpected deleteRecord response ${JSON.stringify(deletedRecord.data)}`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl: config.baseUrl,
      handle,
      did,
      collection: config.collection,
      record: createdRecord.data.uri,
      latestCommit: latestCommit.data.cid,
      blobCid,
      checkedMethods,
      rawCheckedMethods,
    },
    null,
    2,
  ),
);

async function checked(label, call, validate = undefined) {
  try {
    const response = await call();
    validate?.(response.data, response);
    checkedMethods.push(label);
    return response;
  } catch (error) {
    throw new Error(`${label} failed response conformance: ${error.message}`, {
      cause: error,
    });
  }
}

async function rawChecked(label, call) {
  try {
    const result = await call();
    rawCheckedMethods.push(label);
    return result;
  } catch (error) {
    throw new Error(`${label} failed raw response check: ${error.message}`, {
      cause: error,
    });
  }
}

async function rawJson(path) {
  const response = await fetch(`${config.baseUrl}${path}`);
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`raw JSON endpoint returned non-JSON status=${response.status}: ${text}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new Error(`raw JSON endpoint failed status=${response.status}: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

async function expectBytes(label, call, emptyMessage) {
  const response = await checked(label, call);
  const bytes = await responseBytes(response.data);
  if (bytes.byteLength === 0) {
    throw new Error(emptyMessage);
  }
  return bytes;
}

async function expectListReposContains(expectedDid, expectedRev) {
  let cursor;
  for (let page = 0; page < 10; page += 1) {
    const response = await checked("com.atproto.sync.listRepos", () =>
      publicAgent.com.atproto.sync.listRepos({
        limit: 100,
        cursor,
      }),
    );
    if (response.data.repos.some((repo) => repo.did === expectedDid && repo.rev === expectedRev)) {
      return;
    }
    cursor = response.data.cursor;
    if (!cursor) {
      break;
    }
  }
  throw new Error(`listRepos missed ${expectedDid} after paginating`);
}

async function expectListReposByCollectionContains(expectedDid, collection) {
  let cursor;
  for (let page = 0; page < 10; page += 1) {
    const response = await checked("com.atproto.sync.listReposByCollection", () =>
      publicAgent.com.atproto.sync.listReposByCollection({
        collection,
        limit: 100,
        cursor,
      }),
    );
    if (response.data.repos.some((repo) => repo.did === expectedDid)) {
      return;
    }
    cursor = response.data.cursor;
    if (!cursor) {
      break;
    }
  }
  throw new Error(`listReposByCollection missed ${expectedDid} for ${collection} after paginating`);
}

function expectRecordRef(data, expectedDid, collection, expectedRkey) {
  const expectedUri = `at://${expectedDid}/${collection}/${expectedRkey}`;
  if (data.uri !== expectedUri || !data.cid || !data.commit?.cid || !data.commit?.rev) {
    throw new Error(`unexpected record reference response ${JSON.stringify(data)}, expected uri ${expectedUri}`);
  }
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
