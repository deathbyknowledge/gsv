#!/usr/bin/env node
import { Agent } from "@atproto/api";
import { NodeOAuthClient, requestLocalLock } from "@atproto/oauth-client-node";

const config = {
  baseUrl: requiredEnv("PDS_BASE_URL").replace(/\/+$/, ""),
  adminToken: requiredEnv("PDS_ADMIN_TOKEN"),
  handleSuffix: optionalEnv("PDS_OAUTH_CLIENT_HANDLE_SUFFIX", "gsv.dev"),
  password: optionalEnv("PDS_OAUTH_CLIENT_PASSWORD", "dev-oauth-client-password"),
  collection: optionalEnv("PDS_OAUTH_CLIENT_COLLECTION", "app.gsv.oauthClientSmoke"),
  redirectUri: optionalEnv("PDS_OAUTH_CLIENT_REDIRECT_URI", "http://127.0.0.1/callback"),
  scope: optionalEnv("PDS_OAUTH_CLIENT_SCOPE", "atproto transition:generic"),
};

const stamp = Date.now().toString(36);
const handle = `oauth-client-${stamp}.${config.handleSuffix}`.toLowerCase();
const rkey = `oauth-client-${stamp}`;
const recordPath = `${config.collection}/${rkey}`;
const createdAt = new Date().toISOString();
const appState = `oauth-client-state-${stamp}`;
const clientId = localhostClientId(config.redirectUri, config.scope);
const stateStore = memoryStore();
const sessionStore = memoryStore();

const oauthClient = new NodeOAuthClient({
  clientMetadata: {
    client_id: clientId,
    client_name: "GSV PDS official OAuth smoke",
    redirect_uris: [config.redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: config.scope,
    application_type: "native",
    token_endpoint_auth_method: "none",
    dpop_bound_access_tokens: true,
  },
  stateStore,
  sessionStore,
  requestLock: requestLocalLock,
});

const createdAccount = await expectJson(
  "create OAuth official client account",
  "POST",
  "/xrpc/com.atproto.server.createAccount",
  {
    handle,
    password: config.password,
  },
  (body) => {
    if (!body.did?.startsWith("did:") || body.handle !== handle) {
      throw new Error(`unexpected createAccount response ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${config.adminToken}` },
);

const authorizeUrl = await oauthClient.authorize(config.baseUrl, {
  state: appState,
  scope: config.scope,
  redirect_uri: config.redirectUri,
});
if (authorizeUrl.origin !== new URL(config.baseUrl).origin || !authorizeUrl.searchParams.get("request_uri")) {
  throw new Error(`unexpected OAuth authorize URL ${authorizeUrl}`);
}

const callbackUrl = await submitAuthorization(authorizeUrl);
const callback = await oauthClient.callback(callbackUrl.searchParams, {
  redirect_uri: config.redirectUri,
});
if (callback.state !== appState || callback.session.did !== createdAccount.did) {
  throw new Error(`unexpected OAuth callback result state=${callback.state} did=${callback.session.did}`);
}
if ((await sessionStore.get(callback.session.did)) == null) {
  throw new Error("OAuth callback did not persist a session");
}

const tokenInfo = await callback.session.getTokenInfo(false);
if (
  tokenInfo.sub !== createdAccount.did ||
  tokenInfo.iss !== new URL(config.baseUrl).origin ||
  !String(tokenInfo.scope ?? "").split(/\s+/).includes("atproto")
) {
  throw new Error(`unexpected OAuth token info ${JSON.stringify(tokenInfo)}`);
}

const agent = new Agent(callback.session);
const oauthSession = await agent.com.atproto.server.getSession();
if (oauthSession.data.did !== createdAccount.did || oauthSession.data.handle !== handle) {
  throw new Error(`unexpected OAuth getSession response ${JSON.stringify(oauthSession.data)}`);
}

const createdRecord = await agent.com.atproto.repo.createRecord({
  repo: createdAccount.did,
  collection: config.collection,
  rkey,
  validate: false,
  record: {
    $type: config.collection,
    text: "created through @atproto/oauth-client-node",
    createdAt,
  },
});
if (
  createdRecord.data.uri !== `at://${createdAccount.did}/${recordPath}` ||
  !createdRecord.data.cid ||
  !createdRecord.data.commit?.cid
) {
  throw new Error(`unexpected OAuth createRecord response ${JSON.stringify(createdRecord.data)}`);
}

const restoredSession = await oauthClient.restore(createdAccount.did, true);
const refreshedInfo = await restoredSession.getTokenInfo(false);
if (refreshedInfo.sub !== createdAccount.did || !String(refreshedInfo.scope ?? "").split(/\s+/).includes("atproto")) {
  throw new Error(`unexpected restored OAuth token info ${JSON.stringify(refreshedInfo)}`);
}

const refreshedAgent = new Agent(restoredSession);
const fetchedRecord = await refreshedAgent.com.atproto.repo.getRecord({
  repo: createdAccount.did,
  collection: config.collection,
  rkey,
});
if (fetchedRecord.data.uri !== createdRecord.data.uri || fetchedRecord.data.cid !== createdRecord.data.cid) {
  throw new Error(`unexpected OAuth getRecord response ${JSON.stringify(fetchedRecord.data)}`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl: config.baseUrl,
      handle,
      did: createdAccount.did,
      clientId,
      redirectUri: config.redirectUri,
      scope: config.scope,
      record: createdRecord.data.uri,
      latestCommit: createdRecord.data.commit.cid,
      sessionStoreEntries: sessionStore.size,
    },
    null,
    2,
  ),
);

async function submitAuthorization(authorizeUrl) {
  const response = await fetch(authorizeUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: authorizeUrl.searchParams.get("client_id") ?? "",
      request_uri: authorizeUrl.searchParams.get("request_uri") ?? "",
      identifier: handle,
      password: config.password,
      approve: "yes",
    }).toString(),
    redirect: "manual",
  });
  const text = await response.text();
  if (response.status !== 302) {
    throw new Error(`OAuth authorize submit expected redirect, got status=${response.status}: ${text}`);
  }
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("OAuth authorize submit did not include Location header");
  }
  const url = new URL(location);
  const expected = new URL(config.redirectUri);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    throw new Error(`OAuth authorize redirected to unexpected URI ${location}`);
  }
  if (!url.searchParams.get("code") || !url.searchParams.get("state")) {
    throw new Error(`OAuth authorize redirect missing code/state ${location}`);
  }
  return url;
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

function localhostClientId(redirectUri, scope) {
  const url = new URL("http://localhost");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  return url.toString();
}

function memoryStore() {
  const values = new Map();
  return {
    get size() {
      return values.size;
    },
    async get(key) {
      return values.get(key);
    },
    async set(key, value) {
      values.set(key, value);
    },
    async del(key) {
      values.delete(key);
    },
    async clear() {
      values.clear();
    },
  };
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
