import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { appendFile } from "node:fs/promises";

const hexId = /^[a-f0-9]{32}$/;
const positive = /^[1-9][0-9]{0,14}$/;
const registryFqn = "Preview";
export class PreviewCloudError extends Error {}
const fail = (message) => { throw new PreviewCloudError(message); };
const array = (value) => Array.isArray(value) ? value : fail("Invalid resource enumeration");
const segment = encodeURIComponent;
const domainName = z.string().max(190).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/);
const physicalId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const nonemptyString = z.string().min(1);

/** Names come from trusted workflow inputs, never a PR-supplied resource list. */
export function previewScope(input) {
  const repositoryId = String(input.repositoryId);
  const pullRequest = String(input.pullRequest);
  if (!positive.test(repositoryId) || !positive.test(pullRequest)) fail("Invalid preview identity");
  if (!hexId.test(input.accountId) || !hexId.test(input.zoneId)) fail("Invalid Cloudflare scope");
  for (const name of [input.baseDomain, input.zoneName]) {
    domainName.parse(name);
  }
  if (input.baseDomain !== input.zoneName && !input.baseDomain.endsWith(`.${input.zoneName}`)) fail("Preview domain is outside the zone");
  const prefix = `gsv-${repositoryId}-pr-${pullRequest}`;
  const domain = `pr-${pullRequest}.${input.baseDomain}`;
  return {
    repositoryId, pullRequest, accountId: input.accountId, zoneId: input.zoneId,
    baseDomain: input.baseDomain, zoneName: input.zoneName,
    stack: `gsv-previews-${repositoryId}`, registryStack: `gsv-preview-registry-${repositoryId}`,
    stage: `pr-${pullRequest}`, prefix, domain, adminOrigin: `https://accounts.${domain}`,
    workerNames: [prefix, `${prefix}-ripgit`, `${prefix}-installations`, `${prefix}-inference`],
    databaseName: `${prefix}-installations`, bucketName: `${prefix}-storage`,
    applicationName: `${prefix}-administration`, policyName: `${prefix}-company`,
    dnsName: `*.${domain}`, routes: [
      { pattern: `accounts.${domain}/*`, script: `${prefix}-installations` },
      { pattern: `*.${domain}/*`, script: prefix },
    ], certificateHosts: [input.zoneName, domain, `*.${domain}`].sort(),
  };
}

function sameScope(left, right) {
  if (JSON.stringify(previewScope(left)) !== JSON.stringify(previewScope(right))) fail("Preview scope changed after registration");
}

/** All responses remain private; errors expose only a bounded status. */
export function cloudflareApi({ token, fetch: fetcher = fetch }) {
  if (!token) fail("Cloudflare authentication is required");
  const request = async (suffix, { method = "GET", body, missing = false } = {}) => {
    const headers = { authorization: `Bearer ${token}` };
    if (body !== undefined && !(body instanceof FormData)) headers["content-type"] = "application/json";
    let response;
    try { response = await fetcher(`https://api.cloudflare.com/client/v4${suffix}`, {
      method, headers, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
      redirect: "error", signal: AbortSignal.timeout(45_000),
    }); } catch { fail("Cloudflare request failed"); }
    if (missing && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); fail(`Cloudflare request failed (${response.status})`); }
    if (response.status === 204) return { result: null };
    const json = await response.json();
    if (json?.success !== true) fail("Cloudflare rejected request");
    return json;
  };
  return {
    request,
    async list(suffix, select = (result) => result, pagination = "page") {
      const records = [];
      const cursors = new Set();
      let cursor;
      for (let page = 1; page <= 1_000; page++) {
        const url = new URL(suffix, "https://api.cloudflare.com");
        if (pagination !== "none") url.searchParams.set("per_page", "50");
        if (cursor) url.searchParams.set("cursor", cursor); else if (pagination === "page") url.searchParams.set("page", String(page));
        const response = await request(url.pathname + url.search);
        const batch = array(select(response.result));
        records.push(...batch);
        const info = response.result_info;
        const next = info?.cursor ?? info?.cursors?.after ?? response.result?.cursor;
        if (next) {
          nonemptyString.parse(next);
          if (cursors.has(next) || !batch.length) fail("Cloudflare pagination made no progress");
          cursors.add(next); cursor = next; continue;
        }
        if (info?.total_pages !== undefined) {
          if (!Number.isInteger(info.total_pages) || (info.page !== undefined && info.page !== page)) fail("Invalid Cloudflare pagination");
          if (page < info.total_pages) { if (!batch.length) fail("Cloudflare pagination made no progress"); continue; }
          return records;
        }
        if (pagination === "none" || pagination === "cursor" || cursor || batch.length < 50) return records;
      }
      fail("Cloudflare enumeration exceeded its bound");
    },
  };
}

