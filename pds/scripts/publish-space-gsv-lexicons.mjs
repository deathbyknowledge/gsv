#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LEXICON_IDS = [
  "space.gsv.profile",
  "space.gsv.instance",
  "space.gsv.user",
  "space.gsv.contact",
  "space.gsv.package",
  "space.gsv.package.release",
  "space.gsv.vouch",
  "space.gsv.news",
];

const config = {
  baseUrl: requiredEnv("PDS_BASE_URL").replace(/\/+$/, ""),
  adminToken: requiredEnv("PDS_ADMIN_TOKEN"),
  authorityDid: optionalEnv("PDS_SPACE_GSV_AUTHORITY_DID"),
  authorityHandle: optionalEnv("PDS_SPACE_GSV_AUTHORITY_HANDLE"),
  authorityPassword: optionalEnv(
    "PDS_SPACE_GSV_AUTHORITY_PASSWORD",
    optionalEnv("PDS_ACCOUNT_PASSWORD", "dev-account-password"),
  ),
  targetRepo: optionalEnv("PDS_SPACE_GSV_TARGET_REPO", `space-gsv-smoke-${Date.now().toString(36)}`),
  targetHandleSuffix: optionalEnv("PDS_SPACE_GSV_TARGET_HANDLE_SUFFIX", "gsv.dev"),
  targetPassword: optionalEnv("PDS_SPACE_GSV_TARGET_PASSWORD", "space-gsv-smoke-password"),
};

const base = new URL(config.baseUrl);
const authorityHandle = config.authorityHandle ?? base.hostname;
const authorityDid = config.authorityDid ?? `did:web:${authorityHandle}`;
const targetDid = `did:gsv:${config.targetRepo}`;
const targetHandle = `${config.targetRepo}.${config.targetHandleSuffix.replace(/^\.+/, "")}`.toLowerCase();
const authorityDomains = [...new Set(LEXICON_IDS.map(lexiconAuthorityDomain))];
const expectedOverride = authorityDomains.map((domain) => `${domain}=${authorityDid}`).join(",");
const stamp = Date.now().toString(36);

await expectJson("health", "GET", "/xrpc/_health", null, (body) => {
  if (body.status !== "ok") {
    throw new Error(`expected health status ok, got ${JSON.stringify(body)}`);
  }
});

const authoritySession = await ensureAccountSession(
  "authority",
  authorityHandle,
  authorityDid,
  config.authorityPassword,
);
const targetSession = await ensureAccountSession(
  "target",
  targetHandle,
  targetDid,
  config.targetPassword,
);

const lexicons = await readLexicons();
const publishedLexicons = [];
for (const lexicon of lexicons) {
  const published = await expectJson(
    `publish ${lexicon.id}`,
    "POST",
    "/xrpc/com.atproto.repo.putRecord",
    {
      repo: authorityDid,
      collection: "com.atproto.lexicon.schema",
      rkey: lexicon.id,
      validate: false,
      record: publishedLexiconRecord(lexicon),
    },
    (body) => {
      if (
        body.uri !== `at://${authorityDid}/com.atproto.lexicon.schema/${lexicon.id}` ||
        !body.cid ||
        !body.commit?.cid
      ) {
        throw new Error(`unexpected ${lexicon.id} publication response ${JSON.stringify(body)}`);
      }
    },
    { authorization: `Bearer ${authoritySession.accessJwt}` },
  );
  publishedLexicons.push({
    id: lexicon.id,
    uri: published.uri,
    cid: published.cid,
  });
}

const resolvedLexicons = [];
for (const id of LEXICON_IDS) {
  const resolved = await expectJson(
    `resolve ${id}`,
    "GET",
    `/xrpc/com.atproto.lexicon.resolveLexicon?nsid=${encodeQuery(id)}`,
    null,
    (body) => {
      if (
        body.schema?.$type !== "com.atproto.lexicon.schema" ||
        body.schema?.id !== id ||
        !body.cid ||
        !body.uri
      ) {
        throw new Error(
          `unexpected resolveLexicon response for ${id}. Expected Worker env PDS_LEXICON_AUTHORITY_DIDS=${expectedOverride}. Response: ${JSON.stringify(body)}`,
        );
      }
    },
  );
  resolvedLexicons.push({
    id,
    uri: resolved.uri,
    cid: resolved.cid,
  });
}

const avatarBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const uploadedAvatar = await expectJson(
  "upload profile avatar blob",
  "POST",
  "/xrpc/com.atproto.repo.uploadBlob",
  avatarBytes,
  (body) => {
    if (
      body.blob?.$type !== "blob" ||
      body.blob?.mimeType !== "image/png" ||
      body.blob?.size !== avatarBytes.byteLength ||
      typeof body.blob?.ref?.$link !== "string"
    ) {
      throw new Error(`unexpected uploadBlob response ${JSON.stringify(body)}`);
    }
  },
  {
    authorization: `Bearer ${targetSession.accessJwt}`,
    "content-type": "image/png",
  },
);

