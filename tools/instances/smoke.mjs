import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import WebSocket from "ws";
import { GSVClient } from "../../packages/gsv/dist/client.js";
import { bodyFromText, bodyToBytes } from "../../packages/gsv/dist/protocol.js";

// Intentionally local: this fixture never creates a paid remote browser.
const origin = new URL(process.env.GSV_BROWSER_SMOKE_ORIGIN ?? "http://localhost:8976");
assert.equal(origin.hostname, "localhost", "Smoke requires the local development stack");
class LocalSocket extends WebSocket {
  constructor(url, protocols) {
    super(url, protocols, { lookup: (_name, options, callback) => options.all
      ? callback(null, [{ address: "127.0.0.1", family: 4 }]) : callback(null, "127.0.0.1", 4) });
  }
}
const client = new GSVClient({ WebSocket: LocalSocket, defaultRequestTimeoutMs: 60000 });
const login = `<!doctype html><title>GSV sign-in fixture</title><style>body{font:20px system-ui;padding:40px}input,button{display:block;margin:20px 0;padding:12px;width:300px}</style><h1>Test sign-in</h1><form action="/session" method="post"><input name="email" placeholder="Email"><input type="password" name="password" placeholder="Password"><button>Sign in</button></form>`;
let stored;
const storageReady = new Promise(resolve => { stored = resolve; });
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/html");
  if (request.url === "/session" && request.method === "POST") {
    request.resume(); request.on("end", () => { response.writeHead(303, { "Set-Cookie": "gsv_test_session=valid; HttpOnly; SameSite=Lax; Path=/", Location: "/account" }); response.end(); });
  } else if (request.url === "/stored") { stored(); response.end("ok"); }
  else if (request.url === "/account") {
    response.end(`<h1>Signed in</h1><script>localStorage.setItem("profile-test","kept");const open=indexedDB.open("profile-test",1);open.onupgradeneeded=()=>open.result.createObjectStore("state");open.onsuccess=()=>{const tx=open.result.transaction("state","readwrite");tx.objectStore("state").put("kept","session");tx.oncomplete=()=>fetch("/stored")}</script>`);
  } else if (request.url === "/probe") {
    const cookie = request.headers.cookie?.includes("gsv_test_session=valid") ? "kept" : "missing";
    response.end(`<body><script>const open=indexedDB.open("profile-test",1);open.onupgradeneeded=()=>open.result.createObjectStore("state");open.onsuccess=()=>{const request=open.result.transaction("state").objectStore("state").get("session");request.onsuccess=()=>{document.body.innerHTML='<pre id="restored">cookie=${cookie};local='+localStorage.getItem("profile-test")+';indexed='+request.result+'</pre>'}}</script></body>`);
  } else response.end(login);
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const website = `http://127.0.0.1:${server.address().port}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const startedIds = [];
let profileId;
async function state(id, desired) {
  for (let attempt = 0; attempt < 90; attempt++) {
    const { instance } = await client.sys.instance.get({ instanceId: id });
    if (instance.state === desired || (desired === "terminal" && ["stopped", "failed"].includes(instance.state))) return instance;
    assert.notEqual(instance.state, "failed", `Instance failed: ${instance.diagnosticRef}`);
    await sleep(1000);
  }
  throw new Error(`Instance did not become ${desired}`);
}
async function start() {
  const requestId = crypto.randomUUID();
  const result = await client.sys.instance.start({ requestId, templateId: "browser", lifetimeSeconds: 300, profileId });
  startedIds.push(result.instance.instanceId);
  assert.equal((await client.sys.instance.start({ requestId, templateId: "browser", lifetimeSeconds: 300, profileId })).instance.instanceId, result.instance.instanceId);
  return state(result.instance.instanceId, "ready");
}
async function shell(instance, input) {
  const result = await client.shell.exec({ target: instance.targetId, input });
  assert.equal(result.status, "completed", result.error ?? result.output); assert.equal(result.exitCode, 0, result.error);
  return result.output;
}
try {
  const created = await fetch(new URL("/admin/api/installations", origin), { method: "POST", headers: { Origin: origin.origin, "Content-Type": "application/json" }, body: JSON.stringify({ operationId: crypto.randomUUID(), handle: `browser-smoke-${crypto.randomUUID().slice(0, 8)}` }) });
  assert.equal(created.status, 201, "Local Accounts did not create a test installation");
  const setup = await created.json();
  const url = `${setup.installation.canonicalOrigin.replace("http:", "ws:")}/ws`;
  const credentials = { username: "browser-tester", password: `${crypto.randomUUID()}aA1!` };
  await client.requestOnce(url, "sys.setup", { ...credentials, timezone: "UTC", onboardingToken: new URL(setup.onboarding.onboardingUrl).hash.slice(1) });
  await client.connect({ url, ...credentials });
  console.log("Clean local space is ready");
  profileId = (await client.sys.browser.profile.create({ requestId: crypto.randomUUID(), label: "Smoke profile" })).profile.profileId;
  const first = await start();
  const opened = await shell(first, `tabs open --active ${website}/login`);
  const { tab } = JSON.parse(opened.slice(opened.indexOf("\n") + 1));
  const { handoff } = await client.sys.browser.handoff.request({ instanceId: first.instanceId, requestId: crypto.randomUUID(), tabId: tab.id, purpose: "Test persistent sign-in" });
  const selector = { instanceId: first.instanceId, requestId: handoff.requestId };
  await client.sys.browser.handoff.open(selector);
  await assert.rejects(client.shell.exec({ target: first.targetId, input: "page snapshot" }), /human_control/);
  const frame = await client.request("sys.browser.handoff.frame", selector);
  assert.ok((await bodyToBytes(frame.body)).byteLength > 1000);
  const input = value => client.request("sys.browser.handoff.input", selector, { body: bodyFromText(JSON.stringify(value)) });
  for (const id of [frame.data.tabs[0].id, tab.id]) await input({ kind: "tab", tabId: id });
  await input({ kind: "click", x: 180, y: 175 });
  await input({ kind: "text", text: "tester@example.invalid" });
  await input({ kind: "key", key: "Tab" });
  await input({ kind: "text", text: "public-test-fixture" });
  await input({ kind: "key", key: "Enter" });
  await Promise.race([storageReady, sleep(15000).then(() => { throw new Error("Sign-in fixture did not save state"); })]);
  await client.sys.browser.handoff.finish(selector);
  await assert.rejects(input({ kind: "text", text: "late" }), /no longer active/);
  assert.equal((await client.sys.browser.profile.get({ profileId })).profile.saveStatus, "saved");
  console.log("Human login completed and profile saved; late input rejected");
  await client.sys.instance.stop({ instanceId: first.instanceId }); await state(first.instanceId, "stopped");
  console.log("First browser stopped; restoring profile into a new instance");
  const second = await start(); assert.notEqual(first.targetId, second.targetId);
  console.log("Restored browser is ready; checking saved website state");
  const restored = await shell(second, `tabs open --active ${website}/probe && page wait '#restored' && page text`);
  assert.match(restored, /cookie=kept;local=kept;indexed=kept/);
  console.log("PASS: clean setup, idempotent start, human control, tab selection, input revocation, and cookie/localStorage/IndexedDB restoration");
} catch (error) { console.error("Smoke failed:", error); throw error; }
finally {
  try {
    const stopped = await Promise.allSettled(startedIds.map(async instanceId => {
      await client.sys.instance.stop({ instanceId }); await state(instanceId, "terminal");
    }));
    const failures = stopped.filter(outcome => outcome.status === "rejected").map(outcome => outcome.reason);
    if (profileId) {
      const result = await client.sys.browser.profile.delete({ profileId });
      assert.equal(result.profile.state, "deleted", "Saved profile deletion is still pending");
    }
    if (failures.length) throw new AggregateError(failures, "Browser cleanup did not complete");
  } finally { client.disconnect(); server.closeAllConnections(); server.close(); }
}
console.log("PASS: confirmed stop and saved profile deletion");
process.exit(0);
