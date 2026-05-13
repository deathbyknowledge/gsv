import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "../context";
import { handleSysSetup } from "./setup";
import { SocialStore } from "../social";
import type { PdsEnsureAccountInput, PdsPutRecordInput, PdsServiceBinding } from "../../pds/client";
import { SPACE_GSV_AGENT_CARD, SPACE_GSV_INSTANCE, SPACE_GSV_PROFILE } from "@gsv/protocol/syscalls/social";

type Row = Record<string, unknown>;

function createMockSql() {
  const tables = new Map<string, Row[]>();

  function getTable(name: string): Row[] {
    if (!tables.has(name)) {
      tables.set(name, []);
    }
    return tables.get(name)!;
  }

  function cursor<T>(rows: T[]) {
    return {
      toArray: () => rows,
      [Symbol.iterator]: function* () {
        yield* rows;
      },
    };
  }

  function exec<T = Row>(query: string, ...bindings: unknown[]) {
    const q = query.trim();
    if (q.startsWith("CREATE TABLE IF NOT EXISTS")) {
      const match = q.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
      if (match) getTable(match[1]);
      return cursor<T>([]);
    }
    if (q.startsWith("CREATE INDEX IF NOT EXISTS")) {
      return cursor<T>([]);
    }
    if (q.startsWith("SELECT * FROM social_identities WHERE uid = ?")) {
      const [uid] = bindings as [number];
      return cursor(getTable("social_identities").filter((row) => row.uid === uid) as T[]);
    }
    if (q.startsWith("SELECT * FROM social_identities WHERE handle = ?")) {
      const [handle] = bindings as [string];
      return cursor(getTable("social_identities").filter((row) => row.handle === handle) as T[]);
    }
    if (q.startsWith("SELECT * FROM social_identities ORDER BY uid ASC LIMIT 1")) {
      return cursor(
        [...getTable("social_identities")]
          .sort((left, right) => Number(left.uid) - Number(right.uid))
          .slice(0, 1) as T[],
      );
    }
    if (q.startsWith("INSERT OR REPLACE INTO social_identities")) {
      const [uid, did, handle, pds_endpoint, created_at, updated_at] = bindings as [
        number,
        string,
        string | null,
        string,
        number,
        number,
      ];
      const table = getTable("social_identities");
      const existing = table.findIndex((row) => row.uid === uid);
      const row = { uid, did, handle, pds_endpoint, created_at, updated_at };
      if (existing >= 0) table[existing] = row;
      else table.push(row);
      return cursor<T>([]);
    }
    if (q.startsWith("SELECT * FROM social_records WHERE uid = ?")) {
      const [uid, collection, rkey] = bindings as [number, string, string];
      return cursor(getTable("social_records").filter((row) =>
        row.uid === uid && row.collection === collection && row.rkey === rkey
      ) as T[]);
    }
    if (q.startsWith("INSERT OR REPLACE INTO social_records")) {
      const [uid, collection, rkey, uri, cid, record_json, created_at, updated_at] = bindings as [
        number,
        string,
        string,
        string | null,
        string | null,
        string,
        number,
        number,
      ];
      const table = getTable("social_records");
      const existing = table.findIndex((row) =>
        row.uid === uid && row.collection === collection && row.rkey === rkey
      );
      const row = { uid, collection, rkey, uri, cid, record_json, created_at, updated_at };
      if (existing >= 0) table[existing] = row;
      else table.push(row);
      return cursor<T>([]);
    }
    if (q.startsWith("SELECT * FROM social_settings WHERE uid = ?")) {
      const [uid] = bindings as [number];
      return cursor(getTable("social_settings").filter((row) => row.uid === uid) as T[]);
    }
    if (q.startsWith("INSERT OR REPLACE INTO social_settings")) {
      const [uid, service_private_jwk_json, service_public_key_multibase, created_at, updated_at] = bindings as [
        number,
        string,
        string,
        number,
        number,
      ];
      const table = getTable("social_settings");
      const existing = table.findIndex((row) => row.uid === uid);
      const row = { uid, service_private_jwk_json, service_public_key_multibase, created_at, updated_at };
      if (existing >= 0) table[existing] = row;
      else table.push(row);
      return cursor<T>([]);
    }
    if (q.startsWith("CREATE UNIQUE INDEX IF NOT EXISTS")) {
      return cursor<T>([]);
    }
    if (q.startsWith("ALTER TABLE social_messages ADD COLUMN")) {
      return cursor<T>([]);
    }
    throw new Error(`Unhandled SQL: ${q}`);
  }

  return { exec };
}

