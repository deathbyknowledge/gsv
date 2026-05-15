#!/usr/bin/env node

const BASE_PUBLIC_COLLECTIONS = [
  "space.gsv.profile",
  "space.gsv.instance",
];

const CURRENT_GRANTS = [
  { operation: "social.message.send" },
  { operation: "social.message.status.update" },
];

const DENIED_SENDER_GRANTS = CURRENT_GRANTS.filter((grant) => grant.operation !== "social.message.send");

const peers = [
  readPeer("A"),
  readPeer("B"),
];

if (typeof WebSocket === "undefined") {
  throw new Error("This smoke script requires a Node.js runtime with global WebSocket support");
}

const ensureIdentity = process.env.GSV_SOCIAL_ENSURE !== "0";
const republishIdentity = process.env.GSV_SOCIAL_REPUBLISH !== "0";
const results = [];

for (const peer of peers) {
  const state = await withConnection(peer, async (ws) => {
    const identity = await getOrSetupIdentity(peer, ws);
    const publishedIdentity = republishIdentity
      ? (await rpc(ws, "social.identity.republish", {})).identity
      : identity;
    const publicState = await readPublicState(peer.origin);
    assertCurrentInstance(publicState.instance.value, `${peer.label} public instance`);
    const publicRecords = await createSmokePublicRecords(peer, ws, publicState.did);
    return {
      label: peer.label,
      origin: peer.origin,
      did: publicState.did,
      handle: publishedIdentity.handle,
      profile: publicState.profile.value,
      instance: publicState.instance.value,
      vouch: publicRecords.vouch,
      news: publicRecords.news,
    };
  });
  if (!state.handle) {
    throw new Error(`${peer.label} has no social handle`);
  }
  results.push(state);
}

for (const peer of peers) {
  const current = requireResult(peer.label);
  const other = requireOtherResult(peer.label);
  await withConnection(peer, async (ws) => {
    await addContactWithCurrentGrants(ws, current, other);
  });
}

for (const peer of peers) {
  const other = requireOtherResult(peer.label);
  await withConnection(peer, async (ws) => {
    const vouches = await rpc(ws, "social.vouch.list", {
      handle: other.handle,
      limit: 200,
    });
    if (!Array.isArray(vouches?.vouches) || !vouches.vouches.some((vouch) => vouch.uri === other.vouch.uri)) {
      throw new Error(`${peer.label} could not read ${other.label}'s vouch record`);
    }
    const news = await rpc(ws, "social.news.list", {
      handle: other.handle,
      limit: 200,
    });
    if (!Array.isArray(news?.news) || !news.news.some((entry) => entry.uri === other.news.uri)) {
      throw new Error(`${peer.label} could not read ${other.label}'s news record`);
    }
  });
}

const senderPeer = peers[0];
const receiverPeer = peers[1];
const sender = requireResult(senderPeer.label);
const receiver = requireResult(receiverPeer.label);

const initialText = `Local social smoke from ${sender.label} to ${receiver.label}`;
const replyText = `Local social smoke reply from ${receiver.label} to ${sender.label}`;

const socialMessage = await withConnection(senderPeer, async (ws) => {
  const sent = await rpc(ws, "social.message.send", {
    toHandle: receiver.handle,
    text: initialText,
    body: {
      kind: "smoke-message",
      role: "initial",
      sender: sender.handle,
      receiver: receiver.handle,
    },
  });
  assertDeliveryStatus(sent?.message, "accepted", `${sender.label} initial message`);
  return sent;
});

const receiverThreadAfterInitial = await withConnection(receiverPeer, async (ws) =>
  rpc(ws, "social.thread.get", { threadId: socialMessage.thread.threadId })
);
const receiverInbound = requireMessage(
  receiverThreadAfterInitial,
  (message) =>
    message.messageId === socialMessage.message.messageId &&
    message.direction === "inbound" &&
    message.fromHandle === sender.handle &&
    message.toHandle === receiver.handle &&
    message.text === initialText,
  `${receiver.label} inbound initial message`,
);
const receiverInitialStatus = requireStatus(
  receiverThreadAfterInitial,
  socialMessage.message.messageId,
  "received",
  `${receiver.label} initial message status`,
);

const receiverStatusUpdate = await withConnection(receiverPeer, async (ws) =>
  rpc(ws, "social.message.status.update", {
    messageId: receiverInbound.messageId,
    state: "in_progress",
    summary: `${receiver.label} is handling the smoke message`,
    body: {
      kind: "smoke-status",
      handledBy: receiver.handle,
    },
  })
);
if (receiverStatusUpdate?.status?.state !== "in_progress") {
  throw new Error(`${receiver.label} status update was ${receiverStatusUpdate?.status?.state ?? "missing"}`);
}

