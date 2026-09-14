import { test } from "node:test";
import assert from "node:assert/strict";
import { alchemyState, cloudflareApi, destroyPreview, listPreviews, preflightPreview, previewCloudMain, previewScope, r2Cleanup, readyPreview, recordPreview, verifyPreview } from "./preview-cloud.mjs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const scope = previewScope({ repositoryId: "123", pullRequest: "45", accountId: "a".repeat(32), zoneId: "b".repeat(32),
  baseDomain: "previews.example.com", zoneName: "example.com" });

function fixture() {
  const calls = [];
  const store = new Map();
  const data = {
    workers: [{ id: scope.prefix }, { id: `${scope.prefix}-inference` }, { id: "production" }],
    namespaces: [{ id: "c".repeat(32), script: scope.prefix, class: "Kernel" }, { id: "d".repeat(32), script: "production", class: "Kernel" }],
    databases: [{ uuid: "db-preview", name: scope.databaseName }, { uuid: "db-production", name: "production" }],
    buckets: [{ name: scope.bucketName }, { name: "production" }],
    dns: [{ id: "dns-preview", name: scope.dnsName, type: "AAAA", content: "100::", proxied: true }],
    routes: scope.routes.map((item, index) => ({ id: `route-${index}`, ...item })),
    applications: [{ id: "app-preview", name: scope.applicationName, domain: `accounts.${scope.domain}`, type: "self_hosted" }],
    policies: [{ id: "policy-preview", name: scope.policyName }],
    certificates: [{ id: "cert-preview", hosts: scope.certificateHosts, type: "advanced", status: "active" }],
  };
  const state = {
    async check() {},
    async get(stack, stage) { return structuredClone(store.get(`${stack}/${stage}`)); },
    async set(stack, stage, value) { calls.push(["save", value.attr.phase]); store.set(`${stack}/${stage}`, structuredClone(value)); },
    async clear(stack, stage) { calls.push(["clear", stack]); store.delete(`${stack}/${stage}`); },
    async stages(stack) { return [...store.keys()].filter((key) => key.startsWith(`${stack}/`)).map((key) => key.slice(stack.length + 1)); },
  };
  let failDelete;
  let failEmpty = false;
  const category = (url) => url.includes("/durable_objects/") ? "namespaces" : url.includes("/workers/scripts") ? "workers"
    : url.includes("/d1/database") ? "databases" : url.includes("/r2/buckets") ? "buckets" : url.includes("/dns_records") ? "dns"
      : url.includes("/workers/routes") ? "routes" : url.includes("/access/apps") ? "applications"
        : url.includes("/access/policies") ? "policies" : url.includes("/certificate_packs") ? "certificates" : null;
  const api = {
    async list(url) { calls.push(["list", category(url)]); return structuredClone(data[category(url)]); },
    async request(url, options = {}) {
      const method = options.method ?? "GET";
      calls.push([method, url]);
      if (url === `/zones/${scope.zoneId}`) return { result: { name: scope.zoneName, account: { id: scope.accountId }, status: "active", type: "full" } };
      const name = new URL(url, "https://example.com").pathname.split("/").at(-1);
      if (url.endsWith("/settings")) return { result: { migration_tag: "v1" } };
      if (method === "PUT") {
        const metadata = JSON.parse(await options.body.get("metadata").text());
        assert.deepEqual(metadata.bindings, []);
        if (metadata.migrations) data.namespaces = data.namespaces.filter((item) => item.script !== name);
        return { result: {} };
      }
      if (method === "DELETE") {
        const kind = category(url);
        if (failDelete === kind) { failDelete = undefined; throw new Error("injected transient failure"); }
        assert.notEqual(name, "production");
        data[kind] = data[kind].filter((item) => (item.uuid ?? item.id ?? item.name) !== name);
        return { result: null };
      }
      throw new Error("Unexpected request");
    },
  };
  const r2 = { async empty(bucket) { calls.push(["empty", bucket]); assert.equal(bucket, scope.bucketName); if (failEmpty) { failEmpty = false; throw new Error("injected multipart abort failure"); } } };
  return { scope, api, state, r2, data, calls, store, allowResourceDeletion: true,
    failDelete(kind) { failDelete = kind; }, failEmpty() { failEmpty = true; } };
}

test("preview names require numeric repository and PR, exact account and zone domain", () => {
  assert.equal(scope.prefix, "gsv-123-pr-45");
  assert.equal(scope.stack, "gsv-previews-123");
  for (const change of [{ repositoryId: "1/../../production" }, { pullRequest: "0" }, { accountId: "anything" },
    { baseDomain: "other.com" }, { baseDomain: "UPPER.example.com" }]) assert.throws(() => previewScope({ ...scope, ...change }));
});

