import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { deletionStackHarness, NAMESPACES, SCOPES, STACK } from "./fixtures/deletion-stack-harness.ts";
import { administerOperatorBootstrap } from "../src/operator-bootstrap.ts";
import { captureInstallationDeletionObjects, deletionCaptureEpochSchema, deletionCaptureInspectionResultSchema } from "../src/installation-deletion-capture.ts";
import type { MigrationD1Row } from "../src/installation-migration-d1.ts";
import type { InstallationDeletionManifest } from "../../workers/installations/src/deletion-inventory.ts";

type Harness = ReturnType<typeof deletionStackHarness>;
type Worker = ReturnType<Harness["getWorker"]>;
type Socket = NonNullable<Awaited<ReturnType<Worker["fetch"]>>["webSocket"]>;
const valueSchema = z.json();
type Json = z.infer<typeof valueSchema>;
const rpcSchema = z.object({ type: z.literal("res"), id: z.string(), ok: z.boolean(), data: valueSchema.optional(), error: valueSchema.optional() });
const createdSchema = z.object({ installation: z.object({ installationId: z.string() }), onboarding: z.object({ onboardingUrl: z.string() }) });
type AdminHeaders = { origin: string; "content-type": string; authorization?: string };
type ResourceNamespace = { getByName(name: string): { inspectInstallationResource(): Promise<{ name?: string; empty: boolean }> } };
const origin = "https://accounts.example.invalid";
const username = "same-owner";
const path = `/home/${username}/same-file.txt`;
const repository = `${username}/same-repository`;
const password = "local-acceptance-fixture-password";