const replyMessage = await withConnection(receiverPeer, async (ws) => {
  const sent = await rpc(ws, "social.message.send", {
    toHandle: sender.handle,
    threadId: socialMessage.thread.threadId,
    text: replyText,
    body: {
      kind: "smoke-message",
      role: "reply",
      sender: receiver.handle,
      receiver: sender.handle,
      originalMessageId: socialMessage.message.messageId,
    },
  });
  assertDeliveryStatus(sent?.message, "accepted", `${receiver.label} reply message`);
  return sent;
});

const senderThreadAfterReply = await withConnection(senderPeer, async (ws) =>
  rpc(ws, "social.thread.get", { threadId: socialMessage.thread.threadId })
);
requireMessage(
  senderThreadAfterReply,
  (message) =>
    message.messageId === socialMessage.message.messageId &&
    message.direction === "outbound" &&
    message.toHandle === receiver.handle &&
    message.text === initialText,
  `${sender.label} outbound initial message`,
);
const senderObservedInitialStatus = requireStatus(
  senderThreadAfterReply,
  socialMessage.message.messageId,
  "in_progress",
  `${sender.label} observed initial message status`,
);
requireMessage(
  senderThreadAfterReply,
  (message) =>
    message.messageId === replyMessage.message.messageId &&
    message.direction === "inbound" &&
    message.fromHandle === receiver.handle &&
    message.toHandle === sender.handle &&
    message.text === replyText,
  `${sender.label} inbound reply message`,
);
const senderReplyStatus = requireStatus(
  senderThreadAfterReply,
  replyMessage.message.messageId,
  "received",
  `${sender.label} reply message status`,
);

const deniedText = `Denied social smoke probe from ${receiver.label} to ${sender.label}`;
let deniedProbe;
let deniedProbeError;
let restoreError;

await withConnection(senderPeer, async (ws) => {
  await setContactGrants(ws, receiver.handle, DENIED_SENDER_GRANTS);
});

try {
  deniedProbe = await withConnection(receiverPeer, async (ws) =>
    rpc(ws, "social.message.send", {
      toHandle: sender.handle,
      threadId: socialMessage.thread.threadId,
      text: deniedText,
      body: {
        kind: "smoke-denied-sender",
        sender: receiver.handle,
        receiver: sender.handle,
      },
    })
  );
  assertDeliveryStatus(deniedProbe?.message, "failed", `${receiver.label} denied-sender probe`);

  const senderThreadAfterDeniedProbe = await withConnection(senderPeer, async (ws) =>
    rpc(ws, "social.thread.get", { threadId: socialMessage.thread.threadId })
  );
  const deniedWasStored = Array.isArray(senderThreadAfterDeniedProbe?.messages) &&
    senderThreadAfterDeniedProbe.messages.some((message) =>
      message.direction === "inbound" &&
      message.fromHandle === receiver.handle &&
      message.text === deniedText
    );
  if (deniedWasStored) {
    throw new Error(`${sender.label} stored a message from a sender without social.message.send grant`);
  }
} catch (error) {
  deniedProbeError = error;
} finally {
  try {
    await withConnection(senderPeer, async (ws) => {
      await setContactGrants(ws, receiver.handle, CURRENT_GRANTS);
    });
  } catch (error) {
    restoreError = error;
  }
}

if (deniedProbeError) {
  throw deniedProbeError;
}
if (restoreError) {
  throw restoreError;
}

console.log(JSON.stringify({
  ok: true,
  ensured: ensureIdentity,
  republished: republishIdentity,
  publicRecords: results.map((peer) => ({
    label: peer.label,
    handle: peer.handle,
    vouchUri: peer.vouch.uri,
    newsUri: peer.news.uri,
  })),
  thread: {
    threadId: socialMessage.thread.threadId,
    initialMessageId: socialMessage.message.messageId,
    initialDeliveryStatus: socialMessage.message.deliveryStatus,
    receiverInitialStatus: receiverInitialStatus.state,
    receiverStatusUpdate: receiverStatusUpdate.status.state,
    senderObservedInitialStatus: senderObservedInitialStatus.state,
    replyMessageId: replyMessage.message.messageId,
    replyDeliveryStatus: replyMessage.message.deliveryStatus,
    senderReplyStatus: senderReplyStatus.state,
    deniedProbeDeliveryStatus: deniedProbe.message.deliveryStatus,
  },
  peers: results.map((peer) => ({
    label: peer.label,
    origin: peer.origin,
    did: peer.did,
    handle: peer.handle,
    endpoint: peer.instance.endpoint,
    acceptedSocialMethods: peer.instance.acceptedSocialMethods,
    pdslsRepoUrl: `https://pdsls.dev/at://${peer.did}`,
  })),
}, null, 2));