async function register(f, refresh = false) {
  const live = structuredClone(f.data);
  for (const key of Object.keys(f.data)) f.data[key] = [];
  await recordPreview(scope, f);
  Object.assign(f.data, live);
  if (refresh) await recordPreview(scope, { ...f, refresh: true });
}

test("record checks absent names, explicit permission defaults off, config immutable", async () => {
  const f = fixture();
  await assert.rejects(recordPreview(scope, { state: f.state, api: f.api }), /explicitly/);
  assert.equal(f.calls.length, 0);
  await register(f);
  assert.deepEqual(f.calls.at(-1), ["save", "provisioning"]);
  await assert.rejects(recordPreview(previewScope({ ...scope, baseDomain: "different.example.com" }), f), /changed/);
  f.api.list = async () => { throw new Error("lost cloud response"); };
  await assert.rejects(recordPreview(scope, { ...f, refresh: true }));
  assert.equal((await f.state.get(scope.registryStack, scope.stage)).attr.phase, "provisioning");
});

test("teardown removes only exact resources and forgets state only after fresh verification", async () => {
  const f = fixture();
  await register(f);
  const report = await destroyPreview(scope, f);
  assert.equal(report.phase, "absent");
  assert.deepEqual(f.data.workers, [{ id: "production" }]);
  assert.deepEqual(f.data.namespaces, [{ id: "d".repeat(32), script: "production", class: "Kernel" }]);
  assert.deepEqual(f.data.databases, [{ uuid: "db-production", name: "production" }]);
  assert.deepEqual(f.data.buckets, [{ name: "production" }]);
  assert.deepEqual(f.calls.slice(-2), [["clear", scope.stack], ["clear", scope.registryStack]]);
  const bucketDelete = f.calls.findIndex(([method, url]) => method === "DELETE" && url.includes("/r2/buckets"));
  assert.ok(f.calls.findIndex(([method]) => method === "empty") < bucketDelete);
});

for (const kind of ["workers", "databases", "dns", "certificates"]) test(`a failed ${kind} deletion keeps inventory and retry handles already absent resources`, async () => {
  const f = fixture();
  await register(f);
  f.failDelete(kind);
  await assert.rejects(destroyPreview(scope, f), /transient/);
  const checkpoint = await f.state.get(scope.registryStack, scope.stage);
  assert.equal(checkpoint.attr.phase, "destroying");
  assert.equal(checkpoint.attr.inventory.namespaces.length, 1);
  assert.equal(f.calls.some(([method]) => method === "clear"), false);
  assert.equal((await destroyPreview(scope, f)).phase, "absent");
});

test("failed multipart cleanup retains bucket and inventory for the next janitor", async () => {
  const f = fixture();
  await register(f);
  f.failEmpty();
  await assert.rejects(destroyPreview(scope, f), /multipart/);
  assert.equal(f.data.buckets.some((item) => item.name === scope.bucketName), true);
  assert.equal(f.calls.some(([method]) => method === "clear"), false);
  await destroyPreview(scope, f);
});

test("namespace deletion must be observed before Worker and bucket removal", async () => {
  const f = fixture();
  await register(f);
  const request = f.api.request;
  f.api.request = async (url, options) => options?.method === "PUT" ? { result: {} } : request(url, options);
  await assert.rejects(destroyPreview(scope, f), /namespaces remain/);
  assert.equal(f.calls.some(([method]) => method === "DELETE" || method === "empty" || method === "clear"), false);
});

test("scope and ID collisions fail before any physical mutation", async () => {
  for (const change of [
    (f) => { f.data.routes[0].script = "production"; },
    (f) => { f.data.databases[0].uuid = "replacement-database"; },
    (f) => { f.data.namespaces[0].script = "production"; },
    (f) => { f.data.applications[0].domain = "accounts.production.example.com"; },
  ]) {
    const f = fixture();
    await register(f, true);
    f.calls.length = 0;
    change(f);
    await assert.rejects(destroyPreview(scope, f));
    assert.equal(f.calls.some(([method]) => ["DELETE", "PUT", "clear", "empty"].includes(method)), false);
  }
});

test("default-off guard, missing S3 credentials and missing durable registration preserve resources", async () => {
  const f = fixture();
  await assert.rejects(destroyPreview(scope, { ...f, allowResourceDeletion: false }), /explicitly/);
  await assert.rejects(destroyPreview(scope, f), /registration/);
  await register(f);
  await assert.rejects(destroyPreview(scope, { ...f, r2: undefined }), /S3/);
  assert.equal(f.calls.some(([method]) => method === "PUT" || method === "DELETE"), false);
});

