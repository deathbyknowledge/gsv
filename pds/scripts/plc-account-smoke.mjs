#!/usr/bin/env node

const config = {
  baseUrl: requiredEnv("PDS_BASE_URL").replace(/\/+$/, ""),
  adminToken: requiredEnv("PDS_ADMIN_TOKEN"),
  handle: optionalEnv("PDS_PLC_ACCOUNT_HANDLE"),
  password: optionalEnv("PDS_PLC_ACCOUNT_PASSWORD", "dev-plc-account-password"),
  collection: optionalEnv("PDS_PLC_ACCOUNT_COLLECTION", "app.gsv.plcAccountSmoke"),
};

const base = new URL(config.baseUrl);
const baseOrigin = base.origin;
const stamp = Date.now().toString(36);
const handle = (
  config.handle ?? `plc-${stamp}.${optionalEnv("PDS_PLC_ACCOUNT_HANDLE_SUFFIX", "gsv.dev")}`
).toLowerCase();
const rkey = `plc-${stamp}`;

const created = await expectJson(
  "create PLC account",
  "POST",
  "/xrpc/com.atproto.server.createAccount",
  {
    handle,
    password: config.password,
  },
  (body) => {
    if (!body.did?.startsWith("did:plc:") || body.handle !== handle || !body.accessJwt || !body.refreshJwt) {
      throw new Error(`unexpected createAccount response ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${config.adminToken}` },
);

const session = await expectJson("create PLC session", "POST", "/xrpc/com.atproto.server.createSession", {
  identifier: handle,
  password: config.password,
});

if (session.did !== created.did || session.handle !== handle || !session.accessJwt) {
  throw new Error(`unexpected createSession response ${JSON.stringify(session)}`);
}

await expectJson(
  "resolve PLC DID",
  "GET",
  `/xrpc/com.atproto.identity.resolveDid?did=${encodeQuery(session.did)}`,
  null,
  (body) => {
    if (
      body.didDoc?.id !== session.did ||
      body.didDoc?.alsoKnownAs?.[0] !== `at://${handle}` ||
      body.didDoc?.service?.[0]?.serviceEndpoint !== baseOrigin
    ) {
      throw new Error(`unexpected resolveDid response ${JSON.stringify(body)}`);
    }
  },
);

await expectJson(
  "resolve PLC handle",
  "GET",
  `/xrpc/com.atproto.identity.resolveHandle?handle=${encodeQuery(handle)}`,
  null,
  (body) => {
    if (body.did !== session.did) {
      throw new Error(`unexpected resolveHandle response ${JSON.stringify(body)}`);
    }
  },
);

const recommended = await expectJson(
  "recommended PLC credentials",
  "GET",
  "/xrpc/com.atproto.identity.getRecommendedDidCredentials",
  null,
  (body) => {
    if (
      body.alsoKnownAs?.[0] !== `at://${handle}` ||
      body.services?.atproto_pds?.endpoint !== baseOrigin ||
      !Array.isArray(body.rotationKeys) ||
      body.rotationKeys.length < 1
    ) {
      throw new Error(`unexpected recommended credentials ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${session.accessJwt}` },
);

const signatureRequest = await expectJson(
  "request PLC operation signature",
  "POST",
  "/xrpc/com.atproto.identity.requestPlcOperationSignature",
  null,
  (body) => {
    if (typeof body.token !== "string" || body.token.length < 16) {
      throw new Error(`unexpected requestPlcOperationSignature response ${JSON.stringify(body)}`);
    }
  },
  {
    authorization: `Bearer ${session.accessJwt}`,
    "x-pds-admin-token": config.adminToken,
  },
);

const signedOperation = await expectJson(
  "sign PLC operation",
  "POST",
  "/xrpc/com.atproto.identity.signPlcOperation",
  {
    token: signatureRequest.token,
    rotationKeys: recommended.rotationKeys,
    alsoKnownAs: recommended.alsoKnownAs,
    verificationMethods: recommended.verificationMethods,
    services: recommended.services,
  },
  (body) => {
    if (
      body.operation?.type !== "plc_operation" ||
      typeof body.operation?.prev !== "string" ||
      typeof body.operation?.sig !== "string"
    ) {
      throw new Error(`unexpected signPlcOperation response ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${session.accessJwt}` },
);

await expectStatus(
  "submit PLC operation",
  "POST",
  "/xrpc/com.atproto.identity.submitPlcOperation",
  { operation: signedOperation.operation },
  200,
  { authorization: `Bearer ${session.accessJwt}` },
);

const createRecord = await expectJson(
  "create PLC account record",
  "POST",
  "/xrpc/com.atproto.repo.createRecord",
  {
    repo: session.did,
    collection: config.collection,
    rkey,
    validate: false,
    record: {
      $type: config.collection,
      text: "created through PLC account smoke",
      createdAt: new Date().toISOString(),
    },
  },
  (body) => {
    if (body.uri !== `at://${session.did}/${config.collection}/${rkey}` || !body.cid || !body.commit?.cid) {
      throw new Error(`unexpected createRecord response ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${session.accessJwt}` },
);

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl: config.baseUrl,
      handle,
      did: session.did,
      createdRecord: createRecord.uri,
      latestCommit: createRecord.commit.cid,
      pdslsRepoUrl: `https://pdsls.dev/at://${session.did}`,
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

async function request(method, path, body = null, extraHeaders = {}) {
  const headers = {
    ...extraHeaders,
  };
  let requestBody = body;
  if (body && typeof body !== "string") {
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