/** The existing Alchemy HTTP state store is the only durable inventory. */
export function alchemyState({ url, token, fetch: fetcher = fetch }) {
  if (!nonemptyString.safeParse(url).success) fail("ALCHEMY_STATE_URL is required");
  const base = new URL(url);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || !token) fail("Invalid Alchemy state configuration");
  const request = async (suffix, method = "GET", body) => {
    let response;
    try { response = await fetcher(new URL(suffix, base), { method, redirect: "error", signal: AbortSignal.timeout(45_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) }); } catch { fail("Alchemy state request failed"); }
    if (!response.ok) { await response.body?.cancel(); fail(`Alchemy state request failed (${response.status})`); }
    const responseBody = await response.text();
    return responseBody === "" ? undefined : JSON.parse(responseBody);
  };
  const stagePath = (stack, stage) => `/state/stacks/${segment(stack)}/stages/${segment(stage)}`;
  return {
    async check() { if ((await request("/version"))?.version !== 5) fail("Alchemy state protocol version must be 5"); },
    async stages(stack) { return array(await request(`/state/stacks/${segment(stack)}/stages`)); },
    async get(stack, stage) { return request(`${stagePath(stack, stage)}/resources/${registryFqn}`); },
    async set(stack, stage, value) { return request(`${stagePath(stack, stage)}/resources/${registryFqn}`, "PUT", value); },
    async resources(stack, stage) {
      const names = array(await request(`${stagePath(stack, stage)}/resources`));
      return Promise.all(names.map((name) => request(`${stagePath(stack, stage)}/resources/${segment(name)}`)));
    },
    async clear(stack, stage) { await request(`/state/stacks/${segment(stack)}?stage=${segment(stage)}`, "DELETE"); },
  };
}

function unique(records, predicate, kind) {
  const matches = records.filter(predicate);
  if (matches.length > 1) fail(`Ambiguous preview ${kind}`);
  return matches[0] ?? null;
}
function resourceId(value) {
  return physicalId.parse(value);
}
function sameHosts(left, right) { return JSON.stringify([...array(left)].sort()) === JSON.stringify([...right].sort()); }
const emptyInventory = () => ({ workers: [], namespaces: [], databases: [], buckets: [], dns: [], routes: [], applications: [], policies: [], certificates: [] });