test("verification never mistakes failed enumeration for physical absence", async () => {
  const f = fixture();
  await assert.rejects(verifyPreview(scope, f), /remain/);
  f.api.list = async () => { throw new Error("forbidden"); };
  await assert.rejects(verifyPreview(scope, f), /forbidden/);
});

test("janitor lists safe PR numbers from the existing Alchemy store only", async () => {
  const f = fixture();
  await register(f);
  assert.deepEqual(await listPreviews("123", f.state), [45]);
  await assert.rejects(listPreviews("123", { stages: async () => ["production"] }), /Unexpected/);
});

test("Cloudflare pagination rejects repeated cursors and does not leak response bodies", async () => {
  const api = cloudflareApi({ token: "private-token", fetch: async () => Response.json({ success: true, result: [{ id: "one" }], result_info: { cursor: "repeat" } }) });
  await assert.rejects(api.list("/accounts/example/workers/scripts"), /no progress/);
  const denied = cloudflareApi({ token: "private-token", fetch: async () => new Response("secret remote body", { status: 403 }) });
  await assert.rejects(denied.request("/accounts/example"), (error) => error.message === "Cloudflare request failed (403)");
});

test("Alchemy HTTP state is scoped, uses version 5 and never follows redirects", async () => {
  const requests = [];
  const state = alchemyState({ url: "https://state.example.com", token: "private-token", fetch: async (url, init) => {
    requests.push([url.toString(), init]);
    return init.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(url.pathname === "/version" ? { version: 5 } : []);
  } });
  await state.check(); await state.stages(scope.stack); await state.clear(scope.stack, scope.stage);
  assert.equal(requests.at(-1)[0], `https://state.example.com/state/stacks/${scope.stack}?stage=pr-45`);
  assert.equal(requests.every(([, request]) => request.redirect === "error"), true);
  assert.throws(() => alchemyState({ url: "http://state.example.com", token: "token" }));
});

test("readiness requires active TLS, all resources, and exact Access team redirect", async () => {
  const f = fixture();
  f.data.workers.push({ id: `${scope.prefix}-ripgit` }, { id: `${scope.prefix}-installations` });
  f.data.certificates[0].status = "pending_validation";
  const deps = { ...f, accessTeamDomain: "https://company.cloudflareaccess.com", attempts: 2,
    sleep: async () => { f.data.certificates[0].status = "active"; },
    fetch: async () => new Response(null, { status: 302, headers: { location: "https://company.cloudflareaccess.com/cdn-cgi/access/login/accounts.example.com" } }) };
  assert.equal((await readyPreview(scope, deps)).url, `${scope.adminOrigin}/admin/installations`);
  await assert.rejects(readyPreview(scope, { ...deps, fetch: async () => new Response("unguarded", { status: 200 }) }), /not protected/);
  await assert.rejects(readyPreview(scope, { ...deps, fetch: async () => new Response(null, { status: 302, headers: { location: "https://wrong.cloudflareaccess.com/cdn-cgi/access/login/" } }) }), /outside/);
  f.data.certificates[0].status = "pending_validation";
  await assert.rejects(readyPreview(scope, { ...deps, attempts: 1 }), /timed out/);
});

test("preflight checks existing shared AI and scope without creating resources", async () => {
  const requests = [];
  const deps = { state: { async check() {} }, accessKeyId: "key", secretAccessKey: "secret", api: {
    async request(url) { requests.push(url); return { result: url.endsWith("/default") ? { id: "default" } : url.endsWith("/quota") ? { advanced: { allocated: 100 } }
      : { name: scope.zoneName, account: { id: scope.accountId }, status: "active", type: "full" } }; },
    async list() { return [{ name: "@cf/zai-org/glm-5.3-flash" }]; },
  } };
  assert.equal((await preflightPreview(scope, deps)).phase, "preflight");
  assert.equal(requests.length, 3);
  assert.equal((await preflightPreview(scope, { ...deps, inferenceModel: "" })).phase, "preflight");
  await assert.rejects(preflightPreview(scope, { ...deps, accessKeyId: undefined }), /S3/);
  await assert.rejects(preflightPreview(scope, { ...deps, inferenceModel: "@cf/not-installed" }), /unavailable/);
});

