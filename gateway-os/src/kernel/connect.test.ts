import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { handleConnect } from "./connect";
import type { KernelContext } from "./context";
import { AuthStore } from "./auth-store";
import { CapabilityStore } from "./capabilities";
import { ConfigStore } from "./config";
import { DeviceRegistry } from "./devices";
import { ProcessRegistry } from "./processes";
import { hashPassword } from "../auth/shadow";

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

    // CapabilityStore queries
    if (q.startsWith("SELECT COUNT") && q.includes("group_capabilities")) {
      const table = getTable("group_capabilities");
      return { toArray: () => [{ cnt: table.length }] as T[] };
    }

    if (q.startsWith("INSERT INTO group_capabilities")) {
      const table = getTable("group_capabilities");
      const [gid, capability] = bindings as [number, string];
      table.push({ gid, capability });
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("SELECT DISTINCT capability")) {
      const table = getTable("group_capabilities");
      const gids = bindings as number[];
      const caps = new Set<string>();
      for (const row of table) {
        if (gids.includes(row.gid as number)) caps.add(row.capability as string);
      }
      return {
        toArray: () => Array.from(caps).map((c) => ({ capability: c })) as T[],
      };
    }

    // DeviceRegistry queries
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

    if (q.startsWith("SELECT * FROM devices WHERE device_id")) {
      const table = getTable("devices");
      const [deviceId] = bindings as [string];
      const rows = table.filter((r) => r.device_id === deviceId);
      return { toArray: () => rows as T[] };
    }

    // ConfigStore queries
    if (q.startsWith("INSERT OR REPLACE INTO config_kv")) {
      const table = getTable("config_kv");
      const [key, value] = bindings as [string, string];
      const idx = table.findIndex((row) => row.key === key);
      if (idx >= 0) table[idx] = { key, value };
      else table.push({ key, value });
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("INSERT OR IGNORE INTO config_kv")) {
      const table = getTable("config_kv");
      const [key, value] = bindings as [string, string];
      const exists = table.some((row) => row.key === key);
      if (!exists) table.push({ key, value });
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("SELECT value FROM config_kv WHERE key = ?")) {
      const table = getTable("config_kv");
      const [key] = bindings as [string];
      const row = table.find((record) => record.key === key);
      const rows = row ? [{ value: row.value as string }] : [];
      return { toArray: () => rows as T[] };
    }

    // AuthStore - auth_tokens
    if (q.startsWith("INSERT INTO auth_tokens")) {
      const table = getTable("auth_tokens");
      const [
        token_id,
        uid,
        kind,
        label,
        token_hash,
        token_prefix,
        allowed_role,
        allowed_device_id,
        created_at,
        expires_at,
      ] = bindings as [
        string,
        number,
        string,
        string | null,
        string,
        string,
        string | null,
        string | null,
        number,
        number | null,
      ];
      table.push({
        token_id,
        uid,
        kind,
        label,
        token_hash,
        token_prefix,
        allowed_role,
        allowed_device_id,
        created_at,
        last_used_at: null,
        expires_at,
        revoked_at: null,
        revoked_reason: null,
      });
      return { toArray: () => [] as T[] };
    }

    if (q.includes("FROM auth_tokens") && q.includes("WHERE uid = ? AND token_hash = ?")) {
      const table = getTable("auth_tokens");
      const [uid, tokenHash] = bindings as [number, string];
      const rows = table
        .filter((row) => row.uid === uid && row.token_hash === tokenHash)
        .slice(0, 1)
        .map((row) => ({
          token_id: row.token_id as string,
          allowed_role: (row.allowed_role as string | null) ?? null,
          allowed_device_id: (row.allowed_device_id as string | null) ?? null,
          expires_at: (row.expires_at as number | null) ?? null,
          revoked_at: (row.revoked_at as number | null) ?? null,
        }));
      return { toArray: () => rows as T[] };
    }

    if (q.startsWith("UPDATE auth_tokens SET last_used_at = ? WHERE token_id = ?")) {
      const table = getTable("auth_tokens");
      const [lastUsedAt, tokenId] = bindings as [number, string];
      const row = table.find((record) => record.token_id === tokenId);
      if (row) row.last_used_at = lastUsedAt;
      return { toArray: () => [] as T[] };
    }

    // AuthStore - passwd
    if (q.startsWith("SELECT COUNT") && q.includes("passwd")) {
      const table = getTable("passwd");
      return { toArray: () => [{ c: table.length }] as T[] };
    }

    if (q.startsWith("INSERT INTO passwd")) {
      const table = getTable("passwd");
      const [username, uid, gid, gecos, home, shell] = bindings as [string, number, number, string, string, string];
      table.push({ username, uid, gid, gecos, home, shell });
      return { toArray: () => [] as T[] };
    }

    if (q.includes("FROM passwd WHERE username")) {
      const table = getTable("passwd");
      const [username] = bindings as [string];
      return { toArray: () => table.filter(r => r.username === username) as T[] };
    }

    if (q.includes("FROM passwd WHERE uid")) {
      const table = getTable("passwd");
      const [uid] = bindings as [number];
      return { toArray: () => table.filter(r => r.uid === uid) as T[] };
    }

    if (q.includes("FROM passwd ORDER BY")) {
      const table = getTable("passwd");
      return { toArray: () => [...table].sort((a, b) => (a.uid as number) - (b.uid as number)) as T[] };
    }

    if (q.includes("MAX(uid)")) {
      const table = getTable("passwd");
      const max = table.reduce((m, r) => Math.max(m, r.uid as number), 0);
      return { toArray: () => [{ m: table.length > 0 ? max : null }] as T[] };
    }

    // AuthStore - shadow
    if (q.startsWith("INSERT OR REPLACE INTO shadow")) {
      const table = getTable("shadow");
      const [username, hash, lastchanged, min, max, warn, inactive, expire, reserved] =
        bindings as string[];
      const existing = table.findIndex(r => r.username === username);
      const entry = { username, hash, lastchanged, min, max, warn, inactive, expire, reserved };
      if (existing >= 0) table[existing] = entry;
      else table.push(entry);
      return { toArray: () => [] as T[] };
    }

    if (q.includes("FROM shadow WHERE username")) {
      const table = getTable("shadow");
      const [username] = bindings as [string];
      return { toArray: () => table.filter(r => r.username === username) as T[] };
    }

    if (q.includes("FROM shadow ORDER BY")) {
      const table = getTable("shadow");
      return { toArray: () => [...table] as T[] };
    }

    if (q.includes("UPDATE shadow SET")) {
      const table = getTable("shadow");
      const [hash, lastchanged, username] = bindings as [string, string, string];
      const entry = table.find(r => r.username === username);
      if (entry) { entry.hash = hash; entry.lastchanged = lastchanged; }
      return { toArray: () => [] as T[] };
    }

    // AuthStore - groups
    if (q.startsWith("INSERT INTO groups")) {
      const table = getTable("groups");
      const [name, gid, members] = bindings as [string, number, string];
      table.push({ name, gid, members });
      return { toArray: () => [] as T[] };
    }

    if (q.includes("FROM groups WHERE name")) {
      const table = getTable("groups");
      const [name] = bindings as [string];
      return { toArray: () => table.filter(r => r.name === name) as T[] };
    }

    if (q.includes("FROM groups WHERE gid")) {
      const table = getTable("groups");
      const [gid] = bindings as [number];
      return { toArray: () => table.filter(r => r.gid === gid) as T[] };
    }

    if (q.includes("FROM groups ORDER BY")) {
      const table = getTable("groups");
      return { toArray: () => [...table].sort((a, b) => (a.gid as number) - (b.gid as number)) as T[] };
    }

    if (q.includes("MAX(gid)")) {
      const table = getTable("groups");
      const max = table.reduce((m, r) => Math.max(m, r.gid as number), 0);
      return { toArray: () => [{ m: table.length > 0 ? max : null }] as T[] };
    }

    // DELETE
    if (q.startsWith("DELETE FROM")) {
      const tableMatch = q.match(/DELETE FROM (\w+)/);
      if (tableMatch) {
        const table = getTable(tableMatch[1]);
        if (q.includes("WHERE username")) {
          const [username] = bindings as [string];
          const idx = table.findIndex(r => r.username === username);
          if (idx >= 0) table.splice(idx, 1);
        } else if (q.includes("WHERE name")) {
          const [name] = bindings as [string];
          const idx = table.findIndex(r => r.name === name);
          if (idx >= 0) table.splice(idx, 1);
        } else {
          table.length = 0;
        }
      }
      return { toArray: () => [] as T[] };
    }

    return { toArray: () => [] as T[] };
  }

  return { exec };
}