/** Enumerate exact intended names, including a create that succeeded before its state write. */
export async function discoverPreview(scope, api, previous = emptyInventory()) {
  if (JSON.stringify(scope) !== JSON.stringify(previewScope(scope))) fail("Preview scope is not canonical");
  const account = `/accounts/${scope.accountId}`;
  const zone = `/zones/${scope.zoneId}`;
  const result = emptyInventory();
  const zoneInfo = (await api.request(zone)).result;
  if (zoneInfo.name !== scope.zoneName || zoneInfo.account?.id !== scope.accountId || zoneInfo.status !== "active" || zoneInfo.type !== "full") fail("Preview zone ownership or state does not match");
  const [workers, namespaces, databases, buckets, dns, routes, applications, policies, certificates] = await Promise.all([
    api.list(`${account}/workers/scripts`, (value) => value, "none"), api.list(`${account}/workers/durable_objects/namespaces`),
    api.list(`${account}/d1/database`), api.list(`${account}/r2/buckets`, (value) => value.buckets, "cursor"),
    api.list(`${zone}/dns_records`), api.list(`${zone}/workers/routes`, (value) => value, "none"),
    api.list(`${account}/access/apps`), api.list(`${account}/access/policies`),
    api.list(`${zone}/ssl/certificate_packs?status=all`, (value) => Array.isArray(value) ? value : value.certificate_packs),
  ]);
  result.workers = workers.filter((item) => scope.workerNames.includes(item.id)).map((item) => ({ name: item.id }));
  result.namespaces = namespaces.filter((item) => scope.workerNames.includes(item.script)).map((item) => {
    if (!hexId.test(item.id) || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(item.class)) fail("Invalid Durable Object namespace identity");
    return { id: item.id, worker: item.script, className: item.class };
  });
  for (const known of previous.namespaces) {
    const found = namespaces.find((item) => item.id === known.id);
    if (found && (found.script !== known.worker || found.class !== known.className)) fail("Preview Durable Object ownership changed");
  }
  for (const [values, kind, name] of [[databases, "databases", scope.databaseName], [buckets, "buckets", scope.bucketName]]) {
    const found = unique(values, (item) => item.name === name, kind);
    if (found) {
      const resource = { name };
      if (kind === "databases") resource.id = resourceId(found.uuid);
      result[kind].push(resource);
    }
  }
  for (const record of dns.filter((item) => item.name === scope.dnsName)) {
    if (record.type !== "AAAA" || record.content !== "100::" || record.proxied !== true) fail("Preview DNS identity does not match");
    result.dns.push({ id: resourceId(record.id), name: record.name });
  }
  for (const expected of scope.routes) {
    const found = unique(routes, (item) => item.pattern === expected.pattern, "route");
    if (found) {
      if (found.script !== expected.script) fail("Preview route targets another Worker");
      result.routes.push({ id: resourceId(found.id), ...expected });
    }
  }
  const application = unique(applications, (item) => item.name === scope.applicationName || item.domain === `accounts.${scope.domain}`, "Access application");
  if (application) {
    if (application.name !== scope.applicationName || application.domain !== `accounts.${scope.domain}` || application.type !== "self_hosted") fail("Preview Access application scope does not match");
    result.applications.push({ id: resourceId(application.id), name: application.name });
  }
  const policy = unique(policies, (item) => item.name === scope.policyName, "Access policy");
  if (policy) result.policies.push({ id: resourceId(policy.id), name: policy.name });
  const pack = unique(certificates, (item) => sameHosts(item.hosts, scope.certificateHosts), "certificate pack");
  if (pack) {
    if (pack.type !== "advanced") fail("Preview certificate pack type does not match");
    result.certificates.push({ id: resourceId(pack.id), hosts: scope.certificateHosts, status: pack.status });
  }
  for (const [kind, all, nameOf] of [["databases", databases, (item) => item.name], ["dns", dns, (item) => item.name],
    ["routes", routes, (item) => item.pattern], ["applications", applications, (item) => item.name],
    ["policies", policies, (item) => item.name]]) {
    for (const known of previous[kind]) {
      const found = all.find((item) => (item.uuid ?? item.id) === known.id);
      if (found && nameOf(found) !== (known.name ?? known.pattern)) fail("Preview physical resource ownership changed");
    }
  }
  for (const known of previous.certificates) {
    const found = certificates.find((item) => item.id === known.id);
    if (found && !sameHosts(found.hosts, known.hosts)) fail("Preview certificate ownership changed");
  }
  // A changed physical ID is a collision, not permission to erase a replacement.
  for (const kind of Object.keys(result)) {
    for (const item of result[kind]) {
      const known = previous[kind]?.find((candidate) => item.name ? candidate.name === item.name : kind === "namespaces"
        ? candidate.worker === item.worker && candidate.className === item.className : kind === "routes"
          ? candidate.pattern === item.pattern : kind === "certificates" ? sameHosts(candidate.hosts, item.hosts) : candidate.id === item.id);
      if (known?.id && known.id !== item.id) fail("Preview physical resource identity changed");
    }
  }
  return result;
}

function registryRecord(scope, previous, now) {
  if (previous) {
    if (previous.resourceType !== "Gsv.PreviewRegistry" || previous.attr?.allowResourceDeletion !== true) fail("Invalid preview registry record");
    sameScope(previous.attr.scope, scope);
    return previous;
  }
  return { kind: "resource", resourceType: "Gsv.PreviewRegistry", fqn: registryFqn, logicalId: registryFqn,
    instanceId: scope.prefix, providerVersion: 1, status: "created", downstream: [], bindings: [], props: {},
    attr: { version: 1, allowResourceDeletion: true, scope, createdAt: now, inventory: emptyInventory(), phase: "provisioning" } };
}

