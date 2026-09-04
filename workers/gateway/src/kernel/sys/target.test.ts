import { describe, expect, it, vi } from "vitest";
import type { KernelContext } from "../context";
import {
  handleSysTargetDelete,
  handleSysTargetList,
  handleSysTargetGet,
  handleSysTargetUpdate,
} from "./target";

type FakeTargetRecord = {
  target_id: string;
  owner_uid: number;
  label: string;
  description: string;
  implements: string[];
  platform: string;
  version: string;
  online: boolean;
  first_seen_at: number;
  last_seen_at: number;
  connected_at: number | null;
  disconnected_at: number | null;
};

function makeContext(
  uid: number,
  records: FakeTargetRecord[],
  accessibleDeviceIds: string[] = [],
): KernelContext {
  const byId = new Map(records.map((record) => [record.target_id, record]));

  const devices = {
    listForUser() {
      return records;
    },
    canAccess(targetId: string) {
      if (uid === 0) {
        return true;
      }
      const record = byId.get(targetId);
      return record ? record.owner_uid === uid || accessibleDeviceIds.includes(targetId) : false;
    },
    get(targetId: string) {
      return byId.get(targetId) ?? null;
    },
    setMetadata(targetId: string, patch: { label?: string; description?: string }) {
      const record = byId.get(targetId);
      if (!record) {
        return false;
      }
      if (patch.label !== undefined) {
        record.label = patch.label.trim().slice(0, 120) || record.target_id;
      }
      if (patch.description !== undefined) {
        record.description = patch.description.trim().slice(0, 500);
      }
      return true;
    },
    remove: vi.fn((targetId: string) => byId.delete(targetId)),
  };
  const tokens = [
    {
      tokenId: "tok-active-alpha",
      uid,
      kind: "machine",
      label: null,
      tokenPrefix: "alpha",
      peerId: "node-alpha",
      createdAt: 1,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      revokedReason: null,
    },
    {
      tokenId: "tok-revoked-alpha",
      uid,
      kind: "machine",
      label: null,
      tokenPrefix: "alpha-old",
      peerId: "node-alpha",
      createdAt: 1,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: 2,
      revokedReason: "old",
    },
    {
      tokenId: "tok-beta",
      uid,
      kind: "machine",
      label: null,
      tokenPrefix: "beta",
      peerId: "node-beta",
      createdAt: 1,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      revokedReason: null,
    },
  ];
  const listTokens = vi.fn(() => tokens);
  const revokeToken = vi.fn(() => true);

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
    auth: {
      getPasswdByUid: (lookupUid: number) => ({
        uid: lookupUid,
        gid: lookupUid,
        username: lookupUid === 0 ? "root" : `user${lookupUid}`,
        gecos: "",
        home: lookupUid === 0 ? "/root" : `/home/user${lookupUid}`,
        shell: "/bin/init",
      }),
      listTokens,
      revokeToken,
    },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    targets: devices as KernelContext["targets"],
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  } as KernelContext;
}

