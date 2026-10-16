import assert from "node:assert/strict";
import test from "node:test";
import { prepareSiteClient } from "../dist/site-client.js";

const metadata = { version: 1, installationId: "inst_publisher", siteId: `site-${"a".repeat(32)}`,
  siteOrigin: "https://site-a.content.example", gatewayOrigin: "https://owner.spaces.example" };
const grant = { calls: ["r12y.list", "r12y.get"], signals: ["r12y.changed"], implements: [] };

class Socket extends EventTarget {
  static instances = [];
  static grant = grant;
  readyState = 0;
  sent = [];
  constructor(url) {
    super();
    this.url = String(url);
    Socket.instances.push(this);
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
  }
  send(value) {
    const frame = JSON.parse(value);
    this.sent.push(frame);
    if (frame.call === "sys.connect") queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
      type: "res", id: frame.id, ok: true, data: {
        protocol: 4, server: { connectionId: "site-session" }, peer: {
          id: frame.args.peer.id, sessionId: "site-session", grant: Socket.grant,
          principal: { kind: "human", account: { uid: 1000, gid: 1000, gids: [100], username: "owner", home: "/home/owner", cwd: "/home/owner" } },
        },
      },
    }) })));
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}

class Browser extends EventTarget {
  location = { origin: metadata.siteOrigin };
  opened = [];
  listeners = new Set();
  blocked = false;
  open(url) {
    if (this.blocked) return null;
    const popup = { closed: false, close() { this.closed = true; } };
    this.opened.push({ url: new URL(url), popup });
    return popup;
  }
  addEventListener(type, callback, options) { super.addEventListener(type, callback, options); this.listeners.add(callback); }
  removeEventListener(type, callback) { super.removeEventListener(type, callback); this.listeners.delete(callback); }
  message(data, { origin = metadata.gatewayOrigin, source = this.opened.at(-1).popup } = {}) {
    const event = new Event("message");
    Object.assign(event, { data, origin, source });
    this.dispatchEvent(event);
  }
}

