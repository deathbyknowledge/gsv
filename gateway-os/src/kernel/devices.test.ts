import { describe, it, expect, beforeEach } from "vitest";
import { DeviceRegistry } from "./devices";

type Row = Record<string, unknown>;

function createMockSql() {
  const tables = new Map<string, Row[]>();

  function getTable(name: string): Row[] {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  }

  function exec<T = Row>(query: string, ...bindings: unknown[]) {
    const q = query.trim();

    if (q.startsWith("CREATE TABLE IF NOT EXISTS")) {
      const match = q.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
      if (match) getTable(match[1]);
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("INSERT OR IGNORE INTO device_access")) {
      const table = getTable("device_access");
      const [deviceId, gid] = bindings as [string, number];
      const exists = table.some(
        (r) => r.device_id === deviceId && r.gid === gid,
      );
      if (!exists) table.push({ device_id: deviceId, gid });
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("INSERT INTO devices")) {
      const table = getTable("devices");
      const [device_id, owner_uid, implements_, platform, version, , first_seen_at, last_seen_at, connected_at] =
        bindings as [string, number, string, string, string, number, number, number, number];
      table.push({
        device_id,
        owner_uid,
        implements: implements_,
        platform,
        version,
        online: 1,
        first_seen_at,
        last_seen_at,
        connected_at,
        disconnected_at: null,
      });
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("UPDATE devices SET\n          owner_uid")) {
      const table = getTable("devices");
      const [owner_uid, implements_, platform, version, last_seen_at, connected_at, device_id] =
        bindings as [number, string, string, string, number, number, string];
      const row = table.find((r) => r.device_id === device_id);
      if (row) {
        row.owner_uid = owner_uid;
        row.implements = implements_;
        row.platform = platform;
        row.version = version;
        row.online = 1;
        row.last_seen_at = last_seen_at;
        row.connected_at = connected_at;
        row.disconnected_at = null;
      }
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("UPDATE devices SET online = 1")) {
      const table = getTable("devices");
      const [connected_at, , device_id] = bindings as [number, number, string];
      const row = table.find((r) => r.device_id === device_id);
      if (row) {
        row.online = 1;
        row.connected_at = connected_at;
        row.disconnected_at = null;
        row.last_seen_at = connected_at;
      }
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("UPDATE devices SET online = 0")) {
      const table = getTable("devices");
      const [disconnected_at, last_seen_at, device_id] = bindings as [number, number, string];
      const row = table.find((r) => r.device_id === device_id);
      if (row) {
        row.online = 0;
        row.disconnected_at = disconnected_at;
        row.last_seen_at = last_seen_at;
      }
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("SELECT * FROM devices WHERE device_id")) {
      const table = getTable("devices");
      const [deviceId] = bindings as [string];
      const rows = table.filter((r) => r.device_id === deviceId);
      return { toArray: () => rows as T[] };
    }

    if (q.startsWith("SELECT * FROM devices ORDER BY")) {
      const table = getTable("devices");
      const sorted = [...table].sort((a, b) =>
        (a.device_id as string).localeCompare(b.device_id as string),
      );
      return { toArray: () => sorted as T[] };
    }

    if (q.startsWith("SELECT DISTINCT d.* FROM devices")) {
      const table = getTable("devices");
      const accessTable = getTable("device_access");
      const [ownerUid, ...gids] = bindings as [number, ...number[]];
      const seen = new Set<string>();
      const results: Row[] = [];
      for (const row of table) {
        const id = row.device_id as string;
        if (seen.has(id)) continue;
        if (row.owner_uid === ownerUid) {
          seen.add(id);
          results.push(row);
          continue;
        }
        for (const access of accessTable) {
          if (access.device_id === id && gids.includes(access.gid as number)) {
            seen.add(id);
            results.push(row);
            break;
          }
        }
      }
      results.sort((a, b) =>
        (a.device_id as string).localeCompare(b.device_id as string),
      );
      return { toArray: () => results as T[] };
    }

    if (q.startsWith("SELECT * FROM devices WHERE owner_uid")) {
      const table = getTable("devices");
      const [ownerUid] = bindings as [number];
      const rows = table
        .filter((r) => r.owner_uid === ownerUid)
        .sort((a, b) =>
          (a.device_id as string).localeCompare(b.device_id as string),
        );
      return { toArray: () => rows as T[] };
    }

    if (q.startsWith("SELECT * FROM devices WHERE online")) {
      const table = getTable("devices");
      const rows = table
        .filter((r) => r.online === 1)
        .sort((a, b) => (a.device_id as string).localeCompare(b.device_id as string));
      return { toArray: () => rows as T[] };
    }

    if (q.startsWith("SELECT gid FROM device_access WHERE device_id = ? AND gid IN")) {
      const table = getTable("device_access");
      const [deviceId, ...gids] = bindings as [string, ...number[]];
      const rows = table.filter(
        (r) => r.device_id === deviceId && gids.includes(r.gid as number),
      );
      return { toArray: () => rows as T[] };
    }

    if (q.startsWith("SELECT gid FROM device_access WHERE device_id = ? ORDER")) {
      const table = getTable("device_access");
      const [deviceId] = bindings as [string];
      const rows = table
        .filter((r) => r.device_id === deviceId)
        .sort((a, b) => (a.gid as number) - (b.gid as number));
      return { toArray: () => rows as T[] };
    }

    if (q.startsWith("DELETE FROM device_access")) {
      const table = getTable("device_access");
      const [deviceId, gid] = bindings as [string, number];
      const idx = table.findIndex(
        (r) => r.device_id === deviceId && r.gid === gid,
      );
      if (idx >= 0) table.splice(idx, 1);
      return { toArray: () => [] as T[] };
    }

    return { toArray: () => [] as T[] };
  }

  return { exec };
}

