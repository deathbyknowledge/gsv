import { describe, expect, it, vi } from "vitest";
import {
  MANAGED_SETUP_TOKEN_POLICY_KEY,
  SetupTokenPolicyStore,
} from "./setup-token-policy";
import {
  parseSetupTokenPolicy,
  type SetupTokenPolicy,
} from "../auth/setup-token-policy";
import { authorizeSetupToken } from "../auth/setup-token";

const version2: SetupTokenPolicy = {
  version: 2,
  hash: "b".repeat(64),
  expiresAt: 2_000_000_000_000,
};
const version3: SetupTokenPolicy = {
  version: 3,
  hash: "c".repeat(64),
  expiresAt: 2_000_000_001_000,
};

describe("SetupTokenPolicyStore", () => {
  it("persists a higher version and acknowledges an identical retry", () => {
    const { store, values, put } = createStore();

    expect(store.install(version2)).toEqual({
      ok: true,
      disposition: "installed",
      policy: version2,
    });
    expect(store.install(version2)).toEqual({
      ok: true,
      disposition: "unchanged",
      policy: version2,
    });
    expect(values.get(MANAGED_SETUP_TOKEN_POLICY_KEY)).toEqual(version2);
    expect(put).toHaveBeenCalledOnce();
  });

  it("keeps version 3 authorized when a late version 2 install arrives", () => {
    const { store, values, put } = createStore(version2);

    expect(store.install(version3)).toMatchObject({ ok: true, disposition: "installed" });
    expect(store.install(version2)).toEqual({
      ok: false,
      reason: "stale_version",
      currentVersion: 3,
    });
    expect(store.current()).toEqual(version3);
    expect(values.get(MANAGED_SETUP_TOKEN_POLICY_KEY)).toEqual(version3);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("keeps the version 3 token accepted after a late version 2 request", async () => {
    const token2 = "A".repeat(43);
    const token3 = "B".repeat(43);
    const policy2 = { ...version2, hash: await sha256Hex(token2) };
    const policy3 = { ...version3, hash: await sha256Hex(token3) };
    const { store } = createStore(policy2);

    expect(store.install(policy3)).toMatchObject({ ok: true });
    expect(store.install(policy2)).toMatchObject({ ok: false, reason: "stale_version" });
    await expect(authorizeSetupToken(
      {} as Env,
      token3,
      1_000,
      store.current(),
    )).resolves.toBeUndefined();
    await expect(authorizeSetupToken(
      {} as Env,
      token2,
      1_000,
      store.current(),
    )).rejects.toMatchObject({ status: 403 });
  });

  it("rejects conflicting contents at the same version", () => {
    const { store, put } = createStore(version3);

    expect(store.install({ ...version3, hash: "d".repeat(64) })).toEqual({
      ok: false,
      reason: "version_conflict",
      currentVersion: 3,
    });
    expect(store.current()).toEqual(version3);
    expect(put).not.toHaveBeenCalled();
  });

  it("does not update its cache when persistence fails", () => {
    const { store, put } = createStore(version2);
    put.mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    expect(() => store.install(version3)).toThrow("storage unavailable");
    expect(store.current()).toEqual(version2);
  });
});

describe("parseSetupTokenPolicy", () => {
  it("rejects unknown fields and malformed finite state", () => {
    for (const value of [
      { ...version2, extra: true },
      { ...version2, version: 0 },
      { ...version2, version: 1.5 },
      { ...version2, hash: "B".repeat(64) },
      { ...version2, expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() => parseSetupTokenPolicy(value)).toThrow("Invalid managed setup-token policy");
    }
  });
});

function createStore(initial?: SetupTokenPolicy): {
  store: SetupTokenPolicyStore;
  values: Map<string, unknown>;
  put: ReturnType<typeof vi.fn>;
} {
  const values = new Map<string, unknown>();
  if (initial) values.set(MANAGED_SETUP_TOKEN_POLICY_KEY, initial);
  const put = vi.fn((key: string, value: unknown) => {
    values.set(key, structuredClone(value));
  });
  const storage = {
    kv: {
      get: <T>(key: string) => values.get(key) as T | undefined,
      put,
      delete: (key: string) => values.delete(key),
    },
  } as unknown as DurableObjectStorage;
  return { store: new SetupTokenPolicyStore(storage), values, put };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
