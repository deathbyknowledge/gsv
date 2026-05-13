#!/usr/bin/env node
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
} from "node:crypto";
import { readFileSync } from "node:fs";

const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const CODE_VERIFIER = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";

const config = {
  baseUrl: requiredEnv("PDS_BASE_URL").replace(/\/+$/, ""),
  adminToken: requiredEnv("PDS_ADMIN_TOKEN"),
  handle: optionalEnv("PDS_ACCOUNT_HANDLE"),
  password: optionalEnv("PDS_ACCOUNT_PASSWORD", "dev-account-password"),
  clientId: requiredEnv("OAUTH_CONFIDENTIAL_CLIENT_ID"),
  privateJwk: readJsonEnv("OAUTH_CONFIDENTIAL_CLIENT_PRIVATE_KEY_JWK"),
  keyId: optionalEnv("OAUTH_CONFIDENTIAL_CLIENT_KEY_ID"),
  redirectUri: optionalEnv("OAUTH_CONFIDENTIAL_REDIRECT_URI"),
  scope: optionalEnv("OAUTH_CONFIDENTIAL_SCOPE"),
};

const base = new URL(config.baseUrl);
const baseOrigin = base.origin;
const handle = config.handle ?? base.hostname;
const dpopKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const dpopPublicJwk = dpopKey.publicKey.export({ format: "jwk" });
const clientPrivateKey = createPrivateKey({ key: config.privateJwk, format: "jwk" });
const clientKeyId = config.keyId ?? config.privateJwk.kid ?? jwkThumbprint(config.privateJwk);

const metadata = await fetchJsonUrl("confidential client metadata", config.clientId);
const redirectUri = config.redirectUri ?? firstMetadataRedirectUri(metadata);
const scope = config.scope ?? defaultScope(metadata);
await validateClientMetadata(metadata, redirectUri, scope);

const created = await maybeCreateAccount();
const session = await expectJson("create session", "POST", "/xrpc/com.atproto.server.createSession", {
  identifier: handle,
  password: config.password,
});
if (!session.did?.startsWith("did:") || session.handle !== handle) {
  throw new Error(`unexpected createSession response ${JSON.stringify(session)}`);
}

await expectOAuthDiscovery();
const par = await expectConfidentialPar();
await expectConfidentialAuthorize(par);
const token = await expectConfidentialTokenExchange(par);
await expectJson(
  "confidential OAuth access token getSession",
  "GET",
  "/xrpc/com.atproto.server.getSession",
  null,
  (body) => {
    if (body.did !== session.did || body.handle !== handle) {
      throw new Error(`unexpected OAuth getSession response ${JSON.stringify(body)}`);
    }
  },
  {
    authorization: `DPoP ${token.access_token}`,
    dpop: dpopProof("GET", "/xrpc/com.atproto.server.getSession", {
      accessToken: token.access_token,
      nonce: token.dpopNonce,
    }),
  },
);
await expectConfidentialRefresh(token.refresh_token, token.dpopNonce);

console.log(
  JSON.stringify(
    {
      ok: true,
      created,
      baseUrl: config.baseUrl,
      handle,
      did: session.did,
      clientId: config.clientId,
      keyId: clientKeyId,
      redirectUri,
      scope,
    },
    null,
    2,
  ),
);

async function expectOAuthDiscovery() {
  await expectJson(
    "OAuth authorization server metadata",
    "GET",
    "/.well-known/oauth-authorization-server",
    null,
    (body) => {
      if (body.issuer !== baseOrigin || body.token_endpoint !== `${baseOrigin}/oauth/token`) {
        throw new Error(`unexpected OAuth metadata ${JSON.stringify(body)}`);
      }
      if (
        !body.token_endpoint_auth_methods_supported?.includes("private_key_jwt") ||
        !body.token_endpoint_auth_signing_alg_values_supported?.includes("ES256")
      ) {
        throw new Error(`OAuth metadata does not advertise private_key_jwt ES256 ${JSON.stringify(body)}`);
      }
    },
  );
}

