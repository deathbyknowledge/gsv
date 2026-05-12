#!/usr/bin/env node

const SOCIAL_COLLECTIONS = [
  "space.gsv.profile",
  "space.gsv.instance",
  "space.gsv.agent.card",
];

const peers = [
  readPeer("A"),
  readPeer("B"),
];

if (typeof WebSocket === "undefined") {
  throw new Error("This smoke script requires a Node.js runtime with global WebSocket support");
}

const ensureIdentity = process.env.GSV_SOCIAL_ENSURE !== "0";
const results = [];

for (const peer of peers) {
  const ws = await connect(peer);
  try {
    const identity = await getOrSetupIdentity(peer, ws);
    const publicState = await readPublicState(peer.origin);
    results.push({
      label: peer.label,
      origin: peer.origin,
      did: publicState.did,
      handle: identity.handle,
      profile: publicState.profile.value,
      instance: publicState.instance.value,
      agentCard: publicState.agentCard.value,
    });
  } finally {
    ws.close(1000, "smoke complete");
  }
}

for (const peer of results) {
  for (const other of results) {
    if (peer.label === other.label) continue;
    const profile = await getRecord(peer.origin, other.did, "space.gsv.profile");
    const instance = await getRecord(peer.origin, other.did, "space.gsv.instance");
    assertRecordType(profile.value, "space.gsv.profile", `${peer.label} reading ${other.label} profile`);
    assertRecordType(instance.value, "space.gsv.instance", `${peer.label} reading ${other.label} instance`);
  }
}

for (const peer of peers) {
  const ws = await connect(peer);
  try {
    const other = results.find((result) => result.label !== peer.label);
    if (!other?.handle) {
      throw new Error(`${peer.label} has no peer handle to add`);
    }
    const added = await rpc(ws, "social.friend.add", {
      handle: other.handle,
      grants: [
        { operation: "social.message.send" },
        { operation: "social.request.create" },
      ],
    });
    if (added?.friend?.handle !== other.handle) {
      throw new Error(`${peer.label} added unexpected friend handle`);
    }
    const listed = await rpc(ws, "social.friend.list", {});
    if (!Array.isArray(listed?.friends) || !listed.friends.some((friend) => friend.handle === other.handle)) {
      throw new Error(`${peer.label} friend list does not include ${other.handle}`);
    }
  } finally {
    ws.close(1000, "smoke complete");
  }
}

console.log(JSON.stringify({
  ok: true,
  ensured: ensureIdentity,
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
  if (url.protocol !== "https:") {
    throw new Error(`${url.origin} must be an HTTPS origin. Use a tunnel for local wrangler dev.`);
  }
  return url.origin;
}

function wsUrlFromOrigin(origin) {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
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
    agentDisplayName: `${peer.username}'s GSV`,
  });
  return setup.identity;
}

async function readPublicState(origin) {
  const did = (await fetchText(`${origin}/.well-known/atproto-did`)).trim();

  const didDoc = await fetchJson(`${origin}/.well-known/did.json`);
  if (didDoc.id !== did) {
    throw new Error(`${origin}/.well-known/did.json returned id ${didDoc.id}, expected ${did}`);
  }

  const [profile, instance, agentCard] = await Promise.all(
    SOCIAL_COLLECTIONS.map((collection) => getRecord(origin, did, collection)),
  );
  assertRecordType(profile.value, "space.gsv.profile", `${origin} profile`);
  assertRecordType(instance.value, "space.gsv.instance", `${origin} instance`);
  assertRecordType(agentCard.value, "space.gsv.agent.card", `${origin} agent card`);
  return { did, profile, instance, agentCard };
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
