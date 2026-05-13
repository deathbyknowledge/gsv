#!/usr/bin/env node
import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";

const config = {
  baseUrl: requiredEnv("PDS_BASE_URL").replace(/\/+$/, ""),
  adminToken: requiredEnv("PDS_ADMIN_TOKEN"),
  handle: optionalEnv("PDS_ACCOUNT_HANDLE"),
  password: optionalEnv("PDS_ACCOUNT_PASSWORD", "dev-account-password"),
};

const base = new URL(config.baseUrl);
const baseOrigin = base.origin;
const handle = config.handle ?? base.hostname;
const collection = "app.gsv.accountSmoke";
const rkey = `session-${Date.now().toString(36)}`;
const dpopKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const dpopPublicJwk = dpopKey.publicKey.export({ format: "jwk" });

await expectOAuthDiscovery();
const oauthPar = await expectOAuthParEndpoint();

const created = await maybeCreateAccount();
let session = await expectJson("create session", "POST", "/xrpc/com.atproto.server.createSession", {
  identifier: handle,
  password: config.password,
});

if (!session.did?.startsWith("did:") || session.handle !== handle || !session.accessJwt || !session.refreshJwt) {
  throw new Error(`unexpected createSession response ${JSON.stringify(session)}`);
}

await expectJson(
  "put account Lexicon",
  "POST",
  "/xrpc/com.atproto.repo.putRecord",
  {
    repo: session.did,
    collection: "com.atproto.lexicon.schema",
    rkey: collection,
    validate: false,
    record: publishedLexiconRecord(recordLexicon(collection)),
  },
  (body) => {
    if (
      body.uri !== `at://${session.did}/com.atproto.lexicon.schema/${collection}` ||
      !body.cid ||
      !body.commit?.cid
    ) {
      throw new Error(`unexpected put Lexicon response ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${session.accessJwt}` },
);

await expectJson(
  "published account Lexicon record",
  "GET",
  `/xrpc/com.atproto.repo.getRecord?repo=${encodeQuery(session.did)}&collection=com.atproto.lexicon.schema&rkey=${encodeQuery(collection)}`,
  null,
  (body) => {
    if (
      body.uri !== `at://${session.did}/com.atproto.lexicon.schema/${collection}` ||
      body.value?.$type !== "com.atproto.lexicon.schema" ||
      body.value?.id !== collection
    ) {
      throw new Error(`unexpected published Lexicon record ${JSON.stringify(body)}`);
    }
  },
);

await expectJson(
  "get session",
  "GET",
  "/xrpc/com.atproto.server.getSession",
  null,
  (body) => {
    if (body.did !== session.did || body.handle !== handle || body.accessJwt || body.refreshJwt) {
      throw new Error(`unexpected getSession response ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${session.accessJwt}` },
);

await expectJson(
  "check account status",
  "GET",
  "/xrpc/com.atproto.server.checkAccountStatus",
  null,
  (body) => {
    if (
      body.activated !== true ||
      body.validDid !== true ||
      !body.repoCommit ||
      !body.repoRev ||
      typeof body.repoBlocks !== "number" ||
      typeof body.indexedRecords !== "number" ||
      typeof body.expectedBlobs !== "number" ||
      typeof body.importedBlobs !== "number"
    ) {
      throw new Error(`unexpected checkAccountStatus response ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${session.accessJwt}` },
);

await expectJson(
  "recommended DID credentials",
  "GET",
  "/xrpc/com.atproto.identity.getRecommendedDidCredentials",
  null,
  (body) => {
    if (
      body.alsoKnownAs?.[0] !== `at://${handle}` ||
      typeof body.verificationMethods?.atproto !== "string" ||
      body.services?.atproto_pds?.type !== "AtprotoPersonalDataServer" ||
      body.services?.atproto_pds?.endpoint !== baseOrigin
    ) {
      throw new Error(`unexpected recommended DID credentials ${JSON.stringify(body)}`);
    }
    if (body.rotationKeys && !Array.isArray(body.rotationKeys)) {
      throw new Error(`recommended DID credentials returned bad rotationKeys ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${session.accessJwt}` },
);

await expectJson(
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

if (!session.did.startsWith("did:plc:")) {
  await expectStatus(
    "sign PLC operation rejects non-PLC DID",
    "POST",
    "/xrpc/com.atproto.identity.signPlcOperation",
    { token: "unused" },
    400,
    { authorization: `Bearer ${session.accessJwt}` },
  );
}

await expectStatus(
  "update handle no-op",
  "POST",
  "/xrpc/com.atproto.identity.updateHandle",
  { handle },
  200,
  { authorization: `Bearer ${session.accessJwt}` },
);

await expectJson(
  "refresh identity",
  "POST",
  "/xrpc/com.atproto.identity.refreshIdentity",
  { identifier: handle },
  (body) => {
    if (body.did !== session.did || body.handle !== handle || body.didDoc?.id !== session.did) {
      throw new Error(`unexpected refreshIdentity response ${JSON.stringify(body)}`);
    }
  },
);

await expectAccountLifecycle(session);
session = await expectJson("post lifecycle create session", "POST", "/xrpc/com.atproto.server.createSession", {
  identifier: handle,
  password: config.password,
});
await expectAppPasswords(session);

await expectOAuthAuthorize(oauthPar);
const oauthToken = await expectOAuthTokenExchange(oauthPar);
await expectJson(
  "OAuth access token getSession",
  "GET",
  "/xrpc/com.atproto.server.getSession",
  null,
  (body) => {
    if (body.did !== session.did || body.handle !== handle) {
      throw new Error(`unexpected OAuth getSession response ${JSON.stringify(body)}`);
    }
  },
  {
    authorization: `DPoP ${oauthToken.access_token}`,
    dpop: dpopProof("GET", "/xrpc/com.atproto.server.getSession", {
      accessToken: oauthToken.access_token,
      nonce: oauthToken.dpopNonce,
    }),
  },
);
await expectOAuthRefresh(oauthPar.clientId, oauthToken.refresh_token, oauthToken.dpopNonce);

const blobText = `hello from account smoke blob ${rkey}`;
const blobBytes = new TextEncoder().encode(blobText);
const uploadBlob = await expectJson(
  "account uploadBlob",
  "POST",
  "/xrpc/com.atproto.repo.uploadBlob",
  blobBytes,
  (body) => {
    if (body.blob?.mimeType !== "text/plain" || body.blob?.size !== blobBytes.byteLength) {
      throw new Error(`unexpected uploadBlob response ${JSON.stringify(body)}`);
    }
  },
  {
    authorization: `Bearer ${session.accessJwt}`,
    "content-type": "text/plain",
  },
);
const blobCid = uploadBlob.blob.ref?.$link;
if (!blobCid) {
  throw new Error(`uploadBlob response did not include blob ref: ${JSON.stringify(uploadBlob)}`);
}

const createRecord = await expectJson(
  "account createRecord",
  "POST",
  "/xrpc/com.atproto.repo.createRecord",
  {
    repo: session.did,
    collection,
    rkey,
    validate: true,
    record: {
      $type: collection,
      text: "created through account auth",
      createdAt: new Date().toISOString(),
      attachment: blobRef(blobCid, "text/plain", blobBytes.byteLength),
    },
  },
  (body) => {
    if (
      body.uri !== `at://${session.did}/${collection}/${rkey}` ||
      !body.cid ||
      !body.commit?.cid ||
      body.validationStatus !== "valid"
    ) {
      throw new Error(`unexpected createRecord response ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${session.accessJwt}` },
);

await expectJson(
  "list blobs",
  "GET",
  `/xrpc/com.atproto.sync.listBlobs?did=${encodeQuery(session.did)}`,
  null,
  (body) => {
    if (!Array.isArray(body.cids) || !body.cids.includes(blobCid)) {
      throw new Error(`expected blob ${blobCid}, got ${JSON.stringify(body)}`);
    }
  },
);

await expectBytes(
  "get blob",
  "GET",
  `/xrpc/com.atproto.sync.getBlob?did=${encodeQuery(session.did)}&cid=${encodeQuery(blobCid)}`,
  null,
  async (response, bytes) => {
    const contentType = response.headers.get("content-type") ?? "";
    const text = new TextDecoder().decode(bytes);
    if (!contentType.includes("text/plain") || text !== blobText) {
      throw new Error(`unexpected blob response content-type=${contentType} bytes=${text}`);
    }
  },
);

const refreshed = await expectJson(
  "refresh session",
  "POST",
  "/xrpc/com.atproto.server.refreshSession",
  null,
  (body) => {
    if (body.did !== session.did || !body.accessJwt || !body.refreshJwt) {
      throw new Error(`unexpected refreshSession response ${JSON.stringify(body)}`);
    }
  },
  { authorization: `Bearer ${session.refreshJwt}` },
);

await expectStatus(
  "delete session",
  "POST",
  "/xrpc/com.atproto.server.deleteSession",
  null,
  200,
  { authorization: `Bearer ${refreshed.refreshJwt}` },
);

await expectStatus(
  "deleted refresh token",
  "POST",
  "/xrpc/com.atproto.server.refreshSession",
  null,
  401,
  { authorization: `Bearer ${refreshed.refreshJwt}` },
);

console.log(
  JSON.stringify(
    {
      ok: true,
      created,
      baseUrl: config.baseUrl,
      handle,
      did: session.did,
      createdRecord: createRecord.uri,
      latestCommit: createRecord.commit.cid,
      blobCid,
      pdslsRepoUrl: `https://pdsls.dev/at://${session.did}`,
    },
    null,
    2,
  ),
);

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

async function expectAccountLifecycle(session) {
  const email = `pds-smoke+${Date.now().toString(36)}@example.com`;
  const currentEmail = await expectEmailConfirmationAndUpdate(session, email);
  await expectPasswordChangeRoundTrip(session);
  await expectPasswordResetRoundTrip(currentEmail);
  await expectAccountDeleteTokenFlow(session);
  await expectDeactivateActivate(session);
}

async function expectEmailConfirmationAndUpdate(session, email) {
  await expectJson(
    "update email",
    "POST",
    "/xrpc/com.atproto.server.updateEmail",
    { email },
    (body) => {
      if (body.did !== session.did || body.email !== email || body.emailConfirmed !== false) {
        throw new Error(`unexpected updateEmail response ${JSON.stringify(body)}`);
      }
    },
    { authorization: `Bearer ${session.accessJwt}` },
  );

  const confirmation = await expectJson(
    "request email confirmation",
    "POST",
    "/xrpc/com.atproto.server.requestEmailConfirmation",
    null,
    (body) => {
      if (typeof body.token !== "string" || body.token.length < 16) {
        throw new Error(`unexpected requestEmailConfirmation response ${JSON.stringify(body)}`);
      }
    },
    {
      authorization: `Bearer ${session.accessJwt}`,
      "x-pds-admin-token": config.adminToken,
    },
  );

  await expectStatus(
    "confirm email rejects bad token",
    "POST",
    "/xrpc/com.atproto.server.confirmEmail",
    { email, token: "bad-token" },
    400,
  );

  await expectStatus(
    "confirm email",
    "POST",
    "/xrpc/com.atproto.server.confirmEmail",
    { email, token: confirmation.token },
    200,
  );

  await expectJson(
    "confirmed email get session",
    "GET",
    "/xrpc/com.atproto.server.getSession",
    null,
    (body) => {
      if (body.did !== session.did || body.email !== email || body.emailConfirmed !== true) {
        throw new Error(`unexpected confirmed getSession response ${JSON.stringify(body)}`);
      }
    },
    { authorization: `Bearer ${session.accessJwt}` },
  );

  const updateRequest = await expectJson(
    "request email update",
    "POST",
    "/xrpc/com.atproto.server.requestEmailUpdate",
    null,
    (body) => {
      if (body.tokenRequired !== true || typeof body.token !== "string") {
        throw new Error(`unexpected requestEmailUpdate response ${JSON.stringify(body)}`);
      }
    },
    {
      authorization: `Bearer ${session.accessJwt}`,
      "x-pds-admin-token": config.adminToken,
    },
  );

  const nextEmail = `pds-smoke+reset-${Date.now().toString(36)}@example.com`;
  await expectStatus(
    "confirmed email update requires token",
    "POST",
    "/xrpc/com.atproto.server.updateEmail",
    { email: nextEmail },
    400,
    { authorization: `Bearer ${session.accessJwt}` },
  );

  await expectJson(
    "confirmed email update with token",
    "POST",
    "/xrpc/com.atproto.server.updateEmail",
    { email: nextEmail, token: updateRequest.token },
    (body) => {
      if (body.did !== session.did || body.email !== nextEmail || body.emailConfirmed !== false) {
        throw new Error(`unexpected token updateEmail response ${JSON.stringify(body)}`);
      }
    },
    { authorization: `Bearer ${session.accessJwt}` },
  );

  await expectJson(
    "request email update no token required",
    "POST",
    "/xrpc/com.atproto.server.requestEmailUpdate",
    null,
    (body) => {
      if (body.tokenRequired !== false || body.token) {
        throw new Error(`unexpected unconfirmed requestEmailUpdate response ${JSON.stringify(body)}`);
      }
    },
    {
      authorization: `Bearer ${session.accessJwt}`,
      "x-pds-admin-token": config.adminToken,
    },
  );

  return nextEmail;
}

async function expectAppPasswords(session) {
  const name = `app-${Date.now().toString(36)}`;
  const created = await expectJson(
    "create app password",
    "POST",
    "/xrpc/com.atproto.server.createAppPassword",
    { name, privileged: false },
    (body) => {
      if (
        body.name !== name ||
        typeof body.password !== "string" ||
        body.password.length < 16 ||
        typeof body.createdAt !== "string" ||
        body.privileged !== false
      ) {
        throw new Error(`unexpected createAppPassword response ${JSON.stringify(body)}`);
      }
    },
    { authorization: `Bearer ${session.accessJwt}` },
  );

  await expectJson(
    "list app passwords",
    "GET",
    "/xrpc/com.atproto.server.listAppPasswords",
    null,
    (body) => {
      const match = body.passwords?.find((password) => password.name === name);
      if (!match || match.password || match.privileged !== false) {
        throw new Error(`listAppPasswords did not include sanitized app password ${JSON.stringify(body)}`);
      }
    },
    { authorization: `Bearer ${session.accessJwt}` },
  );

  const appSession = await expectJson(
    "create session with app password",
    "POST",
    "/xrpc/com.atproto.server.createSession",
    {
      identifier: handle,
      password: created.password,
    },
    (body) => {
      if (body.did !== session.did || body.handle !== handle || !body.accessJwt || !body.refreshJwt) {
        throw new Error(`unexpected app password createSession response ${JSON.stringify(body)}`);
      }
    },
  );

  await expectStatus(
    "delete app password session",
    "POST",
    "/xrpc/com.atproto.server.deleteSession",
    null,
    200,
    { authorization: `Bearer ${appSession.refreshJwt}` },
  );

  await expectStatus(
    "revoke app password",
    "POST",
    "/xrpc/com.atproto.server.revokeAppPassword",
    { name },
    200,
    { authorization: `Bearer ${session.accessJwt}` },
  );

  await expectStatus(
    "revoked app password rejected",
    "POST",
    "/xrpc/com.atproto.server.createSession",
    {
      identifier: handle,
      password: created.password,
    },
    401,
  );
}

async function expectPasswordChangeRoundTrip(session) {
  const temporaryPassword = `${config.password}-rotated-${Date.now().toString(36)}`;
  let passwordChanged = false;
  try {
    await expectStatus(
      "change password",
      "POST",
      "/xrpc/com.atproto.server.changePassword",
      {
        oldPassword: config.password,
        newPassword: temporaryPassword,
      },
      200,
      { authorization: `Bearer ${session.accessJwt}` },
    );
    passwordChanged = true;

    await expectStatus(
      "old password rejected",
      "POST",
      "/xrpc/com.atproto.server.createSession",
      {
        identifier: handle,
        password: config.password,
      },
      401,
    );

    const temporarySession = await expectJson(
      "temporary password create session",
      "POST",
      "/xrpc/com.atproto.server.createSession",
      {
        identifier: handle,
        password: temporaryPassword,
      },
    );

    await expectStatus(
      "restore password",
      "POST",
      "/xrpc/com.atproto.server.changePassword",
      {
        oldPassword: temporaryPassword,
        newPassword: config.password,
      },
      200,
      { authorization: `Bearer ${temporarySession.accessJwt}` },
    );
    passwordChanged = false;

    await expectJson(
      "restored password create session",
      "POST",
      "/xrpc/com.atproto.server.createSession",
      {
        identifier: handle,
        password: config.password,
      },
    );
  } catch (error) {
    if (passwordChanged) {
      try {
        const temporarySession = await expectJson(
          "temporary password restore session",
          "POST",
          "/xrpc/com.atproto.server.createSession",
          {
            identifier: handle,
            password: temporaryPassword,
          },
        );
        await expectStatus(
          "restore password after failure",
          "POST",
          "/xrpc/com.atproto.server.changePassword",
          {
            oldPassword: temporaryPassword,
            newPassword: config.password,
          },
          200,
          { authorization: `Bearer ${temporarySession.accessJwt}` },
        );
      } catch (restoreError) {
        throw new Error(`password smoke failed and password restore failed: ${restoreError.message}`, {
          cause: error,
        });
      }
    }
    throw error;
  }
}

async function expectPasswordResetRoundTrip(email) {
  const temporaryPassword = `${config.password}-reset-${Date.now().toString(36)}`;
  let resetToTemporary = false;
  try {
    const reset = await expectJson(
      "request password reset",
      "POST",
      "/xrpc/com.atproto.server.requestPasswordReset",
      { email },
      (body) => {
        if (typeof body.token !== "string" || body.token.length < 16) {
          throw new Error(`unexpected requestPasswordReset response ${JSON.stringify(body)}`);
        }
      },
      { "x-pds-admin-token": config.adminToken },
    );

    await expectStatus(
      "reset password rejects bad token",
      "POST",
      "/xrpc/com.atproto.server.resetPassword",
      { token: "bad-token", password: temporaryPassword },
      400,
    );

    await expectStatus(
      "reset password",
      "POST",
      "/xrpc/com.atproto.server.resetPassword",
      { token: reset.token, password: temporaryPassword },
      200,
    );
    resetToTemporary = true;

    await expectStatus(
      "pre-reset password rejected",
      "POST",
      "/xrpc/com.atproto.server.createSession",
      {
        identifier: handle,
        password: config.password,
      },
      401,
    );

    await expectJson(
      "reset password create session",
      "POST",
      "/xrpc/com.atproto.server.createSession",
      {
        identifier: handle,
        password: temporaryPassword,
      },
    );

    await restorePasswordWithReset(email, temporaryPassword, config.password);
    resetToTemporary = false;

    await expectJson(
      "restored reset password create session",
      "POST",
      "/xrpc/com.atproto.server.createSession",
      {
        identifier: handle,
        password: config.password,
      },
    );
  } catch (error) {
    if (resetToTemporary) {
      try {
        await restorePasswordWithReset(email, temporaryPassword, config.password);
      } catch (restoreError) {
        throw new Error(`password reset smoke failed and password restore failed: ${restoreError.message}`, {
          cause: error,
        });
      }
    }
    throw error;
  }
}

async function restorePasswordWithReset(email, fromPassword, toPassword) {
  const reset = await expectJson(
    "request restore password reset",
    "POST",
    "/xrpc/com.atproto.server.requestPasswordReset",
    { email },
    (body) => {
      if (typeof body.token !== "string" || body.token.length < 16) {
        throw new Error(`unexpected restore requestPasswordReset response ${JSON.stringify(body)}`);
      }
    },
    { "x-pds-admin-token": config.adminToken },
  );
  await expectStatus(
    "restore password by reset",
    "POST",
    "/xrpc/com.atproto.server.resetPassword",
    { token: reset.token, password: toPassword },
    200,
  );
  await expectJson(
    "restore password create session",
    "POST",
    "/xrpc/com.atproto.server.createSession",
    {
      identifier: handle,
      password: toPassword,
    },
  );
  await expectStatus(
    "temporary reset password rejected after restore",
    "POST",
    "/xrpc/com.atproto.server.createSession",
    {
      identifier: handle,
      password: fromPassword,
    },
    401,
  );
}

async function expectAccountDeleteTokenFlow(session) {
  const requested = await expectJson(
    "request account delete",
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
    "delete account rejects bad password",
    "POST",
    "/xrpc/com.atproto.server.deleteAccount",
    {
      did: session.did,
      password: "wrong-password",
      token: requested.token,
    },
    401,
    { authorization: `Bearer ${session.accessJwt}` },
  );

  await expectStatus(
    "delete account rejects bad token",
    "POST",
    "/xrpc/com.atproto.server.deleteAccount",
    {
      did: session.did,
      password: config.password,
      token: "bad-token",
    },
    400,
    { authorization: `Bearer ${session.accessJwt}` },
  );
}

async function expectDeactivateActivate(session) {
  let deactivated = false;
  try {
    await expectStatus(
      "deactivate account",
      "POST",
      "/xrpc/com.atproto.server.deactivateAccount",
      null,
      200,
      { authorization: `Bearer ${session.accessJwt}` },
    );
    deactivated = true;

    await expectJson(
      "inactive create session",
      "POST",
      "/xrpc/com.atproto.server.createSession",
      {
        identifier: handle,
        password: config.password,
      },
      (body) => {
        if (body.did !== session.did || body.active !== false || body.status !== "deactivated") {
          throw new Error(`unexpected inactive createSession response ${JSON.stringify(body)}`);
        }
      },
    );

    await expectJson(
      "inactive get session",
      "GET",
      "/xrpc/com.atproto.server.getSession",
      null,
      (body) => {
        if (body.did !== session.did || body.active !== false || body.status !== "deactivated") {
          throw new Error(`unexpected inactive getSession response ${JSON.stringify(body)}`);
        }
      },
      { authorization: `Bearer ${session.accessJwt}` },
    );

    await expectJson(
      "inactive repo status",
      "GET",
      `/xrpc/com.atproto.sync.getRepoStatus?did=${encodeQuery(session.did)}`,
      null,
      (body) => {
        if (body.did !== session.did || body.active !== false || body.status !== "deactivated" || body.rev) {
          throw new Error(`unexpected inactive repo status ${JSON.stringify(body)}`);
        }
      },
    );

    await expectStatus(
      "inactive write rejected",
      "POST",
      "/xrpc/com.atproto.repo.createRecord",
      {
        repo: session.did,
        collection,
        rkey: `inactive-${Date.now().toString(36)}`,
        record: {
          $type: collection,
          text: "this should not commit while inactive",
          createdAt: new Date().toISOString(),
        },
      },
      403,
      { authorization: `Bearer ${session.accessJwt}` },
    );

    await expectJson(
      "activate account",
      "POST",
      "/xrpc/com.atproto.server.activateAccount",
      null,
      (body) => {
        if (body.did !== session.did || body.active !== true) {
          throw new Error(`unexpected activateAccount response ${JSON.stringify(body)}`);
        }
      },
      { authorization: `Bearer ${session.accessJwt}` },
    );
    deactivated = false;

    await expectJson(
      "active create session",
      "POST",
      "/xrpc/com.atproto.server.createSession",
      {
        identifier: handle,
        password: config.password,
      },
    );
  } catch (error) {
    if (deactivated) {
      try {
        await expectJson(
          "activate account after failure",
          "POST",
          "/xrpc/com.atproto.server.activateAccount",
          null,
          undefined,
          { authorization: `Bearer ${session.accessJwt}` },
        );
      } catch (activateError) {
        throw new Error(`account lifecycle smoke failed and reactivation failed: ${activateError.message}`, {
          cause: error,
        });
      }
    }
    throw error;
  }
}

async function expectOAuthDiscovery() {
  await expectJson(
    "OAuth protected resource metadata",
    "GET",
    "/.well-known/oauth-protected-resource",
    null,
    (body) => {
      if (body.resource !== baseOrigin || body.authorization_servers?.[0] !== baseOrigin) {
        throw new Error(`unexpected protected resource metadata ${JSON.stringify(body)}`);
      }
      if (!body.scopes_supported?.includes("atproto")) {
        throw new Error(`protected resource metadata did not advertise atproto scope ${JSON.stringify(body)}`);
      }
    },
  );

  await expectJson(
    "OAuth authorization server metadata",
    "GET",
    "/.well-known/oauth-authorization-server",
    null,
    (body) => {
      if (body.issuer !== baseOrigin) {
        throw new Error(`unexpected OAuth issuer ${JSON.stringify(body)}`);
      }
      if (body.authorization_endpoint !== `${baseOrigin}/oauth/authorize`) {
        throw new Error(`unexpected authorization endpoint ${JSON.stringify(body)}`);
      }
      if (body.token_endpoint !== `${baseOrigin}/oauth/token`) {
        throw new Error(`unexpected token endpoint ${JSON.stringify(body)}`);
      }
      if (body.pushed_authorization_request_endpoint !== `${baseOrigin}/oauth/par`) {
        throw new Error(`unexpected PAR endpoint ${JSON.stringify(body)}`);
      }
      if (
        body.require_pushed_authorization_requests !== true ||
        body.client_id_metadata_document_supported !== true ||
        !body.dpop_signing_alg_values_supported?.includes("ES256") ||
        !body.token_endpoint_auth_methods_supported?.includes("none") ||
        !body.token_endpoint_auth_methods_supported?.includes("private_key_jwt") ||
        !body.token_endpoint_auth_signing_alg_values_supported?.includes("ES256")
      ) {
        throw new Error(`OAuth metadata is missing required atproto capabilities ${JSON.stringify(body)}`);
      }
    },
  );
}

async function expectOAuthParEndpoint() {
  await expectStatus("OAuth PAR preflight", "OPTIONS", "/oauth/par", null, 204);
  const state = `state-${Date.now().toString(36)}`;
  const redirectUri = "http://127.0.0.1/callback";
  const scope = "atproto transition:generic";
  const clientId = `http://localhost?redirect_uri=${encodeQuery(redirectUri)}&scope=${encodeQuery(scope)}`;
  const codeVerifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
  const parBody = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    code_challenge: pkceS256Challenge(codeVerifier),
    code_challenge_method: "S256",
    state,
    redirect_uri: redirectUri,
    scope,
    login_hint: handle,
  }).toString();
  let parDpopNonce;
  const par = await expectJson(
    "OAuth PAR",
    "POST",
    "/oauth/par",
    parBody,
    (body, response) => {
      if (
        typeof body.request_uri !== "string" ||
        !body.request_uri.startsWith("urn:ietf:params:oauth:request_uri:") ||
        body.expires_in !== 300
      ) {
        throw new Error(`unexpected OAuth PAR response ${JSON.stringify(body)}`);
      }
      if (!response.headers.get("dpop-nonce")) {
        throw new Error(`OAuth PAR response did not include DPoP-Nonce header`);
      }
      parDpopNonce = response.headers.get("dpop-nonce");
    },
    {
      "content-type": "application/x-www-form-urlencoded",
      dpop: dpopProof("POST", "/oauth/par"),
    },
  );
  await expectStatus(
    "OAuth duplicate PAR state",
    "POST",
    "/oauth/par",
    parBody,
    400,
    {
      "content-type": "application/x-www-form-urlencoded",
      dpop: dpopProof("POST", "/oauth/par"),
    },
  );
  if (!par.request_uri) {
    throw new Error(`OAuth PAR response did not include request_uri`);
  }
  await expectHtml(
    "OAuth authorize form",
    "GET",
    `/oauth/authorize?client_id=${encodeQuery(clientId)}&request_uri=${encodeQuery(par.request_uri)}`,
    null,
    (text, response) => {
      if (response.status !== 200 || !text.includes("Authorize client") || !text.includes("name=\"password\"")) {
        throw new Error(`unexpected OAuth authorize form status=${response.status}: ${text}`);
      }
    },
  );
  return {
    clientId,
    redirectUri,
    requestUri: par.request_uri,
    state,
    codeVerifier,
    dpopNonce: parDpopNonce,
  };
}

async function expectOAuthAuthorize(par) {
  const formBody = new URLSearchParams({
    client_id: par.clientId,
    request_uri: par.requestUri,
    identifier: handle,
    password: config.password,
    approve: "yes",
  }).toString();
  await expectStatus(
    "OAuth authorize rejects bad password",
    "POST",
    "/oauth/authorize",
    new URLSearchParams({
      client_id: par.clientId,
      request_uri: par.requestUri,
      identifier: handle,
      password: "wrong-password",
      approve: "yes",
    }).toString(),
    401,
    { "content-type": "application/x-www-form-urlencoded" },
  );
  const response = await fetch(
    `${config.baseUrl}/oauth/authorize`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody,
      redirect: "manual",
    },
  );
  const text = await response.text();
  if (response.status !== 302) {
    throw new Error(`OAuth authorize expected redirect, got status=${response.status}: ${text}`);
  }
  const location = response.headers.get("location");
  if (!location) {
    throw new Error(`OAuth authorize redirect did not include Location header`);
  }
  const expectedRedirect = new URL(par.redirectUri);
  const actualRedirect = new URL(location);
  if (actualRedirect.origin !== expectedRedirect.origin || actualRedirect.pathname !== expectedRedirect.pathname) {
    throw new Error(`OAuth authorize redirected to unexpected URI ${location}`);
  }
  if (
    !actualRedirect.searchParams.get("code") ||
    actualRedirect.searchParams.get("state") !== par.state ||
    actualRedirect.searchParams.get("iss") !== baseOrigin
  ) {
    throw new Error(`OAuth authorize redirect had unexpected query ${location}`);
  }
  par.code = actualRedirect.searchParams.get("code");
}

async function expectOAuthTokenExchange(par) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: par.clientId,
    code: par.code,
    redirect_uri: par.redirectUri,
    code_verifier: par.codeVerifier,
  }).toString();
  const token = await expectJson(
    "OAuth token exchange",
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
        throw new Error(`unexpected OAuth token response ${JSON.stringify(body)}`);
      }
      if (!response.headers.get("dpop-nonce")) {
        throw new Error(`OAuth token response did not include DPoP-Nonce header`);
      }
      body.dpopNonce = response.headers.get("dpop-nonce");
    },
    {
      "content-type": "application/x-www-form-urlencoded",
      dpop: dpopProof("POST", "/oauth/token", { nonce: par.dpopNonce }),
    },
  );
  await expectStatus(
    "OAuth authorization code replay",
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

async function expectOAuthRefresh(clientId, refreshToken, dpopNonce) {
  const refreshed = await expectJson(
    "OAuth refresh token",
    "POST",
    "/oauth/token",
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    }).toString(),
    (body, response) => {
      if (!body.access_token || !body.refresh_token || body.token_type !== "DPoP" || body.sub !== session.did) {
        throw new Error(`unexpected OAuth refresh response ${JSON.stringify(body)}`);
      }
      if (!response.headers.get("dpop-nonce")) {
        throw new Error(`OAuth refresh response did not include DPoP-Nonce header`);
      }
      body.dpopNonce = response.headers.get("dpop-nonce");
    },
    {
      "content-type": "application/x-www-form-urlencoded",
      dpop: dpopProof("POST", "/oauth/token", { nonce: dpopNonce }),
    },
  );
  await expectStatus(
    "OAuth refresh token replay",
    "POST",
    "/oauth/token",
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    }).toString(),
    400,
    {
      "content-type": "application/x-www-form-urlencoded",
      dpop: dpopProof("POST", "/oauth/token", { nonce: dpopNonce }),
    },
  );
  return refreshed;
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

async function expectHtml(label, method, path, body, validate = undefined, extraHeaders = {}) {
  const response = await request(method, path, body, extraHeaders);
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    throw new Error(`${label} returned content-type=${contentType} status=${response.status}: ${text}`);
  }
  validate?.(text, response);
  return text;
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

function blobRef(cid, mimeType, size) {
  return {
    $type: "blob",
    ref: { $link: cid },
    mimeType,
    size,
  };
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

function pkceS256Challenge(verifier) {
  return base64Url(createHash("sha256").update(verifier).digest());
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

function base64UrlJson(value) {
  return base64Url(Buffer.from(JSON.stringify(value)));
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