const mockConnection = {
  send: () => {},
  close: () => {},
  id: "test-conn-1",
  state: {},
  setState: () => {},
} as any;

function makeCtx(sql: ReturnType<typeof createMockSql>): KernelContext {
  const auth = new AuthStore(sql as any);
  auth.init();

  const caps = new CapabilityStore(sql as any);
  caps.init();

  const config = new ConfigStore(sql as any);
  config.init();

  const devices = new DeviceRegistry(sql as any);
  devices.init();

  const procs = new ProcessRegistry(sql as any);
  procs.init();

  return {
    env: env as any,
    auth,
    caps,
    config,
    devices,
    procs,
    connection: mockConnection,
    serverVersion: "0.0.1-test",
  };
}

describe("handleConnect", () => {
  let sql: ReturnType<typeof createMockSql>;

  beforeEach(async () => {
    sql = createMockSql();
  });

  it("rejects unsupported protocol", async () => {
    const ctx = makeCtx(sql);
    const result = await handleConnect(
      { protocol: 99, client: { id: "c1", version: "1", platform: "test", role: "user" } },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(102);
  });

  it("rejects invalid role", async () => {
    const ctx = makeCtx(sql);
    const result = await handleConnect(
      { protocol: 1, client: { id: "c1", version: "1", platform: "test", role: "invalid" as any } },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(103);
  });

  it("returns setup-required details on first boot", async () => {
    const ctx = makeCtx(sql);
    const result = await handleConnect(
      { protocol: 1, client: { id: "c1", version: "1", platform: "test", role: "user" } },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(425);
      expect(result.message).toContain("Setup required");
      expect(result.details).toEqual({ setupMode: true, next: "sys.setup" });
    }
  });

  it("rejects no-auth after setup is completed", async () => {
    const ctx = makeCtx(sql);
    const hash = await hashPassword("root-password");

    await ctx.auth.bootstrap();
    await ctx.auth.setPassword("root", hash);

    const result = await handleConnect(
      { protocol: 1, client: { id: "c1", version: "1", platform: "test", role: "user" } },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(401);
  });

  it("authenticates with valid token", async () => {
    const ctx = makeCtx(sql);
    const rootHash = await hashPassword("root-password");
    await ctx.auth.bootstrap();
    ctx.caps.seed();
    await ctx.auth.setPassword("root", rootHash);
    const issued = await ctx.auth.issueToken({ uid: 0, kind: "user", label: "cli" });

    const result = await handleConnect(
      {
        protocol: 1,
        client: { id: "c1", version: "1", platform: "test", role: "user" },
        auth: { username: "root", token: issued.token },
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.process.uid).toBe(0);
      expect(result.identity.capabilities).toContain("*");
      expect(result.result.protocol).toBe(1);
    }
  });

  it("rejects wrong token", async () => {
    const ctx = makeCtx(sql);
    const rootHash = await hashPassword("root-password");
    await ctx.auth.bootstrap();
    await ctx.auth.setPassword("root", rootHash);
    await ctx.auth.issueToken({ uid: 0, kind: "user", label: "cli" });

    const result = await handleConnect(
      {
        protocol: 1,
        client: { id: "c1", version: "1", platform: "test", role: "user" },
        auth: { username: "root", token: "wrong-token" },
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(401);
  });

  it("rejects unknown user", async () => {
    const ctx = makeCtx(sql);
    const rootHash = await hashPassword("root-password");
    await ctx.auth.bootstrap();
    await ctx.auth.setPassword("root", rootHash);

    const result = await handleConnect(
      {
        protocol: 1,
        client: { id: "c1", version: "1", platform: "test", role: "user" },
        auth: { username: "nobody", token: "anything" },
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(401);
  });

  it("driver role requires implements list", async () => {
    const ctx = makeCtx(sql);
    const rootHash = await hashPassword("root-password");
    await ctx.auth.bootstrap();
    await ctx.auth.setPassword("root", rootHash);
    const issued = await ctx.auth.issueToken({ uid: 0, kind: "node", label: "macbook" });
    const result = await handleConnect(
      {
        protocol: 1,
        client: { id: "macbook", version: "1", platform: "darwin", role: "driver" },
        auth: { username: "root", token: issued.token },
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(103);
      expect(result.message).toContain("implements");
    }
  });

  it("driver role registers device on success", async () => {
    const ctx = makeCtx(sql);
    const hash = await hashPassword("root-password");
    await ctx.auth.bootstrap();
    await ctx.auth.setPassword("root", hash);
    const issued = await ctx.auth.issueToken({
      uid: 0,
      kind: "node",
      label: "macbook",
      allowedDeviceId: "macbook",
    });

    const result = await handleConnect(
      {
        protocol: 1,
        client: { id: "macbook", version: "1", platform: "darwin-arm64", role: "driver" },
        driver: { implements: ["fs.*", "proc.*"] },
        auth: { username: "root", token: issued.token },
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.role).toBe("driver");
      if (result.identity.role === "driver") {
        expect(result.identity.device).toBe("macbook");
        expect(result.identity.implements).toEqual(["fs.*", "proc.*"]);
      }

      const device = ctx.devices.get("macbook");
      expect(device).not.toBeNull();
      expect(device!.online).toBe(true);
    }
  });

  it("driver rejects invalid implements patterns", async () => {
    const ctx = makeCtx(sql);
    const rootHash = await hashPassword("root-password");
    await ctx.auth.bootstrap();
    await ctx.auth.setPassword("root", rootHash);
    const issued = await ctx.auth.issueToken({ uid: 0, kind: "node", label: "macbook" });
    const result = await handleConnect(
      {
        protocol: 1,
        client: { id: "macbook", version: "1", platform: "darwin", role: "driver" },
        driver: { implements: ["not valid!"] },
        auth: { username: "root", token: issued.token },
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(103);
  });

  it("service role requires channel", async () => {
    const ctx = makeCtx(sql);
    const rootHash = await hashPassword("root-password");
    await ctx.auth.bootstrap();
    await ctx.auth.setPassword("root", rootHash);
    const issued = await ctx.auth.issueToken({ uid: 0, kind: "service", label: "svc" });
    const result = await handleConnect(
      {
        protocol: 1,
        client: { id: "wa-1", version: "1", platform: "worker", role: "service" },
        auth: { username: "root", token: issued.token },
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(103);
  });

  it("service role succeeds with channel", async () => {
    const ctx = makeCtx(sql);
    const hash = await hashPassword("root-password");
    await ctx.auth.bootstrap();
    await ctx.auth.setPassword("root", hash);
    const issued = await ctx.auth.issueToken({
      uid: 0,
      kind: "service",
      label: "wa-service",
      allowedRole: "service",
    });

    const result = await handleConnect(
      {
        protocol: 1,
        client: { id: "wa-1", version: "1", platform: "worker", role: "service", channel: "whatsapp" },
        auth: { username: "root", token: issued.token },
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.role).toBe("service");
      if (result.identity.role === "service") {
        expect(result.identity.channel).toBe("whatsapp");
      }
    }
  });

  it("authenticates with password (PBKDF2)", async () => {
    const ctx = makeCtx(sql);
    const pwHash = await hashPassword("hunter2");

    await ctx.auth.bootstrap();
    ctx.caps.seed();
    await ctx.auth.setPassword("root", pwHash);

    const result = await handleConnect(
      {
        protocol: 1,
        client: { id: "c1", version: "1", platform: "test", role: "user" },
        auth: { username: "root", password: "hunter2" },
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.process.uid).toBe(0);
    }
  });

  it("rejects driver password auth when machine-token enforcement is enabled", async () => {
    const ctx = makeCtx(sql);
    const pwHash = await hashPassword("hunter2");
    await ctx.auth.bootstrap();
    ctx.caps.seed();
    await ctx.auth.setPassword("root", pwHash);

    const result = await handleConnect(
      {
        protocol: 1,
        client: { id: "macbook", version: "1", platform: "darwin", role: "driver" },
        driver: { implements: ["fs.*"] },
        auth: { username: "root", password: "hunter2" },
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Token required");
  });

  it("allows driver password auth only when explicitly enabled by config", async () => {
    const ctx = makeCtx(sql);
    const pwHash = await hashPassword("hunter2");
    await ctx.auth.bootstrap();
    ctx.caps.seed();
    await ctx.auth.setPassword("root", pwHash);
    ctx.config.set("config/auth/allow_machine_password", "true");

    const result = await handleConnect(
      {
        protocol: 1,
        client: { id: "macbook", version: "1", platform: "darwin", role: "driver" },
        driver: { implements: ["fs.*"] },
        auth: { username: "root", password: "hunter2" },
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.role).toBe("driver");
    }
  });

  it("rejects driver token when bound to a different device", async () => {
    const ctx = makeCtx(sql);
    const pwHash = await hashPassword("hunter2");
    await ctx.auth.bootstrap();
    ctx.caps.seed();
    await ctx.auth.setPassword("root", pwHash);
    const issued = await ctx.auth.issueToken({
      uid: 0,
      kind: "node",
      label: "laptop",
      allowedDeviceId: "laptop",
    });

    const result = await handleConnect(
      {
        protocol: 1,
        client: { id: "server", version: "1", platform: "linux", role: "driver" },
        driver: { implements: ["fs.*"] },
        auth: { username: "root", token: issued.token },
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(401);
  });
});