function readPeer(label) {
  const prefix = `GSV_${label}_`;
  const origin = normalizeOrigin(requiredEnv(`${prefix}ORIGIN`));
  return {
    label,
    origin,
    wsUrl: process.env[`${prefix}WS_URL`]?.trim() || wsUrlFromOrigin(origin),
    username: requiredEnv(`${prefix}USERNAME`),
    password: requiredEnv(`${prefix}PASSWORD`),
  };
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function normalizeOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && !isLocalDevHttpOrigin(url)) {
    throw new Error(`${url.origin} must be HTTPS or a local dev HTTP origin.`);
  }
  return url.origin;
}

function isLocalDevHttpOrigin(url) {
  return url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
    /^\d+$/.test(url.port);
}

function wsUrlFromOrigin(origin) {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function withConnection(peer, callback) {
  const ws = await connect(peer);
  try {
    return await callback(ws);
  } finally {
    ws.close(1000, "smoke complete");
  }
}

async function connect(peer) {
  const ws = await openWebSocket(peer.wsUrl);
  await rpc(ws, "sys.connect", {
    protocol: 1,
    client: {
      id: `gsv-social-local-smoke-${peer.label.toLowerCase()}`,
      version: "0.1.5",
      platform: "node",
      role: "user",
    },
    auth: {
      username: peer.username,
      password: peer.password,
    },
  });
  return ws;
}

function openWebSocket(url) {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`WebSocket connect timed out: ${url}`));
    }, 10_000);
    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve(ws);
    };
    const onError = () => {
      cleanup();
      reject(new Error(`WebSocket connection failed: ${url}`));
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`WebSocket closed during connect: ${url}`));
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
  });
}

function rpc(ws, call, args) {
  const id = crypto.randomUUID();
  ws.send(JSON.stringify({ type: "req", id, call, args }));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Request timed out: ${call}`));
    }, 30_000);
    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onError);
    };
    const onMessage = async (event) => {
      const text = await messageDataToText(event.data);
      const frame = JSON.parse(text);
      if (frame.type !== "res" || frame.id !== id) return;
      cleanup();
      if (frame.ok) {
        resolve(frame.data);
      } else {
        const message = frame.error?.message ?? `Request failed: ${call}`;
        const error = new Error(message);
        error.code = frame.error?.code;
        error.details = frame.error?.details;
        reject(error);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`Connection closed during request: ${call}`));
    };
    const onError = () => {
      cleanup();
      reject(new Error(`WebSocket error during request: ${call}`));
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onError);
  });
}

async function messageDataToText(data) {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  if (data && typeof data.text === "function") {
    return await data.text();
  }
  return String(data);
}

async function getOrSetupIdentity(peer, ws) {
  const current = await rpc(ws, "social.identity.get", {});
  if (current?.identity) {
    return current.identity;
  }
  if (!ensureIdentity) {
    throw new Error(`${peer.label} has no social identity. Re-run without GSV_SOCIAL_ENSURE=0 or run onboarding with social setup.`);
  }
  const setup = await rpc(ws, "social.setup", {
    origin: peer.origin,
    displayName: peer.username,
    acceptsContact: true,
  });
  return setup.identity;
}

async function readPublicState(origin) {
  const did = (await fetchText(`${origin}/.well-known/atproto-did`)).trim();

  const didDoc = await fetchJson(`${origin}/.well-known/did.json`);
  if (didDoc.id !== did) {
    throw new Error(`${origin}/.well-known/did.json returned id ${didDoc.id}, expected ${did}`);
  }

  const [profile, instance] = await Promise.all(
    BASE_PUBLIC_COLLECTIONS.map((collection) => getRecord(origin, did, collection)),
  );
  assertRecordType(profile.value, "space.gsv.profile", `${origin} profile`);
  assertRecordType(instance.value, "space.gsv.instance", `${origin} instance`);
  return { did, profile, instance };
}

async function getRecord(origin, did, collection) {
  const url = new URL("/xrpc/com.atproto.repo.getRecord", origin);
  url.searchParams.set("repo", did);
  url.searchParams.set("collection", collection);
  url.searchParams.set("rkey", "self");
  return fetchJson(url.toString());
}

async function fetchJson(url) {
  const response = await fetch(url);
  const body = await response.text();
  let parsed;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    throw new Error(`${url} returned non-JSON status=${response.status}: ${body.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new Error(`${url} failed status=${response.status}: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

async function fetchText(url) {
  const response = await fetch(url);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${url} failed status=${response.status}: ${body}`);
  }
  return body;
}

function assertRecordType(record, type, label) {
  if (!record || typeof record !== "object" || record.$type !== type) {
    throw new Error(`${label} returned invalid record type`);
  }
}

function assertCurrentInstance(instance, label) {
  const methods = new Set(Array.isArray(instance?.acceptedSocialMethods) ? instance.acceptedSocialMethods : []);
  for (const grant of CURRENT_GRANTS) {
    if (!methods.has(grant.operation)) {
      throw new Error(`${label} does not advertise ${grant.operation}`);
    }
  }
}