async function expectConfidentialPar() {
  const state = `conf-state-${Date.now().toString(36)}`;
  const parParams = {
    client_id: config.clientId,
    response_type: "code",
    code_challenge: pkceS256Challenge(CODE_VERIFIER),
    code_challenge_method: "S256",
    state,
    redirect_uri: redirectUri,
    scope,
    login_hint: handle,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion(),
  };
  let parDpopNonce;
  const par = await expectJson(
    "confidential OAuth PAR",
    "POST",
    "/oauth/par",
    new URLSearchParams(parParams).toString(),
    (body, response) => {
      if (
        typeof body.request_uri !== "string" ||
        !body.request_uri.startsWith("urn:ietf:params:oauth:request_uri:") ||
        body.expires_in !== 300
      ) {
        throw new Error(`unexpected confidential OAuth PAR response ${JSON.stringify(body)}`);
      }
      parDpopNonce = response.headers.get("dpop-nonce");
      if (!parDpopNonce) {
        throw new Error("confidential OAuth PAR did not include DPoP-Nonce header");
      }
    },
    {
      "content-type": "application/x-www-form-urlencoded",
      dpop: dpopProof("POST", "/oauth/par"),
    },
  );

  await expectStatus(
    "confidential OAuth client assertion replay",
    "POST",
    "/oauth/par",
    new URLSearchParams({
      ...parParams,
      state: `${state}-replay`,
      client_assertion: parParams.client_assertion,
    }).toString(),
    401,
    {
      "content-type": "application/x-www-form-urlencoded",
      dpop: dpopProof("POST", "/oauth/par"),
    },
  );

  return {
    requestUri: par.request_uri,
    state,
    dpopNonce: parDpopNonce,
  };
}