function setup(t, bootstrap = metadata) {
  const browser = new Browser();
  const descriptors = new Map(["window", "fetch", "WebSocket"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const requests = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url, options) => {
    requests.push({ url: String(url), options });
    return Response.json(bootstrap);
  } });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: Socket });
  Object.defineProperty(browser, "localStorage", { get() { throw new Error("Credentials must not be persisted"); } });
  Object.defineProperty(browser, "sessionStorage", { get() { throw new Error("Credentials must not be persisted"); } });
  Socket.instances = [];
  Socket.grant = grant;
  t.after(() => {
    browser.dispatchEvent(new Event("pagehide"));
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return { browser, requests };
}

function approval(browser, overrides = {}) {
  return { kind: "gsv.site.authorization", nonce: browser.opened.at(-1).url.searchParams.get("nonce"), authorization: {
    installationId: metadata.installationId, siteId: metadata.siteId, siteOrigin: metadata.siteOrigin, gatewayOrigin: metadata.gatewayOrigin,
    token: "test-site-token", tokenId: "test-token-id", expiresAtMs: Date.now() + 60_000,
    calls: [...grant.calls], signals: [...grant.signals], ...overrides,
  } };
}

test("prepares only its own bootstrap and opens consent synchronously without leaking credentials into URLs", async (t) => {
  const { browser, requests } = setup(t);
  const prepared = await prepareSiteClient();
  assert.deepEqual(requests, [{ url: `${metadata.siteOrigin}/_gsv/site.json`, options: {
    credentials: "omit", redirect: "error", cache: "no-store", headers: { accept: "application/json" },
  } }]);
  const pending = prepared.connect();
  assert.equal(browser.opened.length, 1);
  const opened = browser.opened[0];
  assert.equal(opened.url.origin, metadata.gatewayOrigin);
  assert.equal(opened.url.pathname, "/authorize-site");
  assert.deepEqual([...opened.url.searchParams.keys()], ["site", "nonce"]);
  assert.equal(opened.url.searchParams.get("site"), metadata.siteId);
  browser.message(approval(browser));
  const session = await pending;
  assert.equal(Socket.instances[0].url, "wss://owner.spaces.example/ws");
  assert.equal(Socket.instances[0].sent[0].args.auth.token, "test-site-token");
  assert.deepEqual(Object.keys(session).sort(), ["client", "close", "expiresAtMs"]);
  assert.equal(opened.popup.closed, true);
  session.close();
  assert.equal(browser.listeners.size, 0);
});

test("ignores forged popup sources, origins and nonces before accepting one matching authorization", async (t) => {
  const { browser } = setup(t);
  const prepared = await prepareSiteClient();
  const pending = prepared.connect();
  const valid = approval(browser);
  browser.message(valid, { origin: "https://attacker.example" });
  browser.message(valid, { source: {} });
  browser.message({ ...valid, nonce: "different-attempt" });
  await Promise.resolve();
  assert.equal(Socket.instances.length, 0);
  browser.message(valid);
  (await pending).close();
});

test("rejects foreign bootstrap identities and non-origin gateway destinations", async (t) => {
  for (const changed of [{ siteOrigin: "https://foreign.example" }, { gatewayOrigin: metadata.siteOrigin },
    { gatewayOrigin: "https://owner.spaces.example/redirect" }, { gatewayOrigin: "http://owner.spaces.example" }, { version: 2 }]) {
    await t.test(JSON.stringify(changed), async (t) => {
      const { browser } = setup(t, { ...metadata, ...changed });
      await assert.rejects(prepareSiteClient(), /identity is invalid/);
      assert.equal(browser.opened.length, 0);
    });
  }
});

test("rejects foreign identities and expired or overlong sessions", async (t) => {
  for (const changed of [{ installationId: "inst_foreign" }, { siteId: `site-${"b".repeat(32)}` },
    { gatewayOrigin: "https://different.spaces.example" }, { siteOrigin: "https://different.content.example" },
    { expiresAtMs: Date.now() - 1 }, { expiresAtMs: Date.now() + 2 * 60 * 60_000 }]) {
    await t.test(JSON.stringify(changed), async (t) => {
      const { browser } = setup(t);
      const pending = (await prepareSiteClient()).connect();
      browser.message(approval(browser, changed));
      await assert.rejects(pending, /did not match/);
      assert.equal(Socket.instances.length, 0);
      assert.equal(browser.listeners.size, 0);
    });
  }
});

test("rejects broader connection grants even after a valid popup response", async (t) => {
  for (const unexpected of [{ calls: ["*"] }, { signals: ["*"] }, { implements: ["fs.read"] }]) {
    await t.test(JSON.stringify(unexpected), async (t) => {
      const { browser } = setup(t);
      Socket.grant = { ...grant, ...unexpected };
      const pending = (await prepareSiteClient()).connect();
      browser.message(approval(browser));
      await assert.rejects(pending, /approved site permissions/);
      assert.equal(Socket.instances[0].readyState, 3);
      assert.equal(browser.listeners.size, 0);
    });
  }
});

test("ignores malformed or broader credential envelopes", async (t) => {
  const { browser } = setup(t);
  const pending = (await prepareSiteClient()).connect();
  for (const invalid of [{ calls: ["*"] }, { signals: ["*"] }, { tokenId: "" }, { token: "" }, { tokenId: undefined }]) {
    browser.message(approval(browser, invalid));
  }
  await Promise.resolve();
  assert.equal(Socket.instances.length, 0);
  browser.message(approval(browser));
  (await pending).close();
});

test("handles cancellation and prevents overlapping popup attempts", async (t) => {
  const { browser } = setup(t);
  const prepared = await prepareSiteClient();
  const pending = prepared.connect();
  await assert.rejects(prepared.connect(), /already in progress/);
  const nonce = browser.opened[0].url.searchParams.get("nonce");
  browser.message({ kind: "gsv.site.authorization.cancelled", nonce, siteId: metadata.siteId });
  await assert.rejects(pending, /cancelled/);
  assert.equal(browser.listeners.size, 0);
  browser.blocked = true;
  await assert.rejects(prepared.connect(), /Allow this page/);
});

test("closes its client at expiry and clears the authorization timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  const { browser } = setup(t);
  const pending = (await prepareSiteClient()).connect();
  browser.message(approval(browser, { expiresAtMs: Date.now() + 1000 }));
  const session = await pending;
  assert.equal(session.client.isConnected(), true);
  t.mock.timers.tick(1000);
  assert.equal(session.client.isConnected(), false);
  assert.equal(browser.listeners.size, 0);
});

test("cleans up closed and unanswered popups without creating a client", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  const { browser } = setup(t);
  const prepared = await prepareSiteClient();
  const closed = prepared.connect();
  browser.opened[0].popup.close();
  t.mock.timers.tick(250);
  await assert.rejects(closed, /cancelled/);
  const timedOut = prepared.connect();
  t.mock.timers.tick(5 * 60_000);
  await assert.rejects(timedOut, /timed out/);
  assert.equal(Socket.instances.length, 0);
  assert.equal(browser.listeners.size, 0);
});