describe("sys.target handlers", () => {
  const records: FakeTargetRecord[] = [
    {
      target_id: "node-alpha",
      owner_uid: 1000,
      label: "Alpha",
      description: "Linux home server",
      implements: ["fs.*", "shell.*"],
      platform: "linux",
      version: "1.0.0",
      online: true,
      first_seen_at: 1_700_000_000_000,
      last_seen_at: 1_700_000_010_000,
      connected_at: 1_700_000_005_000,
      disconnected_at: null,
    },
    {
      target_id: "node-beta",
      owner_uid: 1000,
      label: "Beta",
      description: "",
      implements: ["shell.*"],
      platform: "darwin",
      version: "1.1.0",
      online: false,
      first_seen_at: 1_700_000_000_500,
      last_seen_at: 1_700_000_020_000,
      connected_at: null,
      disconnected_at: 1_700_000_019_000,
    },
  ];

  it("lists only online devices by default", () => {
    const ctx = makeContext(1000, records);
    const result = handleSysTargetList({}, ctx);
    expect(result.targets.map((device) => device.targetId)).toEqual(["node-alpha"]);
    expect(result.targets[0].label).toBe("Alpha");
    expect(result.targets[0].description).toBe("Linux home server");
    expect(result.targets[0].implements).toEqual(["fs.*", "shell.*"]);
  });

  it("accepts empty args payloads for list", () => {
    const ctx = makeContext(1000, records);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const result = handleSysTargetList(undefined as { includeOffline?: boolean }, ctx);
    expect(result.targets.map((device) => device.targetId)).toEqual(["node-alpha"]);
  });

  it("includes offline devices when requested", () => {
    const ctx = makeContext(1000, records);
    const result = handleSysTargetList({ includeOffline: true }, ctx);
    expect(result.targets.map((device) => device.targetId)).toEqual(["node-alpha", "node-beta"]);
  });

  it("returns null for inaccessible device details", () => {
    const ctx = makeContext(1001, records);
    const result = handleSysTargetGet({ targetId: "node-alpha" }, ctx);
    expect(result).toEqual({ target: null });
  });

  it("rejects missing targetId in detail lookup", () => {
    const ctx = makeContext(1000, records);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    expect(() => handleSysTargetGet(undefined as { targetId: string }, ctx)).toThrow(
      "sys.target.get requires targetId",
    );
  });

  it("returns detailed device metadata for accessible devices", () => {
    const ctx = makeContext(1000, records);
    const result = handleSysTargetGet({ targetId: "node-alpha" }, ctx);

    expect(result.target?.targetId).toBe("node-alpha");
    expect(result.target?.implements).toEqual(["fs.*", "shell.*"]);
    expect(result.target?.online).toBe(true);
    expect(result.target?.ownerUid).toBe(1000);
    expect(result.target?.label).toBe("Alpha");
    expect(result.target?.description).toBe("Linux home server");
  });

  it("lets owners update device descriptions", () => {
    const ctx = makeContext(1000, records.map((record) => ({ ...record })));
    const result = handleSysTargetUpdate({
      targetId: "node-alpha",
      description: "GPU and home automation box",
    }, ctx);

    expect(result.target?.description).toBe("GPU and home automation box");
  });

  it("lets owners update device labels", () => {
    const ctx = makeContext(1000, records.map((record) => ({ ...record })));
    const result = handleSysTargetUpdate({
      targetId: "node-alpha",
      label: "New Alpha",
    }, ctx);

    expect(result.target?.label).toBe("New Alpha");
  });

  it("rejects metadata updates from group-only users", () => {
    const ctx = makeContext(1001, records, ["node-alpha"]);
    expect(() => handleSysTargetUpdate({
      targetId: "node-alpha",
      description: "not mine",
    }, ctx)).toThrow("Permission denied: device metadata is owner-managed");
  });

  it("deletes an owned physical machine and revokes active node tokens", () => {
    const ctx = makeContext(1000, records.map((record) => ({ ...record })));
    const result = handleSysTargetDelete({ targetId: "node-alpha" }, ctx);

    expect(result).toEqual({
      deleted: true,
      targetId: "node-alpha",
      revokedTokens: 1,
    });
    expect(ctx.targets.remove).toHaveBeenCalledWith("node-alpha");
    expect(ctx.auth.revokeToken).toHaveBeenCalledWith("tok-active-alpha", "machine forgotten", 1000);
    expect(ctx.auth.revokeToken).toHaveBeenCalledTimes(1);
  });

  it("rejects deleting a shared machine owned by another user", () => {
    const ctx = makeContext(1001, records.map((record) => ({ ...record })), ["node-alpha"]);

    expect(() => handleSysTargetDelete({ targetId: "node-alpha" }, ctx)).toThrow(
      "Permission denied: machine forgetting is owner-managed",
    );
    expect(ctx.targets.remove).not.toHaveBeenCalled();
  });
});