function createCtx(overrides?: { setupMode?: boolean; pds?: Partial<PdsServiceBinding> }) {
  const usersGroup = { name: "users", gid: 100, members: [] as string[] };
  const passwd: Array<{ username: string; uid: number }> = [{ username: "root", uid: 0 }];
  const shadowRoot = { username: "root", hash: "!" };

  const auth = {
    isSetupMode: vi.fn(() => overrides?.setupMode ?? true),
    getPasswdEntries: vi.fn(() => passwd.map((u) => ({
      username: u.username,
      uid: u.uid,
      gid: u.uid === 0 ? 0 : 100,
      gecos: u.username,
      home: u.uid === 0 ? "/root" : `/home/${u.username}`,
      shell: "/bin/init",
    }))),
    getPasswdByUsername: vi.fn((username: string) =>
      passwd.find((u) => u.username === username)
        ? {
            username,
            uid: 1000,
            gid: 100,
            gecos: username,
            home: `/home/${username}`,
            shell: "/bin/init",
          }
        : null),
    nextUid: vi.fn(() => 1000),
    addUser: vi.fn((entry: { username: string; uid: number }) => passwd.push({
      username: entry.username,
      uid: entry.uid,
    })),
    setShadow: vi.fn(),
    getGroupByName: vi.fn((name: string) => (name === "users" ? usersGroup : null)),
    updateGroupMembers: vi.fn((name: string, members: string[]) => {
      if (name === "users") usersGroup.members = members;
      return true;
    }),
    setPassword: vi.fn(async () => true),
    issueToken: vi.fn(async () => ({
      tokenId: "tok-1",
      token: "gsv_node_abc",
      tokenPrefix: "gsv_node_abc",
      uid: 1000,
      kind: "node" as const,
      label: "node:macbook",
      allowedRole: "driver" as const,
      allowedDeviceId: "macbook",
      createdAt: 1_700_000_000_000,
      expiresAt: null,
    })),
    resolveGids: vi.fn(() => [100]),
    getShadowByUsername: vi.fn((username: string) => (username === "root" ? shadowRoot : null)),
  };

  const config = {
    set: vi.fn(),
  };

  const storage = {
    head: vi.fn(async () => null),
    put: vi.fn(async () => {}),
  };

  const ctx = {
    auth: auth as unknown as KernelContext["auth"],
    config: config as unknown as KernelContext["config"],
    env: { STORAGE: storage, PDS: overrides?.pds } as unknown as KernelContext["env"],
    social: (() => {
      const social = new SocialStore(createMockSql() as unknown as SqlStorage);
      social.init();
      return social;
    })(),
  } as KernelContext;

  return { ctx, auth, config, storage, usersGroup };
}

describe("handleSysSetup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates first user, ai config, and node token", async () => {
    const { ctx, auth, config, storage, usersGroup } = createCtx();

    const result = await handleSysSetup(
      {
        username: "alice",
        password: "password-123",
        ai: {
          provider: "openrouter",
          model: "qwen/qwen3.5-35b-a3b",
          apiKey: "or-key",
        },
        timezone: "Europe/Amsterdam",
        node: {
          deviceId: "macbook",
        },
      },
      ctx,
    );

    expect(auth.addUser).toHaveBeenCalledWith(
      expect.objectContaining({
        username: "alice",
        uid: 1000,
        gid: 100,
        home: "/home/alice",
      }),
    );
    expect(usersGroup.members).toContain("alice");
    expect(config.set).toHaveBeenCalledWith("config/ai/provider", "openrouter");
    expect(config.set).toHaveBeenCalledWith("config/ai/model", "qwen/qwen3.5-35b-a3b");
    expect(config.set).toHaveBeenCalledWith("config/ai/api_key", "or-key");
    expect(config.set).toHaveBeenCalledWith("config/server/timezone", "Europe/Amsterdam");
    expect(storage.put).toHaveBeenCalledWith(
      "home/alice/.dir",
      expect.any(ArrayBuffer),
      expect.any(Object),
    );
    expect(result.user.username).toBe("alice");
    expect(result.nodeToken?.allowedDeviceId).toBe("macbook");
  });

  it("can set up the builtin social PDS during onboarding", async () => {
    const accountCalls: PdsEnsureAccountInput[] = [];
    const putCalls: PdsPutRecordInput[] = [];
    const { ctx } = createCtx({
      pds: {
        pdsEnsureAccount: async (input: PdsEnsureAccountInput) => {
          accountCalls.push(input);
          return {
            did: "did:web:gsv.example",
            handle: "gsv.example",
            created: false,
          };
        },
        pdsPutRecord: async (input: PdsPutRecordInput) => {
          putCalls.push(input);
          return {
            uri: `at://${input.repo}/${input.collection}/${input.rkey}`,
            cid: `bafy-${input.collection.replace(/\./g, "-")}`,
          };
        },
      },
    });

    const result = await handleSysSetup(
      {
        username: "alice",
        password: "password-123",
        social: {
          origin: "https://gsv.example",
          displayName: "Alice",
        },
      },
      ctx,
    );

    expect(accountCalls).toHaveLength(1);
    expect(accountCalls[0]).toMatchObject({
      host: "gsv.example",
      handle: "gsv.example",
      did: "did:web:gsv.example",
    });
    expect(result.social?.identity.handle).toBe("gsv.example");
    expect(result.social?.identity).not.toHaveProperty("did");
    expect(result.social?.identity.profile?.displayName).toBe("Alice");
    expect(putCalls.map((call) => call.collection)).toEqual([
      SPACE_GSV_PROFILE,
      SPACE_GSV_INSTANCE,
      SPACE_GSV_AGENT_CARD,
    ]);
  });

  it("rejects when setup mode is already completed", async () => {
    const { ctx } = createCtx({ setupMode: false });

    await expect(handleSysSetup(
      {
        username: "alice",
        password: "password-123",
      },
      ctx,
    )).rejects.toThrow("System already initialized");
  });

  it("requires a valid username and password", async () => {
    const { ctx } = createCtx();

    await expect(handleSysSetup(
      {
        username: "Bad Name",
        password: "short",
      },
      ctx,
    )).rejects.toThrow("username must match");
  });

  it("rejects an invalid timezone", async () => {
    const { ctx } = createCtx();

    await expect(handleSysSetup(
      {
        username: "alice",
        password: "password-123",
        timezone: "Not/AZone",
      },
      ctx,
    )).rejects.toThrow("timezone must be a valid IANA timezone");
  });

  it("sets root password when provided", async () => {
    const { ctx, auth } = createCtx();

    await handleSysSetup(
      {
        username: "alice",
        password: "password-123",
        rootPassword: "root-password-123",
      },
      ctx,
    );

    expect(auth.setPassword).toHaveBeenCalledWith("root", expect.any(String));
  });
});
