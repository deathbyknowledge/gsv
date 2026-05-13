#!/usr/bin/env node

const config = {
  baseUrl: requiredEnv("PDS_BASE_URL").replace(/\/+$/, ""),
  adminToken: requiredEnv("PDS_ADMIN_TOKEN"),
  authorityDomain: optionalEnv("PDS_LEXICON_AUTHORITY_DOMAIN", "gsv.space"),
  sourceDid: optionalEnv("PDS_LEXICON_SOURCE_DID"),
  sourceHandle: optionalEnv("PDS_LEXICON_SOURCE_HANDLE"),
  sourcePassword: optionalEnv(
    "PDS_LEXICON_SOURCE_PASSWORD",
    optionalEnv("PDS_ACCOUNT_PASSWORD", "dev-account-password"),
  ),
  targetRepo: optionalEnv("PDS_LEXICON_TARGET_REPO", `lexicon-target-${Date.now().toString(36)}`),
  targetHandleSuffix: optionalEnv("PDS_LEXICON_TARGET_HANDLE_SUFFIX", "gsv.dev"),
  targetPassword: optionalEnv("PDS_LEXICON_TARGET_PASSWORD", "lexicon-target-password"),
  collection: optionalEnv("PDS_LEXICON_COLLECTION"),
};

const base = new URL(config.baseUrl);
const sourceHandle = config.sourceHandle ?? base.hostname;
const sourceDid = config.sourceDid ?? `did:web:${sourceHandle}`;
const sourceRepo = repoNameFromDidOrHandle(sourceDid, sourceHandle);
const targetDid = `did:gsv:${config.targetRepo}`;
const targetHandle = `${config.targetRepo}.${config.targetHandleSuffix.replace(/^\.+/, "")}`.toLowerCase();
const collection = config.collection ?? collectionFromAuthorityDomain(config.authorityDomain, "crossRepoSmoke");
const rkey = `cross-${Date.now().toString(36)}`;
const expectedOverride = `${config.authorityDomain}=${sourceDid}`;

await expectJson("health", "GET", "/xrpc/_health", null, (body) => {
  if (body.status !== "ok") {
    throw new Error(`expected health status ok, got ${JSON.stringify(body)}`);
  }
});

const sourceSession = await ensureAccountSession(
  "source",
  sourceHandle,
  sourceDid,
  config.sourcePassword,
);
const targetSession = await ensureAccountSession(
  "target",
  targetHandle,
  targetDid,
  config.targetPassword,
);

const lexicon = recordLexicon(collection);
const published = await expectJson(
  "publish source Lexicon",
  "POST",
  "/xrpc/com.atproto.repo.putRecord",
  {
    repo: sourceDid,
    collection: "com.atproto.lexicon.schema",
    rkey: collection,
    validate: false,
    record: publishedLexiconRecord(lexicon),
  },
  (body) => {
    if (
      body.uri !== `at://${sourceDid}/com.atproto.lexicon.schema/${collection}` ||
      !body.cid ||
      !body.commit?.cid
    ) {
      throw new Error(`unexpected Lexicon publication response ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${sourceSession.accessJwt}` },
);

await expectJson(
  "source Lexicon record",
  "GET",
  `/xrpc/com.atproto.repo.getRecord?repo=${encodeQuery(sourceDid)}&collection=com.atproto.lexicon.schema&rkey=${encodeQuery(collection)}`,
  null,
  (body) => {
    if (
      body.uri !== `at://${sourceDid}/com.atproto.lexicon.schema/${collection}` ||
      body.value?.$type !== "com.atproto.lexicon.schema" ||
      body.value?.id !== collection
    ) {
      throw new Error(`unexpected source Lexicon record ${JSON.stringify(body)}`);
    }
  },
);

const created = await expectJson(
  "target dynamic record",
  "POST",
  "/xrpc/com.atproto.repo.createRecord",
  {
    repo: targetDid,
    collection,
    rkey,
    validate: true,
    record: {
      $type: collection,
      text: "validated from a Lexicon published by another repo",
      createdAt: new Date().toISOString(),
    },
  },
  (body) => {
    if (
      body.uri !== `at://${targetDid}/${collection}/${rkey}` ||
      !body.cid ||
      !body.commit?.cid ||
      body.validationStatus !== "valid"
    ) {
      const message = JSON.stringify(body);
      if (message.includes("Lexicon")) {
        throw new Error(
          `target create failed to resolve ${collection}. Set Worker env PDS_LEXICON_AUTHORITY_DIDS=${expectedOverride}. Response: ${message}`,
        );
      }
      throw new Error(`unexpected target create response ${message}`);
    }
  },
  { authorization: `Bearer ${targetSession.accessJwt}` },
);

await expectJson(
  "target dynamic record read",
  "GET",
  `/xrpc/com.atproto.repo.getRecord?repo=${encodeQuery(targetDid)}&collection=${encodeQuery(collection)}&rkey=${encodeQuery(rkey)}`,
  null,
  (body) => {
    if (body.uri !== `at://${targetDid}/${collection}/${rkey}` || body.value?.$type !== collection) {
      throw new Error(`unexpected target record ${JSON.stringify(body)}`);
    }
  },
);

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl: config.baseUrl,
      authorityDomain: config.authorityDomain,
      expectedWorkerEnv: {
        PDS_LEXICON_AUTHORITY_DIDS: expectedOverride,
      },
      sourceRepo,
      sourceDid,
      sourceHandle,
      targetRepo: config.targetRepo,
      targetDid,
      targetHandle,
      collection,
      publishedLexicon: published.uri,
      targetRecord: `at://${targetDid}/${collection}/${rkey}`,
      latestCommit: created.commit.cid,
    },
    null,
    2,
  ),
);