export async function recordPreview(scope, { state, api, allowResourceDeletion = false, clock = Date.now, refresh = false }) {
  if (allowResourceDeletion !== true) fail("Preview resource deletion must be explicitly enabled");
  const previous = await state.get(scope.registryStack, scope.stage);
  if (!previous) {
    const existing = await discoverPreview(scope, api);
    if (Object.values(existing).some((resources) => resources.length)) fail("Preview names collide with preexisting resources");
  }
  const record = registryRecord(scope, previous, clock());
  if (record.attr.phase === "destroying") fail("Preview teardown is already in progress");
  // Ownership starts with an absent-name check, then durable intent before provisioning.
  await state.set(scope.registryStack, scope.stage, record);
  if (refresh) {
    record.attr.inventory = mergeInventory(record.attr.inventory, await discoverPreview(scope, api, record.attr.inventory));
    record.attr.updatedAt = clock();
    await state.set(scope.registryStack, scope.stage, record);
  }
  return { pullRequest: Number(scope.pullRequest), phase: record.attr.phase };
}

function mergeInventory(previous, current) {
  return Object.fromEntries(Object.keys(current).map((kind) => [kind, [...new Map([...array(previous[kind]), ...current[kind]]
    .map((item) => [item.id ?? item.name, item])).values()]]));
}

function tombstone(classes = []) {
  return `import { DurableObject } from "cloudflare:workers";\n${classes.map((name) => `export class ${name} extends DurableObject {}`).join("\n")}\nexport default {fetch(){return new Response("Preview closed",{status:410});}};`;
}
async function stopWorker(api, scope, worker, namespaces, erase) {
  const settings = await api.request(`/accounts/${scope.accountId}/workers/scripts/${segment(worker)}/settings`, { missing: true });
  if (!settings) {
    if (namespaces.length) fail("Durable Object namespace remains without its Worker");
    return;
  }
  const classes = namespaces.map((item) => item.className).sort();
  const metadata = { main_module: "preview-closed.mjs", compatibility_date: "2026-09-01", bindings: [], keep_bindings: [] };
  if (erase && classes.length) {
    metadata.migrations = { old_tag: settings.result.migration_tag ?? "", new_tag: `gsv-preview-delete-${createHash("sha256").update(JSON.stringify(classes)).digest("hex").slice(0, 16)}`,
      steps: [{ deleted_classes: classes }] };
  }
  const form = new FormData();
  form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.set("preview-closed.mjs", new Blob([tombstone(erase ? [] : classes)], { type: "application/javascript+module" }), "preview-closed.mjs");
  await api.request(`/accounts/${scope.accountId}/workers/scripts/${segment(worker)}`, { method: "PUT", body: form });
}

/** Physical absence, not a successful delete response, permits forgetting Alchemy state. */
export async function verifyPreview(scope, { api, inventory = emptyInventory() }) {
  const current = await discoverPreview(scope, api, inventory);
  const remaining = Object.fromEntries(Object.entries(current).map(([kind, values]) => [kind, values.length]));
  if (Object.values(remaining).some((count) => count > 0)) fail("Preview physical resources remain");
  return { pullRequest: Number(scope.pullRequest), phase: "absent", remaining };
}