describe("public multi-worker deletion acceptance", () => {
  let harness: Harness;
  let operatorToken: string;
  const sockets: Socket[] = [];
  beforeAll(async () => {
    harness = deletionStackHarness();
    await harness.listen();
    await harness.getWorker(STACK.accounts).applyD1Migrations("INSTALLATIONS_DB");
  });
  afterAll(async () => { for (const socket of sockets) if (socket.readyState === 1) socket.close(1000, "test complete"); await harness?.close(); });

  async function post(path: string, body: Json, authenticated = true) {
    const headers: AdminHeaders = { origin, "content-type": "application/json" };
    if (authenticated) headers.authorization = `Bearer ${operatorToken}`;
    return harness.getWorker(STACK.accounts).fetch(origin + path, { method: "POST", headers, body: JSON.stringify(body) });
  }
  async function setup(handle: string, token?: string) {
    const response = await harness.getWorker(STACK.gateway).fetch(`https://${handle}.example.invalid/ws`, { headers: { upgrade: "websocket" } });
    expect(response.status).toBe(101);
    if (!response.webSocket) throw new Error("Gateway WebSocket is unavailable");
    const socket = response.webSocket; socket.accept(); sockets.push(socket);
    if (token) await ok(socket, "sys.setup", { username, password, onboardingToken: token });
    await ok(socket, "sys.connect", { protocol: 4, peer: { id: `deletion-${handle}`, version: "1", platform: "test" }, auth: { username, password } });
    return socket;
  }
  async function populate(socket: Socket, text: string) {
    expect(await ok(socket, "fs.write", { path, content: text })).toMatchObject({ ok: true });
    await ok(socket, "repo.apply", { repo: repository, message: "local fixture", ops: [{ type: "put", path: "same-file.txt", content: text }] });
    const spawned = z.object({ pid: z.string() }).parse(await ok(socket, "proc.spawn", { label: "retained work", interactive: true }));
    const { conversation } = z.object({ conversation: z.object({ id: z.string() }) })
      .parse(await ok(socket, "conversation.forProcess", { pid: spawned.pid }));
    await ok(socket, "conversation.send", { conversationId: conversation.id, text: "fixture pending work" });
    await ok(socket, "proc.abort", { pid: spawned.pid });
    expect(await ok(socket, "ai.text.generate", { messages: [{ role: "user", content: "ping" }], options: { maxTokens: 16, timeoutMs: 10000 } }))
      .toMatchObject({ text: "managed stack pong" });
    expect(await ok(socket, "mail.send", { deliveryId: "same-delivery", to: "fixture@example.invalid", subject: "local fixture", text }))
      .toMatchObject({ ok: true });
    await until(async () => {
      const result = z.object({ outbound: z.object({ state: z.string() }) }).parse(await ok(socket, "mail.status", { deliveryId: "same-delivery" }));
      return result.outbound.state === "accepted";
    });
    return spawned.pid;
  }

  it("bootstraps two spaces, resets one, imports physical discovery and erases its state while the other remains usable", async () => {
    const accounts = harness.getWorker<{ INSTALLATIONS_DB: D1Database }>(STACK.accounts);
    let { INSTALLATIONS_DB: db } = await accounts.getEnv();
    const issued = await administerOperatorBootstrap({ action: "issue", mode: "operator", database: {
      identity: { accountId: "local", databaseId: "local" }, async batch(statements) {
        const results = await db.batch<MigrationD1Row>(statements.map((statement) => db.prepare(statement.sql).bind(...statement.params ?? [])));
        return results.map((result) => result.results);
      },
    } });
    const onboardingToken = `onboard_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
    operatorToken = `operator_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
    const bootstrap = await post("/bootstrap", { claim: issued.secret!, handle: "first", onboardingToken, operatorToken }, false);
    expect(bootstrap.status).toBe(200);
    const a = z.object({ installationId: z.string(), operatorAccess: z.literal(true) }).parse(await bootstrap.json());
    const create = await post("/admin/api/installations", { operationId: "create-second", handle: "second" });
    expect(create.status).toBe(201);
    const b = createdSchema.parse(await create.json());
    const socketA = await setup("first", onboardingToken);
    let socketB = await setup("second", new URL(b.onboarding.onboardingUrl).hash.slice(1));
    for (const installationId of [a.installationId, b.installation.installationId]) {
      const sql = await harness.getWorker(STACK.gateway).getDurableObjectStorage("KERNEL", { name: installationId });
      expect(await sql.exec("SELECT uid, home FROM passwd WHERE username = ?", username)).toEqual([{ uid: 1000, home: `/home/${username}` }]);
    }
    const pidA = await populate(socketA, "first-space");
    await populate(socketB, "second-space");
    const gateway = harness.getWorker<{ STORAGE: R2Bucket }>(STACK.gateway);
    let { STORAGE: storage } = await gateway.getEnv();
    expect(await (await storage.get(`installations/${a.installationId}/${path.slice(1)}`))?.text()).toBe("first-space");
    expect(await (await storage.get(`installations/${b.installation.installationId}/${path.slice(1)}`))?.text()).toBe("second-space");

    const reset = await post(`/admin/api/installations/${a.installationId}/reset`, { operationId: "reset-first", confirmHandle: "first" });
    expect(reset.status).toBe(201);
    const replacement = createdSchema.parse(await reset.json());
    expect(replacement.installation.installationId).not.toBe(a.installationId);
    let replacementSocket = await setup("first", new URL(replacement.onboarding.onboardingUrl).hash.slice(1));
    expect(await ok(replacementSocket, "fs.read", { path })).toMatchObject({ ok: false });
    expect((await rpc(socketA, "proc.list", {})).ok).toBe(false);
    expect(await ok(socketB, "fs.search", { path, query: "second-space" })).toMatchObject({ ok: true, count: 1 });
    expect(await ok(socketB, "repo.read", { repo: repository, path: "same-file.txt" })).toMatchObject({ content: "second-space" });

    const artifacts = new Map<string, string>();
    const capture = await captureInstallationDeletionObjects({ configuration: {
      version: 1, accountId: "a".repeat(32), accountsOrigin: origin, installationId: a.installationId,
      candidateInstallationIds: [a.installationId, b.installation.installationId, replacement.installation.installationId],
      namespaces: NAMESPACES.map(({ namespaceId, ownerId, kind }) => ({ namespaceId, ownerId, kind, className: kind })),
    }, cloudflare: { async listObjects(input) {
      const namespace = NAMESPACES.find((candidate) => candidate.namespaceId === input.namespaceId)!;
      const ids = await harness.getWorker(namespace.worker).listDurableObjectIds(namespace.binding);
      const offset = input.cursor ? Number(input.cursor) : 0;
      const result = ids.sort().slice(offset, offset + input.limit).map((id) => ({ id, hasStoredData: true }));
      return { success: true, result, result_info: { count: result.length, cursor: result.length ? String(offset + result.length) : "" } };
    } }, accounts: {
      async openInspection(id) {
        const response = await post(`/admin/api/installations/${id}/deletion/inspection`, {});
        expect(response.status).toBe(201);
        return deletionCaptureEpochSchema.parse(await response.json());
      },
      async inspect(input) {
        const response = await post(`/admin/api/installations/${input.installationId}/deletion/inspect`, input);
        const body = await response.json();
        expect(response.status, `${input.resources[0]?.kind}: ${JSON.stringify(body)}`).toBe(200);
        return deletionCaptureInspectionResultSchema.parse(body);
      },
    }, artifacts: { async read(reference) { return artifacts.get(reference) ?? null; }, async write(reference, body) {
      const existing = artifacts.get(reference);
      if (existing !== undefined && existing !== body) throw new Error("Immutable capture artifact changed");
      artifacts.set(reference, body);
    } } });
    expect(capture.unidentifiedObjects, capture.evidence.filter((record) => record.body.includes('"unidentified"'))
      .map((record) => `${record.reference}: ${record.body}`).join("\n")).toBe(0);
    expect([...new Set(capture.resources.map((resource) => resource.namespace))].sort())
      .toEqual(NAMESPACES.map((namespace) => namespace.namespaceId).sort());
    expect(capture.resources.some((resource) => resource.namespace === NAMESPACES[1].namespaceId && resource.name.includes(encodeURIComponent(pidA)))).toBe(true);
    const manifest: InstallationDeletionManifest = { version: 1, installationId: a.installationId, capturedAt: Date.now(),
      owners: Object.entries(SCOPES).map(([id, scopes]) => ({ id,
        resources: [...scopes.map((scope) => ({ ...scope, resourceId: scope.kind === "r2" ? `installations/${a.installationId}/` : a.installationId })),
          ...capture.resources.filter((resource) => resource.ownerId === id).map(({ ownerId: _ownerId, ...resource }) => resource)],
        evidence: capture.evidence.map((record) => ({ id: record.reference, reference: record.reference, sha256: record.sha256, capturedAt: Date.now() })),
      })) };
    const registered = await post(`/admin/api/installations/${a.installationId}/deletion/inventory`, { manifest, evidence: capture.evidence });
    expect(registered.status, await registered.clone().text()).toBe(201);
    const inventory = z.object({ sha256: z.string() }).parse(await registered.json());
    const resources = capture.resources.filter((resource) => resource.ownerId === "gateway").map((resource) => ({
      kind: NAMESPACES.find((namespace) => namespace.namespaceId === resource.namespace)!.kind,
      namespaceId: resource.namespace, name: resource.name, objectId: resource.resourceId,
    }));
    await until(async () => {
      const response = await post(`/admin/api/installations/${a.installationId}/deletion/import`, { installationId: a.installationId, discoverySha256: inventory.sha256, resources });
      expect(response.status, await response.clone().text()).toBe(200);
      return z.object({ outcome: z.string() }).parse(await response.json()).outcome === "verified";
    });
    const begin = await post(`/admin/api/installations/${a.installationId}/deletion`, { operationId: "delete-retired-first", inventorySha256: inventory.sha256 });
    expect(begin.status, await begin.clone().text()).toBe(201);
    await until(async () => {
      const response = await post(`/admin/api/installations/${a.installationId}/deletion/retry`, {});
      expect(response.status).toBe(200);
      const progress = z.object({ operationId: z.string(), phase: z.string(), owners: z.array(z.object({ id: z.string(), outcome: z.string() })) })
        .parse(await response.json());
      expect(progress.operationId).toBe("delete-retired-first");
      expect(progress.phase).not.toBe("live-erased");
      return progress.owners.some((owner) => owner.id === "gateway" && owner.outcome === "retry");
    });
    expect(await db.prepare("SELECT state FROM installations WHERE id = ?").bind(a.installationId).first()).not.toBeNull();
    for (const socket of sockets.splice(0)) if (socket.readyState === 1) socket.close(1000, "restart fixture");
    await harness.update((options) => ({ ...options, workers: options.workers.map((worker) => "config" in worker && worker.config.name === STACK.evidence
      ? { config: { ...worker.config, vars: { ...worker.config.vars, LOSE_ERASE_REPLY: 0 } } } : worker) }));
    ({ INSTALLATIONS_DB: db } = await accounts.getEnv());
    ({ STORAGE: storage } = await gateway.getEnv());
    socketB = await setup("second");
    replacementSocket = await setup("first");
    await until(async () => {
      const response = await post(`/admin/api/installations/${a.installationId}/deletion/retry`, {});
      expect(response.status).toBe(200);
      const progress = z.object({ operationId: z.string(), phase: z.string() }).parse(await response.json());
      expect(progress.operationId).toBe("delete-retired-first");
      return progress.phase === "live-erased" || progress.phase === "erased";
    });
    const receipts = (await db.prepare("SELECT owner_id, receipt_json FROM installation_deletion_owners WHERE operation_id = ?")
      .bind("delete-retired-first").all<{ owner_id: string; receipt_json: string }>()).results;
    expect(receipts.map((receipt) => receipt.owner_id).sort()).toEqual(["accounts", "gateway", "inference", "mail"]);
    for (const receipt of receipts) expect(JSON.parse(receipt.receipt_json)).toMatchObject({ phase: "live-erased", pendingResources: 0, outcome: "retention-pending" });
    expect((await storage.list({ prefix: `installations/${a.installationId}/` })).objects).toEqual([]);
    expect(await db.prepare("SELECT id FROM installations WHERE id = ?").bind(a.installationId).first()).toBeNull();
    const replay = await harness.getWorker(STACK.evidence).fetch("https://fixture.invalid/replay", {
      method: "POST", body: JSON.stringify({ installationId: a.installationId }),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ late: expect.stringMatching(/retired|not active/i),
      inference: expect.stringMatching(/not active/i), mail: "Mail installation is unavailable" });
    const gatewayNamespaces = await harness.getWorker<{ KERNEL: ResourceNamespace; PROCESS: ResourceNamespace; CONVERSATION: ResourceNamespace }>(STACK.gateway).getEnv();
    for (const resource of capture.resources) {
      const namespace = NAMESPACES.find((namespace) => namespace.namespaceId === resource.namespace)!;
      if (namespace.kind === "ripgit") {
        const response = await harness.getWorker(STACK.ripgit).fetch("https://ripgit.invalid/.gsv/discovery/inspect", {
          method: "POST", body: JSON.stringify({ objectId: resource.resourceId, name: resource.name }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ empty: true, name: resource.name });
        continue;
      }
      if (["kernel", "process", "conversation"].includes(namespace.kind)) {
        const binding = namespace.kind === "kernel" ? gatewayNamespaces.KERNEL : namespace.kind === "process" ? gatewayNamespaces.PROCESS : gatewayNamespaces.CONVERSATION;
        expect(await binding.getByName(resource.name).inspectInstallationResource()).toMatchObject({ empty: true, name: resource.name });
        continue;
      }
      const sql = await harness.getWorker(namespace.worker).getDurableObjectStorage(namespace.binding, { id: resource.resourceId });
      if (namespace.kind === "inference-executor") {
        expect(await sql.exec("SELECT COUNT(*) AS count FROM executor_requests")).toEqual([{ count: 0 }]);
        expect(await sql.exec("SELECT COUNT(*) AS count FROM executor_usage")).toEqual([{ count: 0 }]);
      } else if (namespace.kind === "mail") {
        expect(await sql.exec("SELECT COUNT(*) AS count FROM mail_outbound_deliveries")).toEqual([{ count: 0 }]);
        expect(await sql.exec("SELECT COUNT(*) AS count FROM mail_daily_usage")).toEqual([{ count: 0 }]);
      }
    }
    expect(await ok(socketB, "fs.search", { path, query: "second-space" })).toMatchObject({ ok: true, count: 1 });
    expect(await ok(socketB, "ai.text.generate", { messages: [{ role: "user", content: "still online" }], options: { maxTokens: 16, timeoutMs: 10000 } }))
      .toMatchObject({ text: "managed stack pong" });
    expect(await ok(socketB, "repo.read", { repo: repository, path: "same-file.txt" })).toMatchObject({ content: "second-space" });
    expect(await ok(replacementSocket, "fs.write", { path, content: "replacement-space" })).toMatchObject({ ok: true });
  });
});

async function rpc(socket: Socket, call: string, args: Json) {
  const id = crypto.randomUUID();
  // SAFETY: Wrangler's WebSocket proxy exposes the standard message event interface.
  const events = socket as { addEventListener(type: "message", handler: (event: { data: string }) => void): void;
    removeEventListener(type: "message", handler: (event: { data: string }) => void): void };
  const result = new Promise<z.infer<typeof rpcSchema>>((resolve, reject) => {
    const timer = setTimeout(() => { events.removeEventListener("message", message); reject(new Error(`RPC timed out: ${call}`)); }, 15000);
    function message(event: { data: string }) {
      const data = z.string().safeParse(event.data);
      if (!data.success) return;
      const frame = rpcSchema.safeParse(JSON.parse(data.data));
      if (!frame.success || frame.data.id !== id) return;
      clearTimeout(timer); events.removeEventListener("message", message); resolve(frame.data);
    }
    events.addEventListener("message", message);
  });
  socket.send(JSON.stringify({ type: "req", id, call, args }));
  return result;
}
async function ok(socket: Socket, call: string, args: Json) {
  const response = await rpc(socket, call, args);
  expect(response, `syscall ${call}`).toMatchObject({ ok: true });
  return response.data;
}
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error("Local deletion acceptance did not reach its next boundary");
}