async function createSmokePublicRecords(peer, ws, did) {
  const subjectUri = `at://${did}/space.gsv.profile/self`;
  const vouch = await rpc(ws, "social.vouch.create", {
    record: {
      $type: "space.gsv.vouch",
      createdAt: new Date().toISOString(),
      subject: { uri: subjectUri },
      note: `Smoke vouch from ${peer.label}`,
    },
  });
  if (!vouch?.uri) {
    throw new Error(`${peer.label} vouch create did not return a URI`);
  }
  const vouches = await rpc(ws, "social.vouch.list", { limit: 200 });
  if (!Array.isArray(vouches?.vouches) || !vouches.vouches.some((entry) => entry.uri === vouch.uri)) {
    throw new Error(`${peer.label} local vouch list did not include ${vouch.uri}`);
  }

  const news = await rpc(ws, "social.news.create", {
    record: {
      $type: "space.gsv.news",
      createdAt: new Date().toISOString(),
      title: `Smoke ${peer.label}`,
      text: `Social local smoke news from ${peer.label}`,
      subjects: [{ uri: subjectUri }],
    },
  });
  if (!news?.uri) {
    throw new Error(`${peer.label} news create did not return a URI`);
  }
  const newsList = await rpc(ws, "social.news.list", { limit: 200 });
  if (!Array.isArray(newsList?.news) || !newsList.news.some((entry) => entry.uri === news.uri)) {
    throw new Error(`${peer.label} local news list did not include ${news.uri}`);
  }

  return { vouch: { uri: vouch.uri }, news: { uri: news.uri } };
}

async function addContactWithCurrentGrants(ws, current, other) {
  const added = await rpc(ws, "social.contact.add", {
    handle: other.handle,
    note: `${other.label} local social smoke peer`,
    grants: CURRENT_GRANTS,
  });
  if (added?.contact?.handle !== other.handle) {
    throw new Error(`${current.label} added unexpected contact handle`);
  }
  assertGrantSet(added.contact.grants, CURRENT_GRANTS, `${current.label} grants for ${other.handle}`);

  const listed = await rpc(ws, "social.contact.list", {});
  const contact = Array.isArray(listed?.contacts)
    ? listed.contacts.find((candidate) => candidate.handle === other.handle)
    : null;
  if (!contact) {
    throw new Error(`${current.label} contact list does not include ${other.handle}`);
  }
  assertCurrentInstance({ acceptedSocialMethods: contact.acceptedSocialMethods }, `${current.label} cached ${other.label} instance`);
  assertGrantSet(contact.grants, CURRENT_GRANTS, `${current.label} listed grants for ${other.handle}`);
}

async function setContactGrants(ws, handle, grants) {
  const updated = await rpc(ws, "social.contact.grants.set", {
    handle,
    grants,
  });
  assertGrantSet(updated?.contact?.grants, grants, `grants for ${handle}`);
  return updated;
}

function assertGrantSet(actual, expected, label) {
  const actualOperations = new Set(Array.isArray(actual) ? actual.map((grant) => grant.operation) : []);
  const expectedOperations = new Set(expected.map((grant) => grant.operation));
  if (actualOperations.size !== expectedOperations.size) {
    throw new Error(`${label} had ${actualOperations.size} grants, expected ${expectedOperations.size}`);
  }
  for (const operation of expectedOperations) {
    if (!actualOperations.has(operation)) {
      throw new Error(`${label} is missing ${operation}`);
    }
  }
}

function assertDeliveryStatus(message, expectedStatus, label) {
  if (message?.deliveryStatus !== expectedStatus) {
    throw new Error(`${label} delivery was ${message?.deliveryStatus ?? "missing"}, expected ${expectedStatus}`);
  }
}

function requireResult(label) {
  const result = results.find((candidate) => candidate.label === label);
  if (!result) {
    throw new Error(`Missing ${label} state`);
  }
  return result;
}

function requireOtherResult(label) {
  const result = results.find((candidate) => candidate.label !== label);
  if (!result) {
    throw new Error(`Missing peer state for ${label}`);
  }
  return result;
}

function requireMessage(threadResult, predicate, label) {
  const message = Array.isArray(threadResult?.messages)
    ? threadResult.messages.find(predicate)
    : null;
  if (!message) {
    throw new Error(`${label} was not found in thread ${threadResult?.thread?.threadId ?? "missing"}`);
  }
  return message;
}

function requireStatus(threadResult, messageId, state, label) {
  const status = Array.isArray(threadResult?.statuses)
    ? threadResult.statuses.find((candidate) => candidate.messageId === messageId && candidate.state === state)
    : null;
  if (!status) {
    throw new Error(`${label} did not have state ${state}`);
  }
  return status;
}
