#!/usr/bin/env node

const config = {
  baseUrl: requiredEnv("PDS_BASE_URL").replace(/\/+$/, ""),
  adminToken: requiredEnv("PDS_ADMIN_TOKEN"),
  handleSuffix: optionalEnv("PDS_DELETE_ACCOUNT_HANDLE_SUFFIX", "gsv.dev"),
};

const stamp = Date.now().toString(36);
const id = `delete-${stamp}`;
const handle = `${id}.${config.handleSuffix.replace(/^\.+/, "")}`.toLowerCase();
const did = `did:gsv:${id}`;
const password = `delete-account-password-${stamp}`;
const email = `delete-${stamp}@example.com`;
const invitedId = `invited-${stamp}`;
const invitedHandle = `${invitedId}.${config.handleSuffix.replace(/^\.+/, "")}`.toLowerCase();
const invitedDid = `did:gsv:${invitedId}`;
const invitedPassword = `invited-account-password-${stamp}`;

const created = await expectJson(
  "create disposable account",
  "POST",
  "/xrpc/com.atproto.server.createAccount",
  {
    handle,
    did,
    password,
    email,
  },
  (body) => {
    if (body.did !== did || body.handle !== handle || !body.accessJwt || !body.refreshJwt) {
      throw new Error(`unexpected createAccount response ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${config.adminToken}` },
);

await expectJson(
  "resolve disposable handle",
  "GET",
  `/xrpc/com.atproto.identity.resolveIdentity?identifier=${encodeQuery(handle)}`,
  null,
  (body) => {
    if (body.did !== did || body.handle !== handle || body.didDoc?.id !== did) {
      throw new Error(`unexpected resolveIdentity response ${JSON.stringify(body)}`);
    }
  },
);

await expectJson(
  "disposable repo active",
  "GET",
  `/xrpc/com.atproto.sync.getRepoStatus?did=${encodeQuery(did)}`,
  null,
  (body) => {
    if (body.did !== did || body.active !== true || !body.rev) {
      throw new Error(`unexpected active repo status ${JSON.stringify(body)}`);
    }
  },
);

const session = await expectJson(
  "create disposable session",
  "POST",
  "/xrpc/com.atproto.server.createSession",
  {
    identifier: did,
    password,
  },
  (body) => {
    if (body.did !== did || body.handle !== handle || !body.accessJwt || !body.refreshJwt) {
      throw new Error(`unexpected createSession response ${JSON.stringify(body)}`);
    }
  },
);

const reservedKey = await expectJson(
  "reserve signing key",
  "POST",
  "/xrpc/com.atproto.server.reserveSigningKey",
  { did },
  (body) => {
    if (typeof body.signingKey !== "string" || !body.signingKey.startsWith("did:key:z")) {
      throw new Error(`unexpected reserveSigningKey response ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${config.adminToken}` },
);
const reservedPublicKeyMultibase = reservedKey.signingKey.replace(/^did:key:/, "");

await expectStatus(
  "admin update account signing key",
  "POST",
  "/xrpc/com.atproto.admin.updateAccountSigningKey",
  {
    did,
    signingKey: reservedKey.signingKey,
  },
  200,
  { authorization: `Bearer ${config.adminToken}` },
);

await expectJson(
  "rotated signing key updates identity",
  "GET",
  `/xrpc/com.atproto.identity.resolveIdentity?identifier=${encodeQuery(handle)}`,
  null,
  (body) => {
    const publicKey = body.didDoc?.verificationMethod?.[0]?.publicKeyMultibase;
    if (body.did !== did || publicKey !== reservedPublicKeyMultibase) {
      throw new Error(`unexpected rotated identity response ${JSON.stringify(body)}`);
    }
  },
);

await expectJson(
  "repo write routes by body repo",
  "POST",
  "/xrpc/com.atproto.repo.createRecord",
  {
    repo: did,
    collection: "app.gsv.deleteSmoke",
    record: {
      $type: "app.gsv.deleteSmoke",
      text: `body-routed write smoke ${stamp}`,
    },
  },
  (body) => {
    if (typeof body.uri !== "string" || !body.uri.startsWith(`at://${did}/app.gsv.deleteSmoke/`)) {
      throw new Error(`unexpected body-routed createRecord response ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${created.accessJwt}` },
);

const invite = await expectJson(
  "create invite code",
  "POST",
  "/xrpc/com.atproto.server.createInviteCode",
  {
    useCount: 2,
    forAccount: did,
  },
  (body) => {
    if (typeof body.code !== "string" || !body.code.startsWith("gsv-")) {
      throw new Error(`unexpected createInviteCode response ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${config.adminToken}` },
);

await expectJson(
  "create invited account",
  "POST",
  "/xrpc/com.atproto.server.createAccount",
  {
    handle: invitedHandle,
    did: invitedDid,
    password: invitedPassword,
    email: `invited-${stamp}@example.com`,
    inviteCode: invite.code,
  },
  (body) => {
    if (body.did !== invitedDid || body.handle !== invitedHandle || !body.accessJwt) {
      throw new Error(`unexpected invited createAccount response ${JSON.stringify(body)}`);
    }
  },
);

await expectJson(
  "get service auth",
  "GET",
  `/xrpc/com.atproto.server.getServiceAuth?aud=${encodeQuery("did:web:service.example.com")}&lxm=${encodeQuery("com.atproto.repo.getRecord")}`,
  null,
  (body) => {
    const payload = decodeJwtPayload(body.token);
    if (
      payload.iss !== did ||
      payload.aud !== "did:web:service.example.com" ||
      payload.lxm !== "com.atproto.repo.getRecord"
    ) {
      throw new Error(`unexpected service auth payload ${JSON.stringify(payload)}`);
    }
  },
  { authorization: `Bearer ${session.accessJwt}` },
);

await expectJson(
  "get account invite codes",
  "GET",
  "/xrpc/com.atproto.server.getAccountInviteCodes?includeUsed=true",
  null,
  (body) => {
    const code = body.codes?.find((code) => code.code === invite.code);
    if (!code || code.available !== 1 || code.uses?.[0]?.usedBy !== invitedDid) {
      throw new Error(`unexpected getAccountInviteCodes response ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${session.accessJwt}` },
);

await expectJson(
  "admin get account info",
  "GET",
  `/xrpc/com.atproto.admin.getAccountInfo?did=${encodeQuery(did)}`,
  null,
  (body) => {
    const code = body.invites?.find((code) => code.code === invite.code);
    if (body.did !== did || body.handle !== handle || !code || code.uses?.[0]?.usedBy !== invitedDid) {
      throw new Error(`unexpected admin getAccountInfo response ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${config.adminToken}` },
);

await expectJson(
  "admin get account infos",
  "GET",
  `/xrpc/com.atproto.admin.getAccountInfos?dids=${encodeQuery(did)}`,
  null,
  (body) => {
    if (!Array.isArray(body.infos) || body.infos[0]?.did !== did) {
      throw new Error(`unexpected admin getAccountInfos response ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${config.adminToken}` },
);

await expectJson(
  "admin search accounts",
  "GET",
  `/xrpc/com.atproto.admin.searchAccounts?email=${encodeQuery(email)}&limit=5`,
  null,
  (body) => {
    if (!Array.isArray(body.accounts) || !body.accounts.some((account) => account.did === did)) {
      throw new Error(`unexpected admin searchAccounts response ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${config.adminToken}` },
);

await expectJson(
  "admin get invite codes",
  "GET",
  "/xrpc/com.atproto.admin.getInviteCodes?limit=20",
  null,
  (body) => {
    if (!Array.isArray(body.codes) || !body.codes.some((code) => code.code === invite.code)) {
      throw new Error(`unexpected admin getInviteCodes response ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${config.adminToken}` },
);

await expectJson(
  "admin get subject status",
  "GET",
  `/xrpc/com.atproto.admin.getSubjectStatus?did=${encodeQuery(did)}`,
  null,
  (body) => {
    if (body.subject?.did !== did || body.takedown?.applied !== false) {
      throw new Error(`unexpected admin getSubjectStatus response ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${config.adminToken}` },
);

await expectStatus(
  "admin disable account invites",
  "POST",
  "/xrpc/com.atproto.admin.disableAccountInvites",
  { account: did, note: "smoke" },
  200,
  { authorization: `Bearer ${config.adminToken}` },
);

await expectJson(
  "admin account invites disabled",
  "GET",
  `/xrpc/com.atproto.admin.getAccountInfo?did=${encodeQuery(did)}`,
  null,
  (body) => {
    if (body.invitesDisabled !== true || body.inviteNote !== "smoke") {
      throw new Error(`unexpected disabled invites account response ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${config.adminToken}` },
);

await expectStatus(
  "admin enable account invites",
  "POST",
  "/xrpc/com.atproto.admin.enableAccountInvites",
  { account: did },
  200,
  { authorization: `Bearer ${config.adminToken}` },
);

await expectStatus(
  "admin disable invite codes",
  "POST",
  "/xrpc/com.atproto.admin.disableInviteCodes",
  { codes: [invite.code] },
  200,
  { authorization: `Bearer ${config.adminToken}` },
);

await expectStatus(
  "disabled invite code rejects account creation",
  "POST",
  "/xrpc/com.atproto.server.createAccount",
  {
    handle: `rejected-${stamp}.${config.handleSuffix.replace(/^\.+/, "")}`.toLowerCase(),
    did: `did:gsv:rejected-${stamp}`,
    password: `rejected-account-password-${stamp}`,
    inviteCode: invite.code,
  },
  400,
);

await expectJson(
  "admin send email",
  "POST",
  "/xrpc/com.atproto.admin.sendEmail",
  {
    recipientDid: did,
    senderDid: did,
    content: "smoke",
    subject: "Smoke",
    comment: "delete-account-smoke",
  },
  (body) => {
    if (body.sent !== false) {
      throw new Error(`unexpected admin sendEmail response ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${config.adminToken}` },
);

const updatedEmail = `delete-updated-${stamp}@example.com`;
await expectStatus(
  "admin update account email",
  "POST",
  "/xrpc/com.atproto.admin.updateAccountEmail",
  { account: did, email: updatedEmail },
  200,
  { authorization: `Bearer ${config.adminToken}` },
);

await expectStatus(
  "admin deactivate subject",
  "POST",
  "/xrpc/com.atproto.admin.updateSubjectStatus",
  {
    subject: { $type: "com.atproto.admin.defs#repoRef", did },
    deactivated: { applied: true },
  },
  200,
  { authorization: `Bearer ${config.adminToken}` },
);

await expectStatus(
  "admin reactivate subject",
  "POST",
  "/xrpc/com.atproto.admin.updateSubjectStatus",
  {
    subject: { $type: "com.atproto.admin.defs#repoRef", did },
    deactivated: { applied: false },
  },
  200,
  { authorization: `Bearer ${config.adminToken}` },
);

await expectStatus(
  "admin delete invited account",
  "POST",
  "/xrpc/com.atproto.admin.deleteAccount",
  { did: invitedDid },
  200,
  { authorization: `Bearer ${config.adminToken}` },
);

const deletion = await expectJson(
  "request disposable account delete",
  "POST",
  "/xrpc/com.atproto.server.requestAccountDelete",
  null,
  (body) => {
    if (typeof body.token !== "string" || body.token.length < 16) {
      throw new Error(`unexpected requestAccountDelete response ${JSON.stringify(body)}`);
    }
  },
  {
    authorization: `Bearer ${session.accessJwt}`,
    "x-pds-admin-token": config.adminToken,
  },
);

await expectStatus(
  "delete disposable account rejects wrong token",
  "POST",
  "/xrpc/com.atproto.server.deleteAccount",
  {
    did,
    password,
    token: "wrong-token",
  },
  400,
  { authorization: `Bearer ${session.accessJwt}` },
);

await expectStatus(
  "delete disposable account",
  "POST",
  "/xrpc/com.atproto.server.deleteAccount",
  {
    did,
    password,
    token: deletion.token,
  },
  200,
  { authorization: `Bearer ${session.accessJwt}` },
);

await expectStatus(
  "deleted disposable account rejects login",
  "POST",
  "/xrpc/com.atproto.server.createSession",
  {
    identifier: did,
    password,
  },
  403,
);

await expectStatus(
  "deleted disposable account rejects getSession",
  "GET",
  "/xrpc/com.atproto.server.getSession",
  null,
  403,
  { authorization: `Bearer ${session.accessJwt}` },
);

await expectStatus(
  "deleted disposable account rejects refresh",
  "POST",
  "/xrpc/com.atproto.server.refreshSession",
  null,
  401,
  { authorization: `Bearer ${session.refreshJwt}` },
);

await expectStatus(
  "deleted disposable account rejects reactivation",
  "POST",
  "/xrpc/com.atproto.server.activateAccount",
  null,
  403,
  { authorization: `Bearer ${created.accessJwt}` },
);

await expectJson(
  "disposable repo deleted status",
  "GET",
  `/xrpc/com.atproto.sync.getRepoStatus?did=${encodeQuery(did)}`,
  null,
  (body) => {
    if (body.did !== did || body.active !== false || body.status !== "deleted" || body.rev) {
      throw new Error(`unexpected deleted repo status ${JSON.stringify(body)}`);
    }
  },
);

await expectStatus(
  "deleted disposable identity not resolvable",
  "GET",
  `/xrpc/com.atproto.identity.resolveIdentity?identifier=${encodeQuery(handle)}`,
  null,
  404,
);

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl: config.baseUrl,
      handle,
      did,
      invitedDid,
      reservedSigningKey: reservedKey.signingKey,
      inviteCode: invite.code,
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

function encodeQuery(value) {
  return encodeURIComponent(value);
}

function decodeJwtPayload(token) {
  if (typeof token !== "string") {
    throw new Error(`JWT must be a string, got ${typeof token}`);
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error(`JWT must have three parts, got ${parts.length}`);
  }
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}