const records = sampleRecords(uploadedAvatar.blob);
const strictRecords = [];
for (const record of records) {
  const body = {
    repo: targetDid,
    collection: record.collection,
    validate: true,
    record: record.value,
  };
  if (record.rkey) {
    body.rkey = record.rkey;
  }
  const created = await expectJson(
    `strict ${record.collection}`,
    "POST",
    `/xrpc/com.atproto.repo.${record.mode === "create" ? "createRecord" : "putRecord"}`,
    body,
    (responseBody) => {
      if (
        !responseBody.uri?.startsWith(`at://${targetDid}/${record.collection}/`) ||
        !responseBody.cid ||
        !responseBody.commit?.cid ||
        responseBody.validationStatus !== "valid"
      ) {
        throw new Error(`unexpected strict write response ${JSON.stringify(responseBody)}`);
      }
    },
    { authorization: `Bearer ${targetSession.accessJwt}` },
  );
  strictRecords.push({
    collection: record.collection,
    uri: created.uri,
    cid: created.cid,
    commit: created.commit.cid,
  });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl: config.baseUrl,
      authority: {
        did: authorityDid,
        handle: authorityHandle,
        domains: authorityDomains,
      },
      expectedWorkerEnv: {
        PDS_LEXICON_AUTHORITY_DIDS: expectedOverride,
      },
      publishedLexicons,
      resolvedLexicons,
      target: {
        did: targetDid,
        handle: targetHandle,
      },
      strictRecords,
      avatarBlobCid: uploadedAvatar.blob.ref.$link,
    },
    null,
    2,
  ),
);

async function readLexicons() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const lexicons = [];
  for (const id of LEXICON_IDS) {
    const path = join(root, "lexicons", `${id}.json`);
    const lexicon = JSON.parse(await readFile(path, "utf8"));
    if (lexicon.$type !== undefined) {
      throw new Error(`${path} must not include $type; the publish script adds it`);
    }
    if (lexicon.id !== id) {
      throw new Error(`${path} id mismatch: expected ${id}, got ${lexicon.id}`);
    }
    lexicons.push(lexicon);
  }
  return lexicons;
}

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

function sampleRecords(avatarBlob) {
  const now = new Date().toISOString();
  const packageUri = `at://${targetDid}/space.gsv.package/notes`;

  return [
    {
      mode: "put",
      collection: "space.gsv.profile",
      rkey: "self",
      value: {
        $type: "space.gsv.profile",
        createdAt: now,
        displayName: "Space GSV Smoke",
        description: "Strictly validated profile smoke record.",
        avatar: avatarBlob,
        avatarAlt: "small test image",
        links: [{ label: "GSV", uri: "https://gsv.space" }],
      },
    },
    {
      mode: "put",
      collection: "space.gsv.instance",
      rkey: "self",
      value: {
        $type: "space.gsv.instance",
        createdAt: now,
        endpoint: "https://gsv.space/social",
        protocolVersion: 1,
        serviceKey: {
          id: `${targetDid}#service-key`,
          type: "Multikey",
          publicKeyMultibase: "z6MkiGSVSocialSmokeKey",
        },
        acceptedSocialMethods: [
          "social.profile.read",
          "social.user.read",
          "social.contact.read",
          "social.package.read",
          "social.package.release.read",
          "social.vouch.read",
          "social.news.read",
          "social.message.send",
          "social.message.status.update",
        ],
      },
    },
    {
      mode: "put",
      collection: "space.gsv.user",
      rkey: "alice",
      value: {
        $type: "space.gsv.user",
        createdAt: now,
        username: "alice",
        displayName: "Alice",
        description: "Example GSV resident.",
        publicHandle: "alice.example.com",
        acceptsContact: true,
      },
    },
    {
      mode: "create",
      collection: "space.gsv.contact",
      value: {
        $type: "space.gsv.contact",
        createdAt: now,
        subject: {
          did: authorityDid,
          handle: authorityHandle,
          uri: `at://${authorityDid}/space.gsv.profile/self`,
        },
        label: "Space GSV authority",
        tags: ["authority", "smoke"],
      },
    },
    {
      mode: "put",
      collection: "space.gsv.package",
      rkey: "notes",
      value: {
        $type: "space.gsv.package",
        createdAt: now,
        name: "notes",
        displayName: "Notes",
        description: "Strictly validated package smoke record.",
        source: {
          repo: "theagentscompany/gsv",
          ref: "main",
          subdir: "builtin-packages/notes",
          uri: "https://github.com/theagentscompany/gsv/tree/main/builtin-packages/notes",
        },
        homepage: "https://gsv.space/packages/notes",
        tags: ["notes", "smoke"],
      },
    },
    {
      mode: "create",
      collection: "space.gsv.package.release",
      value: {
        $type: "space.gsv.package.release",
        createdAt: now,
        package: {
          uri: packageUri,
        },
        version: "1.0.0-smoke",
        title: "Smoke release",
        description: "Strictly validated package release smoke record.",
        source: {
          repo: "theagentscompany/gsv",
          ref: "main",
          subdir: "builtin-packages/notes",
        },
        releasedAt: now,
        tags: ["release", "smoke"],
      },
    },
    {
      mode: "create",
      collection: "space.gsv.vouch",
      value: {
        $type: "space.gsv.vouch",
        createdAt: now,
        subject: {
          uri: packageUri,
        },
        note: "Useful package.",
        tags: ["trusted", "smoke"],
      },
    },
    {
      mode: "create",
      collection: "space.gsv.news",
      value: {
        $type: "space.gsv.news",
        createdAt: now,
        title: "Space GSV lexicons published",
        text: `Publishing space.gsv Lexicons ${stamp}`,
        startsAt: now,
        endsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        tags: ["space-gsv", "lexicon"],
        subjects: [
          {
            uri: packageUri,
          },
        ],
      },
    },
  ];
}

function publishedLexiconRecord(lexicon) {
  return {
    ...lexicon,
    $type: "com.atproto.lexicon.schema",
  };
}

function lexiconAuthorityDomain(nsid) {
  const labels = nsid.split(".").filter(Boolean);
  if (labels.length < 3) {
    throw new Error(`invalid NSID ${nsid}`);
  }
  return labels.slice(0, -1).reverse().join(".");
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
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    payload = body;
  } else if (body !== null) {
    headers["content-type"] = headers["content-type"] ?? "application/json";
    payload = JSON.stringify(body);
  }
  return fetch(new URL(path, `${config.baseUrl}/`), {
    method,
    headers,
    body: payload,
  });
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
