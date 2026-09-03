import { describe, expect, it } from "vitest";
import type { KernelContext } from "../context";
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
    identity: {
      role: "user",
      process: {
        uid,
        gid: uid,
        gids: [uid],
        username: uid === 0 ? "root" : `user${uid}`,
        home: uid === 0 ? "/root" : `/home/user${uid}`,
        cwd: uid === 0 ? "/root" : `/home/user${uid}`,
      },
      capabilities: ["*"],
    },
    callerOwnerUid: ownerUid,
    processId: ownerUid === undefined ? undefined : "proc:agent",
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

  it("allows owner-backed process callers to write delegated agent AI config", () => {
    const ctx = makeContext(2000, baseEntries, 1000);

    expect(handleSysConfigSet({
      key: "users/2001/ai/preferred_model",
      value: "helper-model",
    }, ctx)).toEqual({ ok: true });
    expect(handleSysConfigGet({ key: "users/2001/ai/preferred_model" }, ctx)).toEqual({
      entries: [{ key: "users/2001/ai/preferred_model", value: "helper-model" }],
    });
  });

  it("deletes blank user AI overrides so they inherit defaults", () => {
    const ctx = makeContext(1000, {
      ...baseEntries,
      "users/2000/ai/preferred_model": "agent-model",
    });

    expect(handleSysConfigSet({
      key: "users/2000/ai/preferred_model",
      value: "   ",
    }, ctx)).toEqual({ ok: true });
    expect(handleSysConfigGet({ key: "users/2000/ai/preferred_model" }, ctx)).toEqual({
      entries: [],
    });
  });

  it("copies a readable model credential to another model entry", () => {
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

    expect(handleSysConfigSet({
      key: "users/1000/ai/models/backup/api_key",
      copyFromKey: "users/1000/ai/models/fast/api_key",
    }, ctx)).toEqual({ ok: true });
    expect(handleSysConfigGet({ key: "users/1000/ai/models/backup/api_key" }, ctx)).toEqual({
      entries: [{ key: "users/1000/ai/models/backup/api_key", value: "sk-model" }],
    });
  });

  it("rejects copies from config keys the caller cannot read", () => {
    const ctx = makeContext(1000, baseEntries);

    expect(() => handleSysConfigSet({
      key: "users/1000/ai/models/backup/api_key",
      copyFromKey: "config/ai/models/system/api_key",
    }, ctx)).toThrow("Permission denied: cannot read config/ai/models/system/api_key");
  });

  it("rejects delegated writes outside user-overridable config", () => {
    const ctx = makeContext(1000, baseEntries);

    expect(() => handleSysConfigSet({
      key: "users/2000/secret/token",
      value: "secret",
    }, ctx)).toThrow("not user-overridable");
  });

  it("allows delegated writes to ui presentation prefs (e.g. the agent avatar)", () => {
    const ctx = makeContext(1000, baseEntries);

    expect(handleSysConfigSet({
      key: "users/2000/ui/avatar",
      value: "/img/agent-3.png",
    }, ctx)).toEqual({ ok: true });
    expect(handleSysConfigGet({ key: "users/2000/ui/avatar" }, ctx)).toEqual({
      entries: [{ key: "users/2000/ui/avatar", value: "/img/agent-3.png" }],
    });
  });

  it("rejects writes to accounts the owner cannot manage", () => {
    const ctx = makeContext(1000, baseEntries);

    expect(() => handleSysConfigSet({
      key: "users/1001/ai/preferred_model",
      value: "foreign-model",
    }, ctx)).toThrow("cannot write another user's config");
  });
});