test("R2 drains multipart uploads and ordinary objects, including an already aborted upload", async () => {
  const operations = [];
  let upload = true;
  let object = true;
  const r2 = await r2Cleanup({ scope, accessKeyId: "test-key", secretAccessKey: "test-secret", fetch: async (request) => {
    const url = new URL(request.url);
    operations.push([request.method, url.pathname, [...url.searchParams.keys()]]);
    if (request.method === "DELETE") {
      if (url.searchParams.has("uploadId")) { upload = false; return new Response("<Error><Code>NoSuchUpload</Code></Error>", { status: 404 }); }
      object = false; return new Response(null, { status: 204 });
    }
    const multipart = url.searchParams.has("uploads");
    const root = multipart ? "ListMultipartUploadsResult" : "ListBucketResult";
    const item = multipart ? upload ? "<Upload><Key>user%20data/file</Key><UploadId>upload-1</UploadId></Upload>" : ""
      : object ? "<Contents><Key>user%20data/file</Key></Contents>" : "";
    return new Response(`<${root}><${multipart ? "Bucket" : "Name"}>${scope.bucketName}</${multipart ? "Bucket" : "Name"}><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated>${item}</${root}>`);
  } });
  await assert.rejects(r2.empty("production"), /outside/);
  await r2.empty(scope.bucketName);
  assert.equal(upload, false); assert.equal(object, false);
  assert.equal(operations.filter(([method]) => method === "DELETE").length, 2);
});

test("R2 rejects incomplete empty listings and paths that URL normalization would change", async () => {
  for (const inner of ["<IsTruncated>true</IsTruncated>", "<IsTruncated>false</IsTruncated><Upload><Key>../other-bucket</Key><UploadId>upload</UploadId></Upload>"]) {
    let deleted = false;
    const r2 = await r2Cleanup({ scope, accessKeyId: "test-key", secretAccessKey: "test-secret", fetch: async (request) => {
      if (request.method === "DELETE") deleted = true;
      return new Response(`<ListMultipartUploadsResult><Bucket>${scope.bucketName}</Bucket><EncodingType>url</EncodingType>${inner}</ListMultipartUploadsResult>`);
    } });
    await assert.rejects(r2.empty(scope.bucketName));
    assert.equal(deleted, false);
  }
});


test("fresh registration never claims preexisting names even if Alchemy refuses adoption", async () => {
  const f = fixture();
  await assert.rejects(recordPreview(scope, f), /preexisting/);
  assert.equal(f.store.size, 0);
  await assert.rejects(destroyPreview(scope, f), /registration/);
  assert.equal(f.calls.some(([method]) => ["DELETE", "PUT", "save", "clear", "empty"].includes(method)), false);
});

test("Alchemy's missing state response is HTTP 200 with an empty body", async () => {
  const state = alchemyState({ url: "https://state.example.com", token: "private-token", fetch: async () => new Response(null, { status: 200 }) });
  assert.equal(await state.get(scope.registryStack, scope.stage), undefined);
});

test("CLI teardown uses immutable registered scope without zone or domain environment", async () => {
  const f = fixture();
  await register(f);
  const env = { GSV_PREVIEW_REPOSITORY_ID: scope.repositoryId, GSV_PREVIEW_NUMBER: scope.pullRequest,
    CLOUDFLARE_ACCOUNT_ID: scope.accountId, GSV_ALLOW_RESOURCE_DELETION: "true" };
  await assert.rejects(previewCloudMain(["destroy"], { ...env, CLOUDFLARE_ACCOUNT_ID: "c".repeat(32) }, f), /does not match/);
  assert.equal((await previewCloudMain(["destroy"], env, f)).phase, "absent");
});

test("CLI readiness appends only the validated administration URL to GitHub output", async () => {
  const f = fixture();
  f.data.workers.push({ id: `${scope.prefix}-ripgit` }, { id: `${scope.prefix}-installations` });
  const directory = await mkdtemp(path.join(tmpdir(), "gsv-preview-output-"));
  try {
    const output = path.join(directory, "github-output");
    const env = { GSV_PREVIEW_REPOSITORY_ID: scope.repositoryId, GSV_PREVIEW_NUMBER: scope.pullRequest,
      CLOUDFLARE_ACCOUNT_ID: scope.accountId, GSV_PREVIEW_ZONE_ID: scope.zoneId,
      GSV_PREVIEW_BASE_DOMAIN: scope.baseDomain, GSV_PREVIEW_ZONE_NAME: scope.zoneName,
      GSV_PREVIEW_ACCESS_TEAM_DOMAIN: "https://company.cloudflareaccess.com", GITHUB_OUTPUT: output };
    const report = await previewCloudMain(["ready"], env, { ...f, fetch: async (url) => {
      assert.equal(url, `${scope.adminOrigin}/admin/installations`);
      return new Response(null, { status: 302, headers: { location: "https://company.cloudflareaccess.com/cdn-cgi/access/login/accounts.example.com" } });
    } });
    assert.equal(await readFile(output, "utf8"), `url=${report.url}\n`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