export async function destroyPreview(scope, { state, api, r2, allowResourceDeletion = false }) {
  if (allowResourceDeletion !== true) fail("Preview resource deletion must be explicitly enabled");
  const previous = await state.get(scope.registryStack, scope.stage);
  if (!previous) fail("Preview teardown requires its durable registration");
  const record = registryRecord(scope, previous);
  const current = await discoverPreview(scope, api, record.attr.inventory);
  record.attr.inventory = mergeInventory(record.attr.inventory, current);
  record.attr.phase = "destroying";
  await state.set(scope.registryStack, scope.stage, record);
  if (current.buckets.length && !r2) fail("Preview bucket cleanup requires S3 credentials");
  const account = `/accounts/${scope.accountId}`;
  const zone = `/zones/${scope.zoneId}`;
  // Detach all bindings first, so a class deletion cannot strand another preview Worker.
  for (const worker of current.workers) await stopWorker(api, scope, worker.name, current.namespaces.filter((item) => item.worker === worker.name), false);
  for (const worker of current.workers) await stopWorker(api, scope, worker.name, current.namespaces.filter((item) => item.worker === worker.name), true);
  const namespaces = await api.list(`${account}/workers/durable_objects/namespaces`);
  if (namespaces.some((item) => scope.workerNames.includes(item.script) || record.attr.inventory.namespaces.some((known) => known.id === item.id))) fail("Preview Durable Object namespaces remain");
  for (const route of current.routes) await api.request(`${zone}/workers/routes/${segment(route.id)}`, { method: "DELETE", missing: true });
  for (const worker of current.workers) await api.request(`${account}/workers/scripts/${segment(worker.name)}?force=true`, { method: "DELETE", missing: true });
  for (const bucket of current.buckets) {
    await r2.empty(bucket.name);
    await api.request(`${account}/r2/buckets/${segment(bucket.name)}`, { method: "DELETE", missing: true });
  }
  for (const database of current.databases) await api.request(`${account}/d1/database/${segment(database.id)}`, { method: "DELETE", missing: true });
  for (const application of current.applications) await api.request(`${account}/access/apps/${segment(application.id)}`, { method: "DELETE", missing: true });
  for (const policy of current.policies) await api.request(`${account}/access/policies/${segment(policy.id)}`, { method: "DELETE", missing: true });
  for (const dns of current.dns) await api.request(`${zone}/dns_records/${segment(dns.id)}`, { method: "DELETE", missing: true });
  for (const certificate of current.certificates) await api.request(`${zone}/ssl/certificate_packs/${segment(certificate.id)}`, { method: "DELETE", missing: true });
  const report = await verifyPreview(scope, { api, inventory: record.attr.inventory });
  await state.clear(scope.stack, scope.stage);
  await state.clear(scope.registryStack, scope.stage);
  return report;
}

export async function listPreviews(repositoryId, state) {
  if (!positive.test(String(repositoryId))) fail("Invalid preview repository identity");
  const stages = await state.stages(`gsv-preview-registry-${repositoryId}`);
  return stages.map((stage) => {
    if (!/^pr-[1-9][0-9]{0,14}$/.test(stage)) fail("Unexpected preview registry stage");
    return Number(stage.slice(3));
  }).sort((a, b) => a - b);
}

export async function preflightPreview(scope, { api, state, accessKeyId, secretAccessKey, inferenceModel }) {
  inferenceModel ||= "@cf/zai-org/glm-5.3-flash";
  if (!accessKeyId || !secretAccessKey) fail("Preview preflight requires S3 cleanup credentials");
  if (!/^@cf\/[a-z0-9._/-]+$/.test(inferenceModel)) fail("Invalid Workers AI model");
  await state.check();
  const [zone, gateway, models, quota] = await Promise.all([
    api.request(`/zones/${scope.zoneId}`),
    api.request(`/accounts/${scope.accountId}/ai-gateway/gateways/default`),
    api.list(`/accounts/${scope.accountId}/ai/models/search?search=${segment(inferenceModel)}`),
    api.request(`/zones/${scope.zoneId}/ssl/certificate_packs/quota`),
  ]);
  if (zone.result.name !== scope.zoneName || zone.result.account?.id !== scope.accountId || zone.result.status !== "active" || zone.result.type !== "full") fail("Preview zone ownership or state does not match");
  if (gateway.result.id !== "default") fail("The shared default AI Gateway must already exist");
  if (!models.some((model) => model.name === inferenceModel)) fail("Preview Workers AI model is unavailable");
  if (!Number.isInteger(quota.result.advanced?.allocated) || quota.result.advanced.allocated <= 0) fail("Advanced Certificate Manager must already be enabled");
  return { pullRequest: Number(scope.pullRequest), phase: "preflight", url: scope.adminOrigin };
}