async function ensureAccountSession(label, handle, did, password) {
  const created = await maybeCreateAccount(label, handle, did, password);
  if (!created) {
    await expectStatus(
      `${label} admin update password`,
      "POST",
      "/xrpc/com.atproto.admin.updateAccountPassword",
      { did, password },
      200,
      { authorization: `Bearer ${config.adminToken}` },
    );
  }
  return expectJson(
    `${label} create session`,
    "POST",
    "/xrpc/com.atproto.server.createSession",
    { identifier: handle, password },
    (body) => {
      if (body.did !== did || body.handle !== handle || !body.accessJwt || !body.refreshJwt) {
        throw new Error(`unexpected ${label} createSession response ${JSON.stringify(body)}`);
      }
    },
  );
}

async function maybeCreateAccount(label, handle, did, password) {
  const body = { handle, password };
  if (!did.startsWith("did:web:")) {
    body.did = did;
  }
  const response = await request(
    "POST",
    "/xrpc/com.atproto.server.createAccount",
    body,
    { authorization: `Bearer ${config.adminToken}` },
  );
  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`${label} createAccount returned non-JSON status=${response.status}: ${text}`, {
      cause: error,
    });
  }
  if (response.ok) {
    if (parsed.did !== did || parsed.handle !== handle || !parsed.accessJwt) {
      throw new Error(`unexpected ${label} createAccount response ${JSON.stringify(parsed)}`);
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
  throw new Error(`${label} createAccount failed status=${response.status}: ${JSON.stringify(parsed)}`);
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

async function expectStatus(label, method, path, body, expectedStatus, extraHeaders = {}) {
  const response = await request(method, path, body, extraHeaders);
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${label} returned status=${response.status}, expected ${expectedStatus}: ${text}`);
  }
}

async function request(method, path, body = null, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  let payload;
  if (body !== null) {
    headers["content-type"] = headers["content-type"] ?? "application/json";
    payload = JSON.stringify(body);
  }
  return fetch(new URL(path, `${config.baseUrl}/`), {
    method,
    headers,
    body: payload,
  });
}

function collectionFromAuthorityDomain(domain, name) {
  const labels = domain.split(".").filter(Boolean);
  if (labels.length < 2) {
    throw new Error(`PDS_LEXICON_AUTHORITY_DOMAIN must have at least two labels, got ${domain}`);
  }
  return `${labels.reverse().join(".")}.${name}`;
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

function encodeQuery(value) {
  return encodeURIComponent(value);
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