describe("DeviceRegistry", () => {
  let registry: DeviceRegistry;

  beforeEach(() => {
    const sql = createMockSql();
    registry = new DeviceRegistry(sql);
    registry.init();
  });

  it("registers a new device", () => {
    const result = registry.register("macbook", 1000, 1000, ["fs.*", "proc.*"], "darwin-arm64", "0.1.0");
    expect(result.ok).toBe(true);

    const device = registry.get("macbook");
    expect(device).not.toBeNull();
    expect(device!.device_id).toBe("macbook");
    expect(device!.owner_uid).toBe(1000);
    expect(device!.implements).toEqual(["fs.*", "proc.*"]);
    expect(device!.online).toBe(true);
  });

  it("rejects invalid implements patterns", () => {
    const result = registry.register("bad", 1000, 1000, ["not valid!"], "linux", "0.1.0");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Invalid implements pattern");
  });

  it("re-registers an existing device (reconnect)", () => {
    registry.register("server", 1000, 1000, ["fs.*"], "linux", "0.1.0");
    registry.setOnline("server", false);

    const device = registry.get("server");
    expect(device!.online).toBe(false);

    registry.register("server", 1000, 1000, ["fs.*", "proc.*"], "linux", "0.2.0");
    const updated = registry.get("server");
    expect(updated!.online).toBe(true);
    expect(updated!.version).toBe("0.2.0");
    expect(updated!.implements).toEqual(["fs.*", "proc.*"]);
  });

  it("marks a device disconnected", () => {
    registry.register("macbook", 1000, 1000, ["fs.*"], "darwin", "0.1.0");
    registry.setOnline("macbook", false);

    const device = registry.get("macbook");
    expect(device!.online).toBe(false);
    expect(device!.disconnected_at).not.toBeNull();
  });

  it("listOnline returns only online devices", () => {
    registry.register("a", 1000, 1000, ["fs.*"], "darwin", "0.1.0");
    registry.register("b", 1000, 1000, ["proc.*"], "linux", "0.1.0");
    registry.setOnline("b", false);

    const online = registry.listOnline();
    expect(online).toHaveLength(1);
    expect(online[0].device_id).toBe("a");
  });

  it("returns null for unknown device", () => {
    expect(registry.get("nonexistent")).toBeNull();
  });

  it("creates default access for owner's gid on register", () => {
    registry.register("macbook", 1000, 1000, ["fs.*"], "darwin", "0.1.0");
    const access = registry.listAccess("macbook");
    expect(access).toEqual([1000]);
  });

  it("canAccess grants root (uid 0) unconditionally", () => {
    registry.register("macbook", 1000, 1000, ["fs.*"], "darwin", "0.1.0");
    expect(registry.canAccess("macbook", 0, [0])).toBe(true);
  });

  it("canAccess grants owner", () => {
    registry.register("macbook", 1000, 1000, ["fs.*"], "darwin", "0.1.0");
    expect(registry.canAccess("macbook", 1000, [1000])).toBe(true);
  });

  it("canAccess grants group members", () => {
    registry.register("team-server", 0, 0, ["fs.*"], "linux", "0.1.0");
    registry.grantAccess("team-server", 100); // users group

    expect(registry.canAccess("team-server", 1000, [1000, 100])).toBe(true);
    expect(registry.canAccess("team-server", 1001, [1001, 200])).toBe(false);
  });

  it("canAccess denies non-owner non-group user", () => {
    registry.register("alice-laptop", 1001, 1001, ["fs.*"], "darwin", "0.1.0");
    expect(registry.canAccess("alice-laptop", 1000, [1000, 100])).toBe(false);
  });

  it("canHandle checks implements patterns", () => {
    registry.register("macbook", 1000, 1000, ["fs.*", "proc.exec"], "darwin", "0.1.0");

    expect(registry.canHandle("macbook", "fs.read")).toBe(true);
    expect(registry.canHandle("macbook", "fs.write")).toBe(true);
    expect(registry.canHandle("macbook", "proc.exec")).toBe(true);
    expect(registry.canHandle("macbook", "proc.list")).toBe(false);
    expect(registry.canHandle("macbook", "ipc.send")).toBe(false);
  });

  it("findDevice finds accessible device that implements syscall", () => {
    registry.register("macbook", 1000, 1000, ["fs.*"], "darwin", "0.1.0");
    registry.register("server", 0, 0, ["fs.*", "proc.*"], "linux", "0.1.0");
    registry.grantAccess("server", 100);

    const device = registry.findDevice("proc.exec", 1000, [1000, 100]);
    expect(device).not.toBeNull();
    expect(device!.device_id).toBe("server");
  });

  it("findDevice returns null when no device matches", () => {
    registry.register("macbook", 1000, 1000, ["fs.*"], "darwin", "0.1.0");
    expect(registry.findDevice("ipc.send", 1000, [1000])).toBeNull();
  });

  it("grantAccess and revokeAccess work", () => {
    registry.register("server", 0, 0, ["fs.*"], "linux", "0.1.0");
    registry.grantAccess("server", 100);
    expect(registry.listAccess("server")).toEqual([0, 100]);

    registry.revokeAccess("server", 100);
    expect(registry.listAccess("server")).toEqual([0]);
  });

  it("listForUser returns owned and group-accessible devices", () => {
    registry.register("sam-laptop", 1000, 1000, ["fs.*"], "darwin", "0.1.0");
    registry.register("alice-laptop", 1001, 1001, ["fs.*"], "darwin", "0.1.0");
    registry.register("team-server", 0, 0, ["fs.*", "proc.*"], "linux", "0.1.0");
    registry.grantAccess("team-server", 100);

    const samDevices = registry.listForUser(1000, [1000, 100]);
    const ids = samDevices.map((d) => d.device_id);
    expect(ids).toContain("sam-laptop");
    expect(ids).toContain("team-server");
    expect(ids).not.toContain("alice-laptop");
  });

  it("listForUser root sees all devices", () => {
    registry.register("a", 1000, 1000, ["fs.*"], "darwin", "0.1.0");
    registry.register("b", 1001, 1001, ["proc.*"], "linux", "0.1.0");

    const all = registry.listForUser(0, [0]);
    expect(all).toHaveLength(2);
  });

  it("listForUser with no group access returns only owned", () => {
    registry.register("mine", 1000, 1000, ["fs.*"], "darwin", "0.1.0");
    registry.register("not-mine", 1001, 1001, ["fs.*"], "darwin", "0.1.0");

    const devices = registry.listForUser(1000, []);
    expect(devices).toHaveLength(1);
    expect(devices[0].device_id).toBe("mine");
  });
});
