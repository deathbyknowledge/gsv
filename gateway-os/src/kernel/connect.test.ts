import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { handleConnect } from "./connect";
import type { KernelContext } from "./context";
import { CapabilityStore } from "./capabilities";
import { DeviceRegistry } from "./devices";
import { ensureBootstrapped } from "../auth";
import { hashToken, hashPassword } from "../auth/shadow";

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
    if (q.startsWith("SELECT COUNT")) {
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

    return { toArray: () => [] as T[] };
  }

  return { exec };
}

const mockConnection = {
  send: () => {},
  close: () => {},
  state: {},
  setState: () => {},
} as any;

function makeCtx(sql: ReturnType<typeof createMockSql>): KernelContext {
  const caps = new CapabilityStore(sql);
  caps.init();

  const devices = new DeviceRegistry(sql);
  devices.init();

  return {
    env: env as any,
    caps,
    devices,
    connection: mockConnection,
    serverVersion: "0.0.1-test",
  };
}

async function cleanR2() {
  const listed = await env.STORAGE.list({ prefix: "/etc/" });
  for (const obj of listed.objects) {
    await env.STORAGE.delete(obj.key);
  }
}

describe("handleConnect", () => {
  let sql: ReturnType<typeof createMockSql>;

  beforeEach(async () => {
    sql = createMockSql();
    await cleanR2();
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

  it("grants root on first boot (setup mode, no auth)", async () => {
    const ctx = makeCtx(sql);
    const result = await handleConnect(
      { protocol: 1, client: { id: "c1", version: "1", platform: "test", role: "user" } },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.role).toBe("user");
      expect(result.identity.process.uid).toBe(0);
      expect(result.identity.process.username).toBe("root");
      expect(result.identity.capabilities).toContain("*");
    }
  });

  it("rejects no-auth after root has a token", async () => {
    const token = "my-root-token";
    const hash = await hashToken(token);
    await ensureBootstrapped(env.STORAGE, undefined);

    // Manually update shadow to set a real hash for root
    const shadowObj = await env.STORAGE.get("/etc/shadow");
    const shadowRaw = await shadowObj!.text();
    const updatedShadow = shadowRaw.replace(/!/, hash);
    await env.STORAGE.put("/etc/shadow", updatedShadow, {
      httpMetadata: { contentType: "text/plain" },
      customMetadata: { owner: "0", gid: "0", mode: "640" },
    });

    const ctx = makeCtx(sql);
    const result = await handleConnect(
      { protocol: 1, client: { id: "c1", version: "1", platform: "test", role: "user" } },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(401);
  });

  it("authenticates with valid token", async () => {
    const token = "root-secret";
    await ensureBootstrapped(env.STORAGE, token);

    const ctx = makeCtx(sql);
    ctx.caps.seed();

    const result = await handleConnect(
      {
        protocol: 1,
        client: { id: "c1", version: "1", platform: "test", role: "user" },
        auth: { username: "root", token },
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
    await ensureBootstrapped(env.STORAGE, "correct-token");

    const ctx = makeCtx(sql);
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
    await ensureBootstrapped(env.STORAGE, "root-token");

    const ctx = makeCtx(sql);
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
    const result = await handleConnect(
      {
        protocol: 1,
        client: { id: "macbook", version: "1", platform: "darwin", role: "driver" },
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
    const result = await handleConnect(
      {
        protocol: 1,
        client: { id: "macbook", version: "1", platform: "darwin-arm64", role: "driver" },
        driver: { implements: ["fs.*", "proc.*"] },
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
    const result = await handleConnect(
      {
        protocol: 1,
        client: { id: "macbook", version: "1", platform: "darwin", role: "driver" },
        driver: { implements: ["not valid!"] },
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(103);
  });

  it("service role requires channel", async () => {
    const ctx = makeCtx(sql);
    const result = await handleConnect(
      {
        protocol: 1,
        client: { id: "wa-1", version: "1", platform: "worker", role: "service" },
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(103);
  });

  it("service role succeeds with channel", async () => {
    const ctx = makeCtx(sql);
    const result = await handleConnect(
      {
        protocol: 1,
        client: { id: "wa-1", version: "1", platform: "worker", role: "service", channel: "whatsapp" },
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
    // Bootstrap with no token (locked root)
    await ensureBootstrapped(env.STORAGE);

    // Set a password hash for root manually
    const pwHash = await hashPassword("hunter2");
    const shadowObj = await env.STORAGE.get("/etc/shadow");
    const shadowRaw = await shadowObj!.text();
    const updatedShadow = shadowRaw.replace(/!/, pwHash);
    await env.STORAGE.put("/etc/shadow", updatedShadow, {
      httpMetadata: { contentType: "text/plain" },
      customMetadata: { owner: "0", gid: "0", mode: "640" },
    });

    const ctx = makeCtx(sql);
    ctx.caps.seed();

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
});
