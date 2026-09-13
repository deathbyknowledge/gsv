import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SharedDiscordEnv } from "../src/shared-application";
import { DiscordAccountRetirement } from "../src/discord-account-retirement";
import { adapterAccountDurableObjectName } from "../../shared/src/installation";

// SAFETY: this test configuration provides the concrete legacy account namespace.
const bindings = env as SharedDiscordEnv;

function fixture(label: string) {
  const installationId = `retired-legacy-${label}`;
  const name = adapterAccountDurableObjectName({ installationId }, "default");
  const namespace = bindings.DISCORD_GATEWAY!;
  return { namespace, name, stub: namespace.getByName(name), input: { version: 1 as const, installationId, operationId: "retire-account" } };
}
describe("legacy Discord account retirement", () => {
  it("bounds erasure and retains its identity and fence across a real object eviction", async () => {
    const f = fixture("bounded");
    await runInDurableObject(f.stub, async (instance, state) => {
      await state.storage.put("state", { accountId: "default" });
      for (let i = 0; i < 65; i++) state.storage.kv.put(`pending_inbound:${i}`, { private: "historical payload" });
      state.storage.sql.exec("CREATE TABLE IF NOT EXISTS __miniflare_do_name (id INTEGER PRIMARY KEY, name TEXT)");
      state.storage.sql.exec("INSERT OR REPLACE INTO __miniflare_do_name VALUES (1, ?)", f.name);
      await state.storage.setAlarm(Date.now() + 120_000);
      expect(await instance.inspectInstallationResource(f.input.installationId)).toEqual({ outcome: "identified", name: f.name, installationId: f.input.installationId });
      expect(await instance.eraseInstallation(f.input)).toMatchObject({ phase: "erasing", pendingResources: 33 });
      expect(await state.storage.getAlarm()).toBeNull();
      expect((await state.storage.list()).size).toBe(36);
      expect(await instance.eraseInstallation(f.input)).toMatchObject({ phase: "erasing", pendingResources: 2 });
      expect(await instance.eraseInstallation(f.input)).toMatchObject({ phase: "live-erased", pendingResources: 0, outcome: "retention-pending" });
      expect((await state.storage.list()).size).toBe(2);
      expect(state.storage.sql.exec<{ name: string }>("SELECT name FROM __miniflare_do_name WHERE id = 1").one().name).toBe(f.name);
    });
    await evictDurableObject(f.stub);
    expect(await f.stub.installationDeletionStatus(f.input)).toMatchObject({ phase: "live-erased", pendingResources: 0, outcome: "retention-pending" });
    await runInDurableObject(f.stub, async (instance, state) => {
      await expect(instance.start("late-private-token", "default")).rejects.toThrow("retired");
      await expect(instance.quiesceInstallation({ ...f.input, operationId: "different" })).rejects.toThrow("immutable");
      await instance.alarm();
      expect(await instance.getBotToken()).toBeNull();
      expect(await state.storage.get("state")).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("never resumes historical transport or exposes credentials before cleanup", async () => {
    const f = fixture("inert");
    await runInDurableObject(f.stub, async (instance, state) => {
      const historical = { accountId: "default", botToken: "historical-private-token", sessionId: "saved-session" };
      await state.storage.put("state", historical);
      await state.storage.setAlarm(Date.now() + 120_000);
      await expect(instance.start("replacement-token", "default")).rejects.toThrow("transport is retired");
      expect(await instance.getBotToken()).toBeNull();
      let cancelled = false;
      const body = { stream: new ReadableStream({ type: "bytes", cancel() { cancelled = true; } }) };
      expect(await instance.sendMessage({ deliveryId: "blocked", surface: { kind: "dm", id: "123" }, text: "blocked" }, body))
        .toMatchObject({ ok: false, error: "Legacy Discord account transport is retired" });
      expect(cancelled).toBe(true);
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBeNull();
      expect(await state.storage.get("state")).toEqual(historical);
      expect(await instance.eraseInstallation(f.input)).toMatchObject({ phase: "live-erased", pendingResources: 0 });
      expect(await state.storage.get("state")).toBeUndefined();
    });
  });

  it("rejects late transaction writes and leaves unknown object schemas unclassified", async () => {
    const f = fixture("transaction");
    await runInDurableObject(f.stub, async (_instance, state) => {
      state.storage.kv.put("state", { accountId: "default" });
      const owner = new DiscordAccountRetirement(state.storage, state.id.toString(), f.namespace);
      const guarded = owner.guardStorage();
      await guarded.transaction(async (txn) => {
        await owner.quiesce(f.input, () => {});
        expect(() => txn.put("late-result", "private")).toThrow("retired");
      });
      expect(state.storage.kv.get("late-result")).toBeUndefined();
      expect(() => guarded.kv.put("late-result", "private")).toThrow("retired");
      expect(() => guarded.setAlarm(Date.now() + 1_000)).toThrow("retired");
    });
    const unknown = fixture("unknown");
    await runInDurableObject(unknown.stub, async (instance, state) => {
      state.storage.kv.put("state", { accountId: "default" });
      state.storage.sql.exec("CREATE TABLE __miniflare_unrecognized (private_data TEXT)");
      expect(await instance.inspectInstallationResource(unknown.input.installationId)).toEqual({ outcome: "unidentified" });
      await expect(instance.eraseInstallation(unknown.input)).rejects.toThrow("ownership is not verified");
      expect(state.storage.kv.get("state")).toEqual({ accountId: "default" });
    });
  });
});