export async function readyPreview(scope, { api, accessTeamDomain, fetch: fetcher = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), attempts = 40 }) {
  const team = new URL(accessTeamDomain);
  const administrationUrl = `${scope.adminOrigin}/admin/installations`;
  if (team.protocol !== "https:" || !team.hostname.endsWith(".cloudflareaccess.com") || team.username || team.password
    || team.pathname !== "/" || team.search || team.hash || !Number.isInteger(attempts) || attempts < 1 || attempts > 40) fail("Invalid preview readiness configuration");
  for (let attempt = 0; attempt < attempts; attempt++) {
    const current = await discoverPreview(scope, api);
    if (current.workers.length !== scope.workerNames.length || current.databases.length !== 1 || current.buckets.length !== 1
      || current.dns.length !== 1 || current.routes.length !== 2 || current.applications.length !== 1 || current.policies.length !== 1) fail("Preview deployment is incomplete");
    if (current.certificates[0]?.status === "active") {
      let response;
      try { response = await fetcher(administrationUrl, { redirect: "manual", signal: AbortSignal.timeout(15_000) }); }
      catch { /* DNS and TLS propagation may lag the active certificate. */ }
      if (response) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if ([302, 303, 307, 308].includes(response.status) && location) {
          const target = new URL(location, scope.adminOrigin);
          if (target.origin !== team.origin || !target.pathname.startsWith("/cdn-cgi/access/login/")) fail("Preview administration redirected outside its Access team");
          return { pullRequest: Number(scope.pullRequest), phase: "ready", url: administrationUrl };
        }
        if (response.status === 200) fail("Preview administration is not protected by Access");
      }
    }
    if (attempt + 1 < attempts) await sleep(15_000);
  }
  fail("Preview TLS or Access readiness timed out");
}

/** Whole disposable buckets only: ordinary objects and incomplete uploads both drain. */
export async function r2Cleanup({ scope, accessKeyId, secretAccessKey, sessionToken, fetch: fetcher = fetch }) {
  if (!accessKeyId || !secretAccessKey) fail("Preview bucket cleanup requires S3 credentials");
  const { AwsClient } = await import("aws4fetch");
  const { XMLParser, XMLValidator } = await import("fast-xml-parser");
  const signer = new AwsClient({ accessKeyId, secretAccessKey, sessionToken, service: "s3", region: "auto", retries: 0 });
  const parser = new XMLParser({ parseTagValue: false, ignoreDeclaration: true, isArray: (name) => name === "Upload" || name === "Contents" });
  const request = async (url, method = "GET") => {
    let response;
    try { response = await fetcher(await signer.sign(url, { method, redirect: "error", signal: AbortSignal.timeout(45_000) })); }
    catch { fail("R2 request failed"); }
    const body = await response.text();
    if (body.length > 8 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(body) || body && XMLValidator.validate(body) !== true) fail("Invalid R2 response");
    const json = body ? parser.parse(body) : {};
    if (response.status === 404 && ["NoSuchBucket", "NoSuchUpload", "NoSuchKey"].includes(json.Error?.Code)) return null;
    if (!response.ok) fail(`R2 request failed (${response.status})`);
    return json;
  };
  return { async empty(bucket) {
    if (bucket !== scope.bucketName) fail("R2 bucket is outside the preview");
    const endpoint = `https://${scope.accountId}.r2.cloudflarestorage.com/${bucket}`;
    for (const multipart of [true, false]) {
      for (let round = 0; round < 1_000; round++) {
        const url = new URL(endpoint);
        url.searchParams.set(multipart ? "uploads" : "list-type", multipart ? "" : "2");
        url.searchParams.set("encoding-type", "url");
        url.searchParams.set(multipart ? "max-uploads" : "max-keys", "1000");
        const response = await request(url);
        if (response === null) return;
        const page = response[multipart ? "ListMultipartUploadsResult" : "ListBucketResult"];
        if (page?.Bucket !== undefined && page.Bucket !== bucket || page?.Name !== undefined && page.Name !== bucket
          || page?.EncodingType !== "url" || !["true", "false"].includes(page?.IsTruncated)) fail("R2 enumeration scope does not match");
        const items = array(page[multipart ? "Upload" : "Contents"] ?? []);
        if (!items.length) { if (page.IsTruncated === "true") fail("R2 enumeration made no progress"); break; }
        // Always re-read page one after deletion; provider continuation keys may disappear.
        for (const item of items) {
          nonemptyString.parse(item.Key);
          if (multipart) nonemptyString.parse(item.UploadId);
          const key = decodeURIComponent(item.Key);
          const target = new URL(`${endpoint}/${key.split("/").map(segment).join("/")}`);
          if (decodeURIComponent(target.pathname) !== `/${bucket}/${key}`) fail("R2 key cannot be addressed exactly");
          if (multipart) target.searchParams.set("uploadId", item.UploadId);
          await request(target, "DELETE");
        }
        if (round === 999) fail("R2 cleanup exceeded its bound");
      }
    }
  } };
}