async function expectConfidentialAuthorize(par) {
  const response = await fetch(`${config.baseUrl}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      request_uri: par.requestUri,
      identifier: handle,
      password: config.password,
      approve: "yes",
    }).toString(),
    redirect: "manual",
  });
  const text = await response.text();
  if (response.status !== 302) {
    throw new Error(`confidential OAuth authorize expected redirect, got status=${response.status}: ${text}`);
  }
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("confidential OAuth authorize redirect did not include Location header");
  }
  const actualRedirect = new URL(location);
  const expectedRedirect = new URL(redirectUri);
  if (actualRedirect.origin !== expectedRedirect.origin || actualRedirect.pathname !== expectedRedirect.pathname) {
    throw new Error(`confidential OAuth authorize redirected to unexpected URI ${location}`);
  }
  if (actualRedirect.searchParams.get("state") !== par.state || actualRedirect.searchParams.get("iss") !== baseOrigin) {
    throw new Error(`confidential OAuth authorize redirect had unexpected query ${location}`);
  }
  par.code = actualRedirect.searchParams.get("code");
  if (!par.code) {
    throw new Error(`confidential OAuth authorize redirect did not include code ${location}`);
  }
}

async function expectConfidentialTokenExchange(par) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code: par.code,
    redirect_uri: redirectUri,
    code_verifier: CODE_VERIFIER,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion(),
  }).toString();
  const token = await expectJson(
    "confidential OAuth token exchange",
    "POST",
    "/oauth/token",
    body,
    (body, response) => {
      if (
        !body.access_token ||
        !body.refresh_token ||
        body.token_type !== "DPoP" ||
        body.expires_in !== 900 ||
        body.sub !== session.did ||
        !String(body.scope ?? "").split(/\s+/).includes("atproto")
      ) {
        throw new Error(`unexpected confidential OAuth token response ${JSON.stringify(body)}`);
      }
      body.dpopNonce = response.headers.get("dpop-nonce");
      if (!body.dpopNonce) {
        throw new Error("confidential OAuth token response did not include DPoP-Nonce header");
      }
    },
    {
      "content-type": "application/x-www-form-urlencoded",
      dpop: dpopProof("POST", "/oauth/token", { nonce: par.dpopNonce }),
    },
  );
  await expectStatus(
    "confidential OAuth authorization code replay",
    "POST",
    "/oauth/token",
    body,
    400,
    {
      "content-type": "application/x-www-form-urlencoded",
      dpop: dpopProof("POST", "/oauth/token", { nonce: par.dpopNonce }),
    },
  );
  return token;
}

async function expectConfidentialRefresh(refreshToken, dpopNonce) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
    refresh_token: refreshToken,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion(),
  }).toString();
  const refreshed = await expectJson(
    "confidential OAuth refresh token",
    "POST",
    "/oauth/token",
    body,
    (body, response) => {
      if (!body.access_token || !body.refresh_token || body.token_type !== "DPoP" || body.sub !== session.did) {
        throw new Error(`unexpected confidential OAuth refresh response ${JSON.stringify(body)}`);
      }
      if (!response.headers.get("dpop-nonce")) {
        throw new Error("confidential OAuth refresh response did not include DPoP-Nonce header");
      }
    },
    {
      "content-type": "application/x-www-form-urlencoded",
      dpop: dpopProof("POST", "/oauth/token", { nonce: dpopNonce }),
    },
  );
  await expectStatus(
    "confidential OAuth refresh token replay",
    "POST",
    "/oauth/token",
    body,
    400,
    {
      "content-type": "application/x-www-form-urlencoded",
      dpop: dpopProof("POST", "/oauth/token", { nonce: dpopNonce }),
    },
  );
  return refreshed;
}

async function maybeCreateAccount() {
  const response = await request(
    "POST",
    "/xrpc/com.atproto.server.createAccount",
    {
      handle,
      password: config.password,
    },
    { authorization: `Bearer ${config.adminToken}` },
  );
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`createAccount returned non-JSON status=${response.status}: ${text}`);
  }
  if (response.ok) {
    return true;
  }
  if (response.status === 400 && String(body.error ?? "").includes("HandleNotAvailable")) {
    return false;
  }
  if (response.status === 409 && String(body.error ?? "").includes("repo already initialized")) {
    return false;
  }
  throw new Error(`createAccount failed status=${response.status}: ${JSON.stringify(body)}`);
}

async function validateClientMetadata(metadata, requestedRedirectUri, requestedScope) {
  if (metadata.client_id !== config.clientId) {
    throw new Error(`client metadata client_id mismatch: ${JSON.stringify(metadata)}`);
  }
  if (metadata.token_endpoint_auth_method !== "private_key_jwt") {
    throw new Error(`client metadata must use private_key_jwt: ${JSON.stringify(metadata)}`);
  }
  if (!metadata.dpop_bound_access_tokens) {
    throw new Error(`client metadata must require DPoP-bound access tokens: ${JSON.stringify(metadata)}`);
  }
  if (!metadata.redirect_uris?.includes(requestedRedirectUri)) {
    throw new Error(`client metadata does not declare redirect URI ${requestedRedirectUri}`);
  }
  const declaredScope = String(metadata.scope ?? "");
  const declared = new Set(declaredScope.split(/\s+/).filter(Boolean));
  for (const requested of requestedScope.split(/\s+/).filter(Boolean)) {
    if (!declared.has(requested)) {
      throw new Error(`client metadata scope ${declaredScope} does not declare requested scope ${requestedScope}`);
    }
  }
  const jwks = metadata.jwks ?? (metadata.jwks_uri ? await fetchJsonUrl("confidential client JWKS", metadata.jwks_uri) : undefined);
  if (!jwks?.keys?.some((key) => key.kid === clientKeyId)) {
    throw new Error(`client metadata JWKS does not include key id ${clientKeyId}`);
  }
}

function firstMetadataRedirectUri(metadata) {
  const uri = metadata.redirect_uris?.[0];
  if (typeof uri !== "string" || uri.length === 0) {
    throw new Error(`client metadata must include redirect_uris, or set OAUTH_CONFIDENTIAL_REDIRECT_URI`);
  }
  return uri;
}

function defaultScope(metadata) {
  const scopes = String(metadata.scope ?? "").split(/\s+/).filter(Boolean);
  if (scopes.includes("atproto") && scopes.includes("transition:generic")) {
    return "atproto transition:generic";
  }
  if (scopes.includes("atproto")) {
    return "atproto";
  }
  throw new Error(`client metadata must declare an atproto scope, or set OAUTH_CONFIDENTIAL_SCOPE`);
}

async function fetchJsonUrl(label, url) {
  const response = await fetch(url);
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
  return parsed;
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

function clientAssertion() {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "ES256",
    typ: "JWT",
    kid: clientKeyId,
  };
  const payload = {
    iss: config.clientId,
    sub: config.clientId,
    aud: baseOrigin,
    exp: now + 300,
    iat: now,
    jti: randomUUID(),
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = cryptoSign("sha256", Buffer.from(signingInput), {
    key: clientPrivateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64Url(signature)}`;
}

function dpopProof(method, path, { accessToken = undefined, nonce = undefined } = {}) {
  const htu = `${baseOrigin}${new URL(path, baseOrigin).pathname}`;
  const header = {
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: {
      kty: dpopPublicJwk.kty,
      crv: dpopPublicJwk.crv,
      x: dpopPublicJwk.x,
      y: dpopPublicJwk.y,
    },
  };
  const payload = {
    jti: randomUUID(),
    htm: method,
    htu,
    iat: Math.floor(Date.now() / 1000),
  };
  if (nonce) {
    payload.nonce = nonce;
  }
  if (accessToken) {
    payload.ath = base64Url(createHash("sha256").update(accessToken).digest());
  }
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = cryptoSign("sha256", Buffer.from(signingInput), {
    key: dpopKey.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64Url(signature)}`;
}

function pkceS256Challenge(verifier) {
  return base64Url(createHash("sha256").update(verifier).digest());
}

function jwkThumbprint(jwk) {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error("private JWK must be a P-256 EC key with public x/y coordinates");
  }
  return base64Url(
    createHash("sha256")
      .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
      .digest(),
  );
}

function base64UrlJson(value) {
  return base64Url(Buffer.from(JSON.stringify(value)));
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function readJsonEnv(name) {
  const value = requiredEnv(name);
  const jsonText = value.startsWith("@") ? readFileSync(value.slice(1), "utf8") : value;
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`${name} must be JSON or @path-to-json`, { cause: error });
  }
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
