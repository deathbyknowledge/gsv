import { describe, expect, it } from "vitest";
import type { KernelContext } from "../context";
import {
  handleSysDeviceList,
  handleSysDeviceGet,
  handleSysDeviceUpdate,
} from "./device";

type FakeDeviceRecord = {
  device_id: string;
  owner_uid: number;
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

function makeContext(uid: number, records: FakeDeviceRecord[], accessibleDeviceIds: string[] = []): KernelContext {
  const byId = new Map(records.map((record) => [record.device_id, record]));

  const devices = {
    listForUser() {
      return records;
    },
    canAccess(deviceId: string) {
      if (uid === 0) {
        return true;
      }
      const record = byId.get(deviceId);
      return record ? record.owner_uid === uid || accessibleDeviceIds.includes(deviceId) : false;
    },
    get(deviceId: string) {
      return byId.get(deviceId) ?? null;
    },
    setDescription(deviceId: string, description: string) {
      const record = byId.get(deviceId);
      if (!record) {
        return false;
      }
      record.description = description.trim().slice(0, 500);
      return true;
    },
  };

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
        workspaceId: null,
      },
      capabilities: ["*"],
    },
    devices: devices as unknown as KernelContext["devices"],
  } as KernelContext;
}

describe("sys.device handlers", () => {
  const records: FakeDeviceRecord[] = [
    {
      device_id: "node-alpha",
      owner_uid: 1000,
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
      device_id: "node-beta",
      owner_uid: 1000,
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
    const result = handleSysDeviceList({}, ctx);
    expect(result.devices.map((device) => device.deviceId)).toEqual(["node-alpha"]);
    expect(result.devices[0].description).toBe("Linux home server");
  });

  it("accepts empty args payloads for list", () => {
    const ctx = makeContext(1000, records);
    const result = handleSysDeviceList(undefined as unknown as { includeOffline?: boolean }, ctx);
    expect(result.devices.map((device) => device.deviceId)).toEqual(["node-alpha"]);
  });

  it("includes offline devices when requested", () => {
    const ctx = makeContext(1000, records);
    const result = handleSysDeviceList({ includeOffline: true }, ctx);
    expect(result.devices.map((device) => device.deviceId)).toEqual(["node-alpha", "node-beta"]);
  });

  it("returns null for inaccessible device details", () => {
    const ctx = makeContext(1001, records);
    const result = handleSysDeviceGet({ deviceId: "node-alpha" }, ctx);
    expect(result).toEqual({ device: null });
  });

  it("rejects missing deviceId in detail lookup", () => {
    const ctx = makeContext(1000, records);
    expect(() => handleSysDeviceGet(undefined as unknown as { deviceId: string }, ctx)).toThrow(
      "sys.device.get requires deviceId",
    );
  });

  it("returns detailed device metadata for accessible devices", () => {
    const ctx = makeContext(1000, records);
    const result = handleSysDeviceGet({ deviceId: "node-alpha" }, ctx);

    expect(result.device?.deviceId).toBe("node-alpha");
    expect(result.device?.implements).toEqual(["fs.*", "shell.*"]);
    expect(result.device?.online).toBe(true);
    expect(result.device?.ownerUid).toBe(1000);
    expect(result.device?.description).toBe("Linux home server");
  });

  it("lets owners update device descriptions", () => {
    const ctx = makeContext(1000, records.map((record) => ({ ...record })));
    const result = handleSysDeviceUpdate({
      deviceId: "node-alpha",
      description: "GPU and home automation box",
    }, ctx);

    expect(result.device?.description).toBe("GPU and home automation box");
  });

  it("rejects metadata updates from group-only users", () => {
    const ctx = makeContext(1001, records, ["node-alpha"]);
    expect(() => handleSysDeviceUpdate({
      deviceId: "node-alpha",
      description: "not mine",
    }, ctx)).toThrow("Permission denied: device metadata is owner-managed");
  });
});