export async function previewCloudMain(args = process.argv.slice(2), env = process.env, runtime = {}) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { pr: { type: "string" }, refresh: { type: "boolean", default: false } } });
  if (positionals.length !== 1 || !["record", "preflight", "ready", "destroy", "verify", "list"].includes(positionals[0])) fail("Expected record, preflight, ready, destroy, verify, or list");
  const state = runtime.state ?? alchemyState({ url: env.ALCHEMY_STATE_URL, token: env.ALCHEMY_STATE_TOKEN });
  await state.check();
  if (positionals[0] === "list") return listPreviews(env.GSV_PREVIEW_REPOSITORY_ID, state);
  if (["destroy", "verify"].includes(positionals[0])) {
    const repositoryId = env.GSV_PREVIEW_REPOSITORY_ID;
    const pullRequest = values.pr ?? env.GSV_PREVIEW_NUMBER;
    if (!positive.test(repositoryId) || !positive.test(pullRequest) || !hexId.test(env.CLOUDFLARE_ACCOUNT_ID)) fail("Invalid preview identity");
    const registered = await state.get(`gsv-preview-registry-${repositoryId}`, `pr-${pullRequest}`);
    if (!registered) {
      if ((await state.resources(`gsv-previews-${repositoryId}`, `pr-${pullRequest}`)).length) fail("Preview resources have no durable registration");
      return { pullRequest: Number(pullRequest), phase: "unregistered" };
    }
    const scope = previewScope(registered.attr?.scope);
    registryRecord(scope, registered);
    if (scope.repositoryId !== repositoryId || scope.pullRequest !== pullRequest || scope.accountId !== env.CLOUDFLARE_ACCOUNT_ID) fail("Registered preview scope does not match");
    const api = runtime.api ?? cloudflareApi({ token: env.CLOUDFLARE_API_TOKEN });
    if (positionals[0] === "verify") return verifyPreview(scope, { api, inventory: registered.attr.inventory });
    const r2 = runtime.r2 ?? (env.GSV_PREVIEW_R2_ACCESS_KEY_ID && env.GSV_PREVIEW_R2_SECRET_ACCESS_KEY ? await r2Cleanup({ scope,
      accessKeyId: env.GSV_PREVIEW_R2_ACCESS_KEY_ID, secretAccessKey: env.GSV_PREVIEW_R2_SECRET_ACCESS_KEY,
      sessionToken: env.GSV_PREVIEW_R2_SESSION_TOKEN }) : undefined);
    return destroyPreview(scope, { state, api, r2, allowResourceDeletion: env.GSV_ALLOW_RESOURCE_DELETION === "true" });
  }
  const scope = previewScope({ repositoryId: env.GSV_PREVIEW_REPOSITORY_ID, pullRequest: values.pr ?? env.GSV_PREVIEW_NUMBER,
    accountId: env.CLOUDFLARE_ACCOUNT_ID, zoneId: env.GSV_PREVIEW_ZONE_ID, baseDomain: env.GSV_PREVIEW_BASE_DOMAIN, zoneName: env.GSV_PREVIEW_ZONE_NAME });
  const api = runtime.api ?? cloudflareApi({ token: env.CLOUDFLARE_API_TOKEN });
  const allowResourceDeletion = env.GSV_ALLOW_RESOURCE_DELETION === "true";
  if (positionals[0] === "preflight") return preflightPreview(scope, { state, api, accessKeyId: env.GSV_PREVIEW_R2_ACCESS_KEY_ID,
    secretAccessKey: env.GSV_PREVIEW_R2_SECRET_ACCESS_KEY, inferenceModel: env.GSV_PREVIEW_INFERENCE_MODEL });
  if (positionals[0] === "ready") {
    const report = await readyPreview(scope, { api, accessTeamDomain: env.GSV_PREVIEW_ACCESS_TEAM_DOMAIN, fetch: runtime.fetch, sleep: runtime.sleep });
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `url=${report.url}\n`);
    return report;
  }
  if (positionals[0] === "record") return recordPreview(scope, { state, api, allowResourceDeletion, refresh: values.refresh });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await previewCloudMain())}\n`); }
  catch (error) {
    const detail = error instanceof PreviewCloudError ? error.message : "Unexpected response or invalid configuration";
    process.stderr.write(`Preview cloud operation failed: ${detail}. Remote inventory is retained for retry.\n`); process.exitCode = 1;
  }
}
