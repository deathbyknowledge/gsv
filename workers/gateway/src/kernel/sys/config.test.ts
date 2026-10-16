import { describe, expect, it, vi } from "vitest";
import { testPeer } from "../../test-support/peers";
import type { KernelContext } from "../context";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { ResponsibilityStore } from "../responsibility-store";
import { ensureInitialOnboardingResponsibility } from "../onboarding-responsibility";
import { handleSysConfigGet, handleSysConfigSet } from "./config";

type EntryMap = Record<string, string>;

function makeContext(uid: number, entries: EntryMap, ownerUid?: number): KernelContext {
  const map = new Map(Object.entries(entries));
  const config = {
    get(key: string): string | null {
      return map.has(key) ? map.get(key)! : null;
    },
    set(key: string, value: string): void {
      map.set(key, value);
    },
    delete(key: string): boolean {
      const existed = map.has(key);
      map.delete(key);
      return existed;
    },
    list(prefix: string): { key: string; value: string }[] {
      const normalized = prefix.trim();
      const keys = [...map.keys()].sort();
      if (!normalized) {
        return keys.map((key) => ({ key, value: map.get(key)! }));
      }
      const withSlash = normalized.endsWith("/") ? normalized : `${normalized}/`;
      return keys
        .filter((key) => key.startsWith(withSlash))
        .map((key) => ({ key, value: map.get(key)! }));
    },
  };
  const passwdEntries = [
    { username: "root", uid: 0, gid: 0, gecos: "root", home: "/root", shell: "/bin/sh" },
    { username: "user1000", uid: 1000, gid: 1000, gecos: "user1000", home: "/home/user1000", shell: "/bin/sh" },
    { username: "user1001", uid: 1001, gid: 1001, gecos: "user1001", home: "/home/user1001", shell: "/bin/sh" },
    { username: "user1000-agent", uid: 2000, gid: 2000, gecos: "user1000 agent", home: "/home/user1000-agent", shell: "/bin/init" },
    { username: "helper-agent", uid: 2001, gid: 2001, gecos: "helper agent", home: "/home/helper-agent", shell: "/bin/init" },
  ];
  const groupEntries = [
    { name: "helper-agent", gid: 2001, members: ["user1000"] },
  ];

  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  return {
    peer: testPeer({ kind: ownerUid === undefined ? "human" : "process", account: {
        uid,
        gid: uid,
        gids: [uid],
        username: uid === 0 ? "root" : `user${uid}`,
        home: uid === 0 ? "/root" : `/home/user${uid}`,
        cwd: uid === 0 ? "/root" : `/home/user${uid}`,
      }, calls: ["*"] }),
    callerOwnerUid: ownerUid,
    processId: ownerUid === undefined ? undefined : "proc:agent",
    responsibilities: { getByDedupeKey: () => null },
    reconcileResponsibilityWake: vi.fn(async () => {}),
    procs: {
      getOwnerUid: () => ownerUid ?? null,
    },
    auth: {
      getPasswdByUid: (searchUid: number) =>
        passwdEntries.find((entry) => entry.uid === searchUid) ?? null,
      getPersonalAgentUid: (searchOwnerUid: number) => searchOwnerUid === 1000 ? 2000 : null,
      getGroupByGid: (gid: number) =>
        groupEntries.find((entry) => entry.gid === gid) ?? null,
      getGroupByName: (name: string) =>
        groupEntries.find((entry) => entry.name === name) ?? null,
    },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    config: config as KernelContext["config"],
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  } as KernelContext;
}

