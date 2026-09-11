import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Conversation } from "../conversation/do";
import type { Kernel } from "../kernel/do";
import type { Process } from "../process/do";
import { conversationDurableObjectName, processDurableObjectName } from "./routing";
import { InstallationRetirement, INSTALLATION_RETIREMENT_KEY, MULTIPART_UPLOAD_PREFIX, RESOURCE_IDENTITY_KEY, VERIFIED_INVENTORY_KEY, durableResourceName, inspectResourceStorage } from "./retirement";
import { GatewayDeletionDiscovery } from "./deletion-discovery";
import { PROCESS_KILLED_TOMBSTONE_KEY, tombstoneKilledProcessStorage } from "../process/internal/lifecycle";
import { createInstallationStorage, installationStoragePrefix } from "./storage";

function request() {
  return { version: 1 as const, operationId: crypto.randomUUID(), installationId: crypto.randomUUID() };
}

describe("installation resource retirement", () => {
  it("preserves the exact local runtime identity table without treating it as application data", async () => {
    const input = request();
    const name = conversationDurableObjectName(input.installationId, "conv:local-runtime");
    const stub = env.CONVERSATION.getByName(name);
    await runInDurableObject(stub, async (_instance: Conversation, state) => {
      await state.storage.deleteAll();
      state.storage.sql.exec("CREATE TABLE __miniflare_do_name (id INTEGER PRIMARY KEY, name TEXT)");
      state.storage.sql.exec("INSERT INTO __miniflare_do_name VALUES (1, ?)", name);
      expect(durableResourceName(state, env.CONVERSATION)).toBe(name);
      expect(state.storage.kv.get(RESOURCE_IDENTITY_KEY)).toEqual({ name, inventoriedSinceBirth: true });
      expect(inspectResourceStorage(state.storage)).toEqual({ name, empty: true });
      state.storage.sql.exec("CREATE TABLE __miniflare_application_data (value TEXT)");
      state.storage.sql.exec("INSERT INTO __miniflare_application_data VALUES ('fixture')");
      expect(inspectResourceStorage(state.storage).empty).toBe(false);
      const retirement = new InstallationRetirement(state.storage, input.installationId);
      retirement.begin(input);
      await retirement.quiesced();
      retirement.erase();
      expect(state.storage.sql.exec("SELECT name FROM __miniflare_do_name").toArray()).toEqual([{ name }]);
      expect(inspectResourceStorage(state.storage)).toEqual({ name, empty: true });
    });
    await evictDurableObject(stub);
    expect(await stub.inspectInstallationResource()).toEqual({ name, empty: true });
  });

  it("erases a Conversation, retains its fence across eviction, and preserves another installation", async () => {
    const input = request();
    const name = conversationDurableObjectName(input.installationId, "conv:ship");
    const retired = env.CONVERSATION.getByName(name);
    const other = env.CONVERSATION.getByName(conversationDurableObjectName(crypto.randomUUID(), "conv:ship"));
    await retired.initialize({ ownerUid: 1000, kind: "ship" });
    await other.initialize({ ownerUid: 1000, kind: "ship" });
    expect((await retired.quiesceInstallationResource(input)).phase).toBe("quiesced");
    expect((await retired.eraseInstallationResource(input)).phase).toBe("live-erased");
    await evictDurableObject(retired);
    await runInDurableObject(retired, (instance: Conversation) => {
      expect(() => instance.initialize({ ownerUid: 1000, kind: "ship" })).toThrow("retired");
    });
    expect((await retired.eraseInstallationResource(input)).phase).toBe("live-erased");
    await runInDurableObject(retired, async (instance: Conversation) => {
      await expect(instance.quiesceInstallationResource({ ...input, operationId: crypto.randomUUID() })).rejects.toThrow("operation mismatch");
    });
    expect((await other.history()).latestSequence).toBe(0);
    await runInDurableObject(retired, (_instance: Conversation, state) => {
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray()).toEqual([]);
      expect([...state.storage.kv.list()].map(([key]) => key).sort()).toEqual([INSTALLATION_RETIREMENT_KEY, RESOURCE_IDENTITY_KEY].sort());
    });
  });

  it("keeps killed Process identity and installation retirement after eviction", async () => {
    const input = request();
    const stub = env.PROCESS.getByName(processDurableObjectName(input.installationId, "proc:retire"));
    expect((await stub.quiesceInstallationResource(input)).phase).toBe("quiesced");
    expect((await stub.eraseInstallationResource(input)).phase).toBe("live-erased");
    await evictDurableObject(stub);
    expect((await stub.eraseInstallationResource(input)).phase).toBe("live-erased");
    await runInDurableObject(stub, (instance: Process) => {
      expect(instance.killed).toBe(true);
      expect(() => instance.store.state.setValue("late", "output")).toThrow("retired");
    });
  });

  it("cancels rejected Process and Kernel frame bodies after retirement", async () => {
    const input = request();
    const process = env.PROCESS.getByName(processDurableObjectName(input.installationId, "proc:body"));
    await process.quiesceInstallationResource(input);
    await runInDurableObject(process, async (instance: Process) => {
      let cancelled = false;
      const body = { stream: new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } }) };
      await expect(instance.recvFrame({ type: "res", id: "late", ok: true, body })).rejects.toThrow("retired");
      expect(cancelled).toBe(true);
    });
    const kernel = env.KERNEL.getByName(input.installationId);
    await runInDurableObject(kernel, async (instance: Kernel) => {
      instance.retirement.begin(input);
      let cancelled = false;
      const body = { stream: new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } }) };
      await expect(instance.recvFrame("proc:body", { type: "req", id: "late", call: "net.fetch", args: { url: "https://example.invalid" }, body })).rejects.toThrow("retired");
      expect(cancelled).toBe(true);
    });
  });

  it("drains admitted writes and rejects late writes, SQL, KV, and alarms", async () => {
    const input = request();
    const stub = env.CONVERSATION.getByName(conversationDurableObjectName(input.installationId, "conv:fence"));
    await runInDurableObject(stub, async (_instance: Conversation, state) => {
      const fence = new InstallationRetirement(state.storage, input.installationId);
      const guarded = fence.guardStorage();
      const accepted = Promise.withResolvers<void>();
      const writing = fence.write(() => accepted.promise);
      fence.begin(input);
      let drained = false;
      const draining = fence.quiesced().then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      await expect(fence.write(async () => undefined)).rejects.toThrow("retired");
      accepted.resolve();
      await Promise.all([writing, draining]);
      expect(() => guarded.sql.exec("SELECT 1")).toThrow("retired");
      expect(() => guarded.kv.put("late", "secret")).toThrow("retired");
      await expect(guarded.setAlarm(Date.now() + 1000)).rejects.toThrow("retired");
    });
  });

  it("records and aborts unfinished multipart uploads without crossing installation prefixes", async () => {
    const input = request();
    const stub = env.CONVERSATION.getByName(conversationDurableObjectName(input.installationId, "conv:upload"));
    await runInDurableObject(stub, async (_instance: Conversation, state) => {
      const fence = new InstallationRetirement(state.storage, input.installationId);
      const bucket = createInstallationStorage(env.STORAGE, input.installationId, fence);
      const upload = await bucket.createMultipartUpload("home/user/file");
      expect([...state.storage.kv.list({ prefix: MULTIPART_UPLOAD_PREFIX })]).toHaveLength(1);
      expect(upload.key).toBe("home/user/file");
      fence.begin(input);
      await expect(upload.uploadPart(1, "late")).rejects.toThrow("retired");
      expect(await fence.abortMultipart(env.STORAGE)).toBe(0);
      expect([...state.storage.kv.list({ prefix: MULTIPART_UPLOAD_PREFIX })]).toHaveLength(0);
      expect((await env.STORAGE.list({ prefix: installationStoragePrefix(input.installationId) })).objects).toEqual([]);
    });
  });

  it("retains removed process addresses and prevents pid reuse", async () => {
    const input = request();
    const stub = env.KERNEL.getByName(input.installationId);
    await runInDurableObject(stub, (instance: Kernel, state) => {
      const identity = { uid: 1000, gid: 1000, gids: [1000], username: "person", home: "/home/person", cwd: "/home/person" };
      instance.procs.spawn("proc:old", identity, {});
      instance.procs.kill("proc:old");
      expect(state.storage.sql.exec("SELECT resource_id FROM installation_resources WHERE kind = 'process'").toArray()).toEqual([{ resource_id: "proc:old" }]);
      expect(() => instance.procs.spawn("proc:old", identity, {})).toThrow("never be reused");
    });
  });

  it("erases children before Kernel state and R2, then rejects recreation after eviction", async () => {
    const input = request();
    const otherId = crypto.randomUUID();
    const kernel = env.KERNEL.getByName(input.installationId);
    const other = env.KERNEL.getByName(otherId);
    await runInDurableObject(kernel, (instance: Kernel) => {
      const identity = { uid: 1000, gid: 1000, gids: [1000], username: "person", home: "/home/person", cwd: "/home/person" };
      instance.procs.spawn("proc:old", identity, {});
      instance.procs.kill("proc:old");
      instance.conversations.create({ id: "conv:ship", ownerUid: 1000, kind: "ship", title: "Ship", handlerPid: "proc:old" });
      instance.config.set("user.timezone", "UTC");
    });
    await runInDurableObject(other, (instance: Kernel) => { instance.config.set("user.timezone", "Europe/Amsterdam"); });
    const oldStorage = createInstallationStorage(env.STORAGE, input.installationId);
    const otherStorage = createInstallationStorage(env.STORAGE, otherId);
    await oldStorage.put("home/person/page", "old");
    await otherStorage.put("home/person/page", "other");
    expect((await kernel.quiesceInstallation(input)).phase).toBe("quiesced");
    expect((await kernel.eraseInstallation(input)).phase).toBe("erasing");
    const result = await kernel.eraseInstallation(input);
    expect(result.phase).toBe("live-erased");
    expect(result.outcome).toBe("retention-pending");
    expect(result.retainedCopies[0]?.kind).toBe("backup");
    await evictDurableObject(kernel);
    expect(await kernel.installationDeletionStatus(input)).toEqual(result);
    await runInDurableObject(kernel, (instance: Kernel) => {
      expect(() => instance.config.set("late", "secret")).toThrow("retired");
    });
    expect((await oldStorage.list()).objects).toEqual([]);
    expect(await (await otherStorage.get("home/person/page"))?.text()).toBe("other");
    expect(await runInDurableObject(other, (instance: Kernel) => instance.config.get("user.timezone"))).toBe("Europe/Amsterdam");
    await otherStorage.delete("home/person/page");
  });

  it("inspects a nameless historical tombstone without restoring the process schema", async () => {
    const input = request();
    const pid = "proc:historical";
    const id = env.PROCESS.newUniqueId();
    const anonymous = env.PROCESS.get(id);
    await runInDurableObject(anonymous, (_instance: Process, state) => {
      tombstoneKilledProcessStorage(state.storage, { version: 1, pid, uid: null, result: { ok: true, pid, archivedMessages: 0, archivedTo: null, archives: [] }, cleanup: "completed", pendingCleanup: [] });
      state.storage.kv.delete(RESOURCE_IDENTITY_KEY);
    });
    await evictDurableObject(anonymous);
    expect(await anonymous.inspectInstallationResource()).toMatchObject({ localId: pid, empty: false });
    const discovery = new GatewayDeletionDiscovery(env);
    expect((await discovery.inspect({ installationId: input.installationId, resources: [{ kind: "process", objectId: id.toString() }] })).observations).toEqual([
      { kind: "process", objectId: id.toString(), outcome: "unidentified", localId: pid },
    ]);
    await runInDurableObject(anonymous, (_instance: Process, state) => {
      expect([...state.storage.kv.list()].map(([key]) => key)).toEqual([PROCESS_KILLED_TOMBSTONE_KEY]);
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'process_kv'").toArray()).toEqual([]);
    });
  });

  it("adopts a nameless historical Process and resumes deletion after identity attachment restarts it", async () => {
    const input = request();
    const name = processDurableObjectName(input.installationId, "proc:adopt");
    const id = env.PROCESS.idFromName(name);
    const anonymous = env.PROCESS.get(env.PROCESS.idFromString(id.toString()));
    await runInDurableObject(anonymous, (_instance: Process, state) => {
      tombstoneKilledProcessStorage(state.storage, { version: 1, pid: "proc:adopt", uid: null, result: { ok: true, pid: "proc:adopt", archivedMessages: 0, archivedTo: null, archives: [] }, cleanup: "completed", pendingCleanup: [] });
      state.storage.kv.delete(RESOURCE_IDENTITY_KEY);
    });
    await evictDurableObject(anonymous);
    expect(await anonymous.inspectInstallationResource()).toEqual({ localId: "proc:adopt", empty: false });
    const discovery = new GatewayDeletionDiscovery(env);
    const manifest = { installationId: input.installationId, discoverySha256: "b".repeat(64), resources: [{ kind: "process" as const, objectId: id.toString(), name }] };
    expect((await discovery.import(manifest)).outcome).toBe("verified");
    expect(await env.PROCESS.get(id).inspectInstallationResource()).toMatchObject({ name, localId: "proc:adopt" });
    const kernel = env.KERNEL.getByName(input.installationId);
    expect((await kernel.quiesceInstallation(input)).phase).toBe("quiesced");
    expect((await kernel.eraseInstallation(input)).phase).toBe("live-erased");
  });

  it("uses candidate identities only when their physical address matches and rejects foreign owner kinds", async () => {
    const input = request();
    const otherId = crypto.randomUUID();
    const kernel = env.KERNEL.getByName(otherId);
    const discovery = new GatewayDeletionDiscovery(env);
    const namespaceId = "a".repeat(32);
    const inspected = await discovery.inspect({ installationId: input.installationId, candidateInstallationIds: [crypto.randomUUID(), otherId], resources: [{ kind: "kernel", objectId: kernel.id.toString(), namespaceId }] });
    expect(inspected.observations).toEqual([{ kind: "kernel", objectId: kernel.id.toString(), namespaceId, name: otherId, installationId: otherId, outcome: "identified" }]);
    const foreign = { kind: "mail" as const, objectId: "a".repeat(64), name: input.installationId };
    await expect(discovery.inspect({ installationId: input.installationId, resources: [foreign] })).rejects.toThrow("not owned by Gateway");
    await expect(discovery.import({ installationId: input.installationId, discoverySha256: "a".repeat(64), resources: [foreign] })).rejects.toThrow("not owned by Gateway");
  });

  it("resumes a verified inventory import without sealing the first batch", async () => {
    const input = request();
    const kernel = env.KERNEL.getByName(input.installationId);
    const resources = [{ kind: "kernel" as const, name: input.installationId, objectId: kernel.id.toString() }];
    const processes = [];
    for (let index = 0; index < 17; index++) {
      const name = processDurableObjectName(input.installationId, `proc:historical-${index}`);
      const stub = env.PROCESS.getByName(name);
      await stub.inspectInstallationResource();
      processes.push({ kind: "process" as const, name, objectId: stub.id.toString() });
    }
    await runInDurableObject(kernel, (_instance: Kernel, state) => {
      state.storage.kv.put(RESOURCE_IDENTITY_KEY, { name: input.installationId, inventoriedSinceBirth: false });
    });
    const manifest = { installationId: input.installationId, discoverySha256: "a".repeat(64), resources: [...resources, ...processes] };
    const discovery = new GatewayDeletionDiscovery(env);
    expect((await discovery.import(manifest)).outcome).toBe("missing-inventory");
    expect(await runInDurableObject(kernel, (_instance: Kernel, state) => state.storage.kv.get(VERIFIED_INVENTORY_KEY))).toBeUndefined();
    await evictDurableObject(kernel);
    expect((await discovery.import(manifest)).outcome).toBe("verified");
    expect((await discovery.import(manifest)).outcome).toBe("verified");
    expect(await runInDurableObject(kernel, (_instance: Kernel, state) => state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM installation_resources WHERE kind = 'process'").one().count)).toBe(17);
  });
});