describe("sys.config.get", () => {
  it("keeps a dismissed UI card on the person's account", async () => {
    const ctx = makeContext(1000, {});
    const key = "users/1000/ui/welcome_card_seen";
    expect(handleSysConfigGet({ key }, ctx).entries).toEqual([]);
    expect(await handleSysConfigSet({ key, value: "1" }, ctx)).toEqual({ ok: true });
    expect(handleSysConfigGet({ key }, ctx).entries).toEqual([{ key, value: "1" }]);
    await expect(handleSysConfigSet({ key: "users/1001/ui/welcome_card_seen", value: "1" }, ctx)).rejects.toThrow("another user's");
  });

  it("wakes onboarding on owner dismissal, with safe retries after a scheduling failure", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = makeContext(1000, {});
      ctx.responsibilities = new ResponsibilityStore(storage);
      const seed = ensureInitialOnboardingResponsibility(1000, ctx.responsibilities).record;
      const reconcile = vi.fn(async () => {}).mockRejectedValueOnce(new Error("wake unavailable"));
      ctx.reconcileResponsibilityWake = reconcile;
      const args = { key: "users/1000/ui/welcome_card_seen", value: "1" };
      expect(ctx.responsibilities.nextWakeAt(1000, Date.now())).toBeNull();
      await expect(handleSysConfigSet(args, ctx)).rejects.toThrow("wake unavailable");
      expect(ctx.config.get(args.key)).toBe("1");
      expect(ctx.responsibilities.get(1000, seed.id)?.state).toBe("open");
      const revision = ctx.responsibilities.revision(1000);
      await handleSysConfigSet(args, ctx);
      expect(ctx.responsibilities.revision(1000)).toBe(revision);
      expect(reconcile).toHaveBeenCalledTimes(2);
      expect(reconcile).toHaveBeenLastCalledWith(1000);

      ctx.responsibilities.update({ ownerUid: 1000, id: seed.id,
        patch: { state: "waiting", blocker: "Waiting for a reply", nextCheckAtMs: null },
        actor: { kind: "process", processId: "ship" }, observedByShip: true, now: Date.now() });
      await handleSysConfigSet(args, ctx);
      expect(ctx.responsibilities.nextWakeAt(1000, Date.now())).toBeNull();
      expect(ctx.responsibilities.get(1000, seed.id)?.blocker).toBe("Waiting for a reply");
      expect(reconcile).toHaveBeenCalledTimes(2);
    });
  });

  it("does not treat other config writes or delegated writes as the owner's dismissal", async () => {
    for (const [uid, ownerUid, key, value] of [
      [1000, undefined, "users/1000/ui/welcome_card_seen", "0"],
      [1000, undefined, "users/1000/ui/avatar", "1"],
      [0, undefined, "users/1000/ui/welcome_card_seen", "1"],
      [2000, 1000, "users/1000/ui/welcome_card_seen", "1"],
    ] as const) {
      const ctx = makeContext(uid, {}, ownerUid);
      await handleSysConfigSet({ key, value }, ctx);
      expect(ctx.reconcileResponsibilityWake).not.toHaveBeenCalled();
    }
  });

  it("lets humans change only their own timezone without system write access", async () => {
    const ctx = makeContext(1000, {});
    expect(await handleSysConfigSet({ key: "users/1000/locale/timezone", value: "Europe/Amsterdam" }, ctx)).toEqual({ ok: true });
    await expect(handleSysConfigSet({ key: "users/1001/locale/timezone", value: "UTC" }, ctx)).rejects.toThrow("another user's");
    await expect(handleSysConfigSet({ key: "config/server/timezone", value: "UTC" }, ctx)).rejects.toThrow("only root");
  });
  it("allows only the owner or their agent to manage their language preference", async () => {
    const key = "users/1000/locale/language";
    expect(await handleSysConfigSet({ key, value: "es-MX" }, makeContext(1000, {}))).toEqual({ ok: true });
    expect(await handleSysConfigSet({ key, value: "es" }, makeContext(2000, {}, 1000))).toEqual({ ok: true });
    await expect(handleSysConfigSet({ key, value: "fr" }, makeContext(1001, {}))).rejects.toThrow("another user");
  });
  const baseEntries = {
    "config/ai/models": JSON.stringify({
      version: 1,
      models: [{ id: "system", name: "System", provider: "openrouter", model: "qwen" }],
    }),
    "config/ai/models/system/api_key": "sk-live",
    "users/1000/ai/preferred_model": "system",
    "users/1001/ai/preferred_model": "other",
  } satisfies EntryMap;

  it("blocks non-root exact reads of sensitive system config", () => {
    const ctx = makeContext(1000, baseEntries);
    expect(() => handleSysConfigGet({ key: "config/ai/models/system/api_key" }, ctx)).toThrow(
      "Permission denied: cannot read config/ai/models/system/api_key",
    );
  });

  it("hides sensitive keys from non-root prefix listings", () => {
    const ctx = makeContext(1000, baseEntries);
    const result = handleSysConfigGet({ key: "config/ai" }, ctx);
    expect(result.entries.map((entry) => entry.key)).toEqual([
      "config/ai/models",
    ]);
  });

  it("allows root reads of sensitive system config", () => {
    const ctx = makeContext(0, baseEntries);
    const result = handleSysConfigGet({ key: "config/ai/models/system/api_key" }, ctx);
    expect(result.entries).toEqual([{
      key: "config/ai/models/system/api_key",
      value: "sk-live",
    }]);
  });

  it("allows non-root users to read delegated agent AI config", () => {
    const ctx = makeContext(1000, {
      ...baseEntries,
      "users/2000/ai/preferred_model": "agent-model",
      "users/2000/secret/token": "hidden",
      "users/2001/ai/tools/approval": '{"default":"ask"}',
    });

    const result = handleSysConfigGet({}, ctx);
    expect(result.entries.map((entry) => entry.key)).toEqual([
      "config/ai/models",
      "users/1000/ai/preferred_model",
      "users/2000/ai/preferred_model",
      "users/2001/ai/tools/approval",
    ]);
  });

  it("allows owner-backed process callers to write delegated agent AI config", async () => {
    const ctx = makeContext(2000, baseEntries, 1000);

    expect(await handleSysConfigSet({
      key: "users/2001/ai/preferred_model",
      value: "helper-model",
    }, ctx)).toEqual({ ok: true });
    expect(handleSysConfigGet({ key: "users/2001/ai/preferred_model" }, ctx)).toEqual({
      entries: [{ key: "users/2001/ai/preferred_model", value: "helper-model" }],
    });
  });

  it("deletes blank user AI overrides so they inherit defaults", async () => {
    const ctx = makeContext(1000, {
      ...baseEntries,
      "users/2000/ai/preferred_model": "agent-model",
    });

    expect(await handleSysConfigSet({
      key: "users/2000/ai/preferred_model",
      value: "   ",
    }, ctx)).toEqual({ ok: true });
    expect(handleSysConfigGet({ key: "users/2000/ai/preferred_model" }, ctx)).toEqual({
      entries: [],
    });
  });

  it("copies a readable model credential to another model entry", async () => {
    const ctx = makeContext(1000, {
      ...baseEntries,
      "users/1000/ai/models": JSON.stringify({
        version: 1,
        models: [
          { id: "fast", name: "Fast", provider: "openai", model: "gpt-5" },
          { id: "backup", name: "Backup", provider: "openai", model: "gpt-5-mini" },
        ],
      }),
      "users/1000/ai/models/fast/api_key": "sk-model",
    });

    expect(await handleSysConfigSet({
      key: "users/1000/ai/models/backup/api_key",
      copyFromKey: "users/1000/ai/models/fast/api_key",
    }, ctx)).toEqual({ ok: true });
    expect(handleSysConfigGet({ key: "users/1000/ai/models/backup/api_key" }, ctx)).toEqual({
      entries: [{ key: "users/1000/ai/models/backup/api_key", value: "sk-model" }],
    });
  });

  it("rejects copies from config keys the caller cannot read", async () => {
    const ctx = makeContext(1000, baseEntries);

    await expect(handleSysConfigSet({
      key: "users/1000/ai/models/backup/api_key",
      copyFromKey: "config/ai/models/system/api_key",
    }, ctx)).rejects.toThrow("Permission denied: cannot read config/ai/models/system/api_key");
  });

  it("rejects delegated writes outside user-overridable config", async () => {
    const ctx = makeContext(1000, baseEntries);

    await expect(handleSysConfigSet({
      key: "users/2000/secret/token",
      value: "secret",
    }, ctx)).rejects.toThrow("not user-overridable");
  });

  it("allows delegated writes to ui presentation prefs (e.g. the agent avatar)", async () => {
    const ctx = makeContext(1000, baseEntries);

    expect(await handleSysConfigSet({
      key: "users/2000/ui/avatar",
      value: "/img/agent-3.png",
    }, ctx)).toEqual({ ok: true });
    expect(handleSysConfigGet({ key: "users/2000/ui/avatar" }, ctx)).toEqual({
      entries: [{ key: "users/2000/ui/avatar", value: "/img/agent-3.png" }],
    });
  });

  it("rejects writes to accounts the owner cannot manage", async () => {
    const ctx = makeContext(1000, baseEntries);

    await expect(handleSysConfigSet({
      key: "users/1001/ai/preferred_model",
      value: "foreign-model",
    }, ctx)).rejects.toThrow("cannot write another user's config");
  });
});
