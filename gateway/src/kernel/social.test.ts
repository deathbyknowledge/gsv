import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/utils", () => ({
  sendFrameToProcess: vi.fn(async (_pid: string, frame: { id?: string }) => ({
    type: "res",
    id: frame.id ?? "mock-response",
    ok: true,
    data: { ok: true },
  })),
}));

import {
  handleSocialAgentCardUpdate,
  handleSocialFriendAdd,
  handleSocialFriendGrantsSet,
  handleSocialFriendList,
  handleSocialFriendRemove,
  handleSocialIdentityGet,
  handleSocialIdentitySet,
  handleSocialInbound,
  handleSocialMessageReply,
  handleSocialMessageSend,
  handleSocialSetup,
  handleSocialProfileGet,
  handleSocialProfileUpdate,
  handleSocialThreadCreate,
  handleSocialThreadGet,
  handleSocialThreadList,
  generateP256ServiceKey,
  signSocialEnvelope,
  SocialStore,
} from "./social";
import type { KernelContext } from "./context";
import {
  SPACE_GSV_AGENT_CARD,
  SPACE_GSV_INSTANCE,
  SPACE_GSV_PROFILE,
  type SocialRemoteOperation,
  type SocialSignedRequestEnvelope,
  type SpaceGsvAgentCardRecord,
  type SpaceGsvInstanceRecord,
  type SpaceGsvProfileRecord,
} from "@gsv/protocol/syscalls/social";
import type { PdsEnsureAccountInput, PdsPutRecordInput, PdsServiceBinding } from "../pds/client";
import { sendFrameToProcess } from "../shared/utils";

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

    if (q.startsWith("CREATE UNIQUE INDEX IF NOT EXISTS")) {
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
      if (existing >= 0) {
        table[existing] = row;
      } else {
        table.push(row);
      }
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
      if (existing >= 0) {
        table[existing] = row;
      } else {
        table.push(row);
      }
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
      const row = {
        uid,
        service_private_jwk_json,
        service_public_key_multibase,
        created_at,
        updated_at,
      };
      if (existing >= 0) {
        table[existing] = row;
      } else {
        table.push(row);
      }
      return cursor<T>([]);
    }

    if (q.startsWith("SELECT * FROM social_friends WHERE uid = ? ORDER BY handle ASC")) {
      const [uid] = bindings as [number];
      return cursor(
        getTable("social_friends")
          .filter((row) => row.uid === uid)
          .sort((left, right) => String(left.handle).localeCompare(String(right.handle))) as T[],
      );
    }

    if (q.startsWith("SELECT * FROM social_friends WHERE uid = ? AND handle = ?")) {
      const [uid, handle] = bindings as [number, string];
      return cursor(getTable("social_friends").filter((row) =>
        row.uid === uid && row.handle === handle
      ) as T[]);
    }

    if (q.startsWith("SELECT * FROM social_friends WHERE uid = ? AND did = ?")) {
      const [uid, did] = bindings as [number, string];
      return cursor(getTable("social_friends").filter((row) =>
        row.uid === uid && row.did === did
      ) as T[]);
    }

    if (q.startsWith("INSERT OR REPLACE INTO social_friends")) {
      const [
        uid,
        handle,
        did,
        pds_endpoint,
        display_name,
        profile_json,
        instance_json,
        agent_card_json,
        created_at,
        updated_at,
        synced_at,
      ] = bindings as [
        number,
        string,
        string,
        string,
        string | null,
        string | null,
        string,
        string | null,
        number,
        number,
        number | null,
      ];
      const table = getTable("social_friends");
      const existing = table.findIndex((row) => row.uid === uid && row.handle === handle);
      const row = {
        uid,
        handle,
        did,
        pds_endpoint,
        display_name,
        profile_json,
        instance_json,
        agent_card_json,
        created_at,
        updated_at,
        synced_at,
      };
      if (existing >= 0) {
        table[existing] = row;
      } else {
        table.push(row);
      }
      return cursor<T>([]);
    }

    if (q.startsWith("DELETE FROM social_friend_grants WHERE uid = ? AND friend_handle = ?")) {
      const [uid, friend_handle] = bindings as [number, string];
      const table = getTable("social_friend_grants");
      tables.set("social_friend_grants", table.filter((row) =>
        !(row.uid === uid && row.friend_handle === friend_handle)
      ));
      return cursor<T>([]);
    }

    if (q.startsWith("DELETE FROM social_friends WHERE uid = ? AND handle = ?")) {
      const [uid, handle] = bindings as [number, string];
      const table = getTable("social_friends");
      tables.set("social_friends", table.filter((row) =>
        !(row.uid === uid && row.handle === handle)
      ));
      return cursor<T>([]);
    }

    if (q.startsWith("SELECT * FROM social_friend_grants WHERE uid = ? AND friend_handle = ?")) {
      const [uid, friend_handle] = bindings as [number, string];
      return cursor(
        getTable("social_friend_grants")
          .filter((row) => row.uid === uid && row.friend_handle === friend_handle)
          .sort((left, right) => String(left.operation).localeCompare(String(right.operation))) as T[],
      );
    }

    if (q.startsWith("INSERT OR REPLACE INTO social_friend_grants")) {
      const [uid, friend_handle, operation, scope_json, expires_at, created_at, updated_at] = bindings as [
        number,
        string,
        string,
        string | null,
        string | null,
        number,
        number,
      ];
      const table = getTable("social_friend_grants");
      const existing = table.findIndex((row) =>
        row.uid === uid && row.friend_handle === friend_handle && row.operation === operation
      );
      const row = { uid, friend_handle, operation, scope_json, expires_at, created_at, updated_at };
      if (existing >= 0) {
        table[existing] = row;
      } else {
        table.push(row);
      }
      return cursor<T>([]);
    }

    if (q.startsWith("DELETE FROM social_inbound_replays WHERE uid = ? AND expires_at <= ?")) {
      const [uid, now] = bindings as [number, number];
      const table = getTable("social_inbound_replays");
      tables.set("social_inbound_replays", table.filter((row) =>
        !(row.uid === uid && Number(row.expires_at) <= now)
      ));
      return cursor<T>([]);
    }

    if (q.startsWith("SELECT * FROM social_inbound_replays WHERE uid = ?")) {
      const [uid, envelope_id, nonce] = bindings as [number, string, string];
      return cursor(getTable("social_inbound_replays").filter((row) =>
        row.uid === uid && (row.envelope_id === envelope_id || row.nonce === nonce)
      ) as T[]);
    }

    if (q.startsWith("INSERT INTO social_inbound_replays")) {
      const [uid, envelope_id, nonce, from_handle, method, received_at, expires_at] = bindings as [
        number,
        string,
        string,
        string,
        string,
        number,
        number,
      ];
      const table = getTable("social_inbound_replays");
      if (table.some((row) => row.uid === uid && (row.envelope_id === envelope_id || row.nonce === nonce))) {
        throw new Error("constraint failed");
      }
      table.push({ uid, envelope_id, nonce, from_handle, method, received_at, expires_at });
      return cursor<T>([]);
    }

    if (q.startsWith("SELECT * FROM social_threads WHERE uid = ? AND thread_id = ?")) {
      const [uid, thread_id] = bindings as [number, string];
      return cursor(getTable("social_threads").filter((row) =>
        row.uid === uid && row.thread_id === thread_id
      ) as T[]);
    }

    if (q.startsWith("SELECT * FROM social_threads WHERE uid = ? AND peer_handle = ? AND status = ?")) {
      const [uid, peer_handle, status, limit] = bindings as [number, string, string, number];
      return cursor(
        getTable("social_threads")
          .filter((row) => row.uid === uid && row.peer_handle === peer_handle && row.status === status)
          .sort((left, right) => Number(right.updated_at) - Number(left.updated_at))
          .slice(0, limit) as T[],
      );
    }

    if (q.startsWith("SELECT * FROM social_threads WHERE uid = ? AND peer_handle = ?")) {
      const [uid, peer_handle, limit] = bindings as [number, string, number];
      return cursor(
        getTable("social_threads")
          .filter((row) => row.uid === uid && row.peer_handle === peer_handle)
          .sort((left, right) => Number(right.updated_at) - Number(left.updated_at))
          .slice(0, limit) as T[],
      );
    }

    if (q.startsWith("SELECT * FROM social_threads WHERE uid = ? AND status = ?")) {
      const [uid, status, limit] = bindings as [number, string, number];
      return cursor(
        getTable("social_threads")
          .filter((row) => row.uid === uid && row.status === status)
          .sort((left, right) => Number(right.updated_at) - Number(left.updated_at))
          .slice(0, limit) as T[],
      );
    }

    if (q.startsWith("SELECT * FROM social_threads WHERE uid = ? ORDER BY updated_at DESC")) {
      const [uid, limit] = bindings as [number, number];
      return cursor(
        getTable("social_threads")
          .filter((row) => row.uid === uid)
          .sort((left, right) => Number(right.updated_at) - Number(left.updated_at))
          .slice(0, limit) as T[],
      );
    }

    if (q.startsWith("INSERT OR REPLACE INTO social_threads")) {
      const [
        uid,
        thread_id,
        peer_handle,
        conversation_id,
        status,
        topic,
        created_at,
        updated_at,
        expires_at,
      ] = bindings as [
        number,
        string,
        string,
        string,
        string,
        string | null,
        number,
        number,
        string | null,
      ];
      const table = getTable("social_threads");
      const existing = table.findIndex((row) => row.uid === uid && row.thread_id === thread_id);
      const row = {
        uid,
        thread_id,
        peer_handle,
        conversation_id,
        status,
        topic,
        created_at,
        updated_at,
        expires_at,
      };
      if (existing >= 0) {
        table[existing] = row;
      } else {
        table.push(row);
      }
      return cursor<T>([]);
    }

    if (q.startsWith("SELECT * FROM social_messages WHERE uid = ? AND message_id = ?")) {
      const [uid, message_id] = bindings as [number, string];
      return cursor(getTable("social_messages").filter((row) =>
        row.uid === uid && row.message_id === message_id
      ) as T[]);
    }

    if (q.startsWith("SELECT * FROM social_messages WHERE uid = ? AND remote_event_id = ?")) {
      const [uid, remote_event_id] = bindings as [number, string];
      return cursor(getTable("social_messages").filter((row) =>
        row.uid === uid && row.remote_event_id === remote_event_id
      ) as T[]);
    }

    if (q.startsWith("SELECT * FROM social_messages WHERE uid = ? AND thread_id = ? ORDER BY created_at ASC")) {
      const [uid, thread_id] = bindings as [number, string];
      return cursor(
        getTable("social_messages")
          .filter((row) => row.uid === uid && row.thread_id === thread_id)
          .sort((left, right) => Number(left.created_at) - Number(right.created_at)) as T[],
      );
    }

    if (q.startsWith("INSERT OR REPLACE INTO social_messages")) {
      const [
        uid,
        message_id,
        thread_id,
        direction,
        from_handle,
        to_handle,
        text,
        body_json,
        reply_to_message_id,
        delivery_status,
        remote_event_id,
        created_at,
        updated_at,
      ] = bindings as [
        number,
        string,
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string,
        string | null,
        number,
        number,
      ];
      const table = getTable("social_messages");
      const existing = table.findIndex((row) => row.uid === uid && row.message_id === message_id);
      const row = {
        uid,
        message_id,
        thread_id,
        direction,
        from_handle,
        to_handle,
        text,
        body_json,
        reply_to_message_id,
        delivery_status,
        remote_event_id,
        created_at,
        updated_at,
      };
      if (existing >= 0) {
        table[existing] = row;
      } else {
        table.push(row);
      }
      return cursor<T>([]);
    }

    if (q.startsWith("UPDATE social_messages SET delivery_status = ?")) {
      const [delivery_status, updated_at, uid, message_id] = bindings as [string, number, number, string];
      const row = getTable("social_messages").find((candidate) =>
        candidate.uid === uid && candidate.message_id === message_id
      );
      if (row) {
        row.delivery_status = delivery_status;
        row.updated_at = updated_at;
      }
      return cursor<T>([]);
    }

    if (q.startsWith("INSERT INTO social_delivery_attempts")) {
      const [uid, attempt_id, message_id, status, error, attempted_at, created_at] = bindings as [
        number,
        string,
        string,
        string,
        string | null,
        number,
        number,
      ];
      getTable("social_delivery_attempts").push({
        uid,
        attempt_id,
        message_id,
        status,
        error,
        attempted_at,
        created_at,
      });
      return cursor<T>([]);
    }

    throw new Error(`Unhandled SQL: ${q}`);
  }

  return { exec, tables };
}

function createCtx(
  pds?: Partial<PdsServiceBinding>,
  options: { uid?: number; username?: string; role?: "user" | "service" } = {},
): KernelContext {
  const sql = createMockSql();
  const social = new SocialStore(sql as unknown as SqlStorage);
  social.init();
  const uid = options.uid ?? 1000;
  const username = options.username ?? "hank";
  const processIdentity = {
    uid,
    gid: 100,
    gids: [100],
    username,
    home: `/home/${username}`,
    cwd: `/home/${username}`,
    workspaceId: null,
  };
  const processIdentities = new Map<string, typeof processIdentity>();

  return {
    env: {
      PDS: pds,
    },
    social,
    auth: {
      getPasswdByUid: vi.fn((requestedUid: number) => requestedUid === uid
        ? {
            username,
            uid,
            gid: 100,
            gecos: "",
            home: `/home/${username}`,
            shell: "/bin/gsv",
          }
        : null),
      resolveGids: vi.fn(() => [100]),
    },
    procs: {
      getIdentity: vi.fn((pid: string) => processIdentities.get(pid) ?? null),
      ensureInit: vi.fn((identity: typeof processIdentity) => {
        const pid = `init:${identity.uid}`;
        const created = !processIdentities.has(pid);
        processIdentities.set(pid, identity);
        return { pid, created };
      }),
    },
    identity: {
      role: options.role ?? "user",
      process: processIdentity,
      capabilities: ["social.*"],
    },
  } as unknown as KernelContext;
}

function setContextRole(ctx: KernelContext, role: "user" | "service"): void {
  (ctx.identity as { role: "user" | "service" }).role = role;
}

function stubAlicePublicIdentity(
  publicKeyMultibase: string,
  options: { inbound?: (body: unknown) => Response | Promise<Response> } = {},
): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href === "https://alice.example/.well-known/atproto-did") {
      return new Response("did:web:alice.example");
    }
    const parsed = new URL(href);
    if (parsed.origin === "https://alice.example" && parsed.pathname === "/social/inbound" && options.inbound) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return options.inbound(body);
    }
    const collection = parsed.searchParams.get("collection");
    if (parsed.origin === "https://alice.example" && parsed.pathname === "/xrpc/com.atproto.repo.getRecord") {
      if (collection === SPACE_GSV_PROFILE) {
        return Response.json({
          uri: "at://did:web:alice.example/space.gsv.profile/self",
          cid: "bafy-profile",
          value: {
            $type: SPACE_GSV_PROFILE,
            createdAt: "2026-05-12T12:00:00Z",
            displayName: "Alice",
          },
        });
      }
      if (collection === SPACE_GSV_INSTANCE) {
        return Response.json({
          uri: "at://did:web:alice.example/space.gsv.instance/self",
          cid: "bafy-instance",
          value: {
            $type: SPACE_GSV_INSTANCE,
            createdAt: "2026-05-12T12:00:00Z",
            endpoint: "https://alice.example",
            protocolVersion: 1,
            serviceKey: {
              id: "did:web:alice.example#gsv-social-key",
              type: "Multikey",
              publicKeyMultibase,
            },
            acceptedSocialMethods: [
              "social.thread.create",
              "social.message.send",
              "social.message.reply",
              "social.request.create",
            ],
          },
        });
      }
      if (collection === SPACE_GSV_AGENT_CARD) {
        return Response.json({
          uri: "at://did:web:alice.example/space.gsv.agent.card/self",
          cid: "bafy-agent-card",
          value: {
            $type: SPACE_GSV_AGENT_CARD,
            createdAt: "2026-05-12T12:00:00Z",
            displayName: "Alice's GSV",
            acceptsMessages: true,
            acceptsRequests: true,
          },
        });
      }
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }));
}

async function aliceEnvelope(
  privateJwk: JsonWebKey,
  overrides: Partial<Omit<SocialSignedRequestEnvelope, "signature">> = {},
): Promise<SocialSignedRequestEnvelope> {
  return await signSocialEnvelope({
    id: "env-1",
    method: "social.message.send",
    fromDid: "did:web:alice.example",
    toDid: "did:web:gsv.example",
    createdAt: "2026-05-12T12:00:00Z",
    expiresAt: "2026-05-12T12:10:00Z",
    nonce: "nonce-1",
    keyId: "did:web:alice.example#gsv-social-key",
    body: { text: "hello" },
    ...overrides,
  }, privateJwk);
}

async function setupSignedInboundFriend(grants: Array<{ operation: SocialRemoteOperation; expiresAt?: string }> = [
  { operation: "social.message.send" },
]) {
  const ctx = createCtx();
  handleSocialIdentitySet({
    handle: "gsv.example",
    pdsEndpoint: "https://gsv.example",
  }, ctx);
  const aliceKeys = await generateP256ServiceKey();
  stubAlicePublicIdentity(aliceKeys.publicKeyMultibase);
  await handleSocialFriendAdd({
    handle: "alice.example",
    grants,
  }, ctx);
  setContextRole(ctx, "service");
  return { ctx, aliceKeys };
}

describe("social identity and records", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("sets up the builtin PDS identity and publishes baseline social records", async () => {
    const accountCalls: PdsEnsureAccountInput[] = [];
    const putCalls: PdsPutRecordInput[] = [];
    const ctx = createCtx({
      pdsEnsureAccount: async (input: PdsEnsureAccountInput) => {
        accountCalls.push(input);
        return {
          did: "did:web:gsv.example",
          handle: "gsv.example",
          created: true,
        };
      },
      pdsPutRecord: async (input: PdsPutRecordInput) => {
        putCalls.push(input);
        return {
          uri: `at://${input.repo}/${input.collection}/${input.rkey}`,
          cid: `bafy-${input.collection.replace(/\./g, "-")}`,
        };
      },
    });

    const result = await handleSocialSetup({
      origin: "https://gsv.example/setup?ignored=true",
      displayName: "Hank",
      description: "GSV builder",
    }, ctx);

    expect(accountCalls).toHaveLength(1);
    expect(accountCalls[0]).toMatchObject({
      host: "gsv.example",
      handle: "gsv.example",
      did: "did:web:gsv.example",
    });
    expect(accountCalls[0].password.length).toBeGreaterThan(20);
    expect(result.createdAccount).toBe(true);
    expect(result.identity).toMatchObject({
      uid: 1000,
      handle: "gsv.example",
      pdsEndpoint: "https://gsv.example",
      profile: {
        $type: SPACE_GSV_PROFILE,
        displayName: "Hank",
        description: "GSV builder",
      },
      agentCard: {
        $type: SPACE_GSV_AGENT_CARD,
        acceptsMessages: true,
        acceptsRequests: true,
      },
    });
    expect(result.identity).not.toHaveProperty("did");

    expect(putCalls.map((call) => call.collection)).toEqual([
      SPACE_GSV_PROFILE,
      SPACE_GSV_INSTANCE,
      SPACE_GSV_AGENT_CARD,
    ]);
    for (const call of putCalls) {
      expect(call).toMatchObject({
        host: "gsv.example",
        repo: "did:web:gsv.example",
        rkey: "self",
        validate: true,
      });
    }
    const instance = putCalls.find((call) => call.collection === SPACE_GSV_INSTANCE)?.record as SpaceGsvInstanceRecord;
    expect(instance.endpoint).toBe("https://gsv.example");
    expect(instance.serviceKey.id).toBe("did:web:gsv.example#gsv-social-key");
    expect(instance.serviceKey.type).toBe("Multikey");
    expect(instance.serviceKey.publicKeyMultibase).toMatch(/^z/);
    expect(instance.acceptedSocialMethods).toContain("social.message.send");
  });

  it("limits the builtin social identity to the main GSV user", async () => {
    const ctx = createCtx({
      pdsEnsureAccount: async () => {
        throw new Error("should not call PDS");
      },
    }, { uid: 1001, username: "alice" });

    await expect(handleSocialSetup({
      origin: "https://gsv.example",
    }, ctx)).rejects.toThrow("Social identity is limited to the main GSV user");

    expect(() => handleSocialIdentitySet({
      handle: "gsv.example",
      pdsEndpoint: "https://gsv.example",
    }, ctx)).toThrow("Social identity is limited to the main GSV user");
  });

  it("links and reads the current user's social identity", () => {
    const ctx = createCtx();

    const result = handleSocialIdentitySet({
      handle: "gsv.example",
      pdsEndpoint: "https://gsv.example/xrpc",
    }, ctx);

    expect(result.identity).toMatchObject({
      uid: 1000,
      handle: "gsv.example",
      pdsEndpoint: "https://gsv.example",
    });
    expect(result.identity).not.toHaveProperty("did");
    expect(handleSocialIdentityGet({}, ctx).identity).toMatchObject({
      handle: "gsv.example",
    });
    expect(handleSocialIdentityGet({}, ctx).identity).not.toHaveProperty("did");
  });

  it("publishes profile updates through the PDS RPC binding and stores the result", async () => {
    const calls: PdsPutRecordInput[] = [];
    const ctx = createCtx({
      pdsPutRecord: async (input: PdsPutRecordInput) => {
        calls.push(input);
        return {
          uri: "at://did:web:gsv.example/space.gsv.profile/self",
          cid: "bafy-profile",
          commit: { cid: "bafy-commit", rev: "3lprofile" },
        };
      },
    });
    handleSocialIdentitySet({
      handle: "gsv.example",
      pdsEndpoint: "https://gsv.example",
    }, ctx);

    const record: SpaceGsvProfileRecord = {
      $type: SPACE_GSV_PROFILE,
      createdAt: "2026-05-12T12:00:00Z",
      displayName: "Hank",
      description: "GSV builder",
    };
    const result = await handleSocialProfileUpdate({ record }, ctx);

    expect(calls).toEqual([
      {
        host: "gsv.example",
        repo: "did:web:gsv.example",
        collection: SPACE_GSV_PROFILE,
        rkey: "self",
        record,
        validate: true,
      },
    ]);
    expect(result).toEqual({
      record,
      uri: "at://did:web:gsv.example/space.gsv.profile/self",
    });
    expect(handleSocialProfileGet({}, ctx).profile).toEqual(record);
    expect(handleSocialProfileGet({ handle: "gsv.example" }, ctx).profile).toEqual(record);
  });

  it("requires a linked identity before publishing public records", async () => {
    const ctx = createCtx({
      pdsPutRecord: async () => {
        throw new Error("should not be called");
      },
    });

    await expect(handleSocialProfileUpdate({
      record: {
        $type: SPACE_GSV_PROFILE,
        createdAt: "2026-05-12T12:00:00Z",
      },
    }, ctx)).rejects.toThrow("Social identity is not linked");
  });

  it("validates agent card records before publishing", async () => {
    const ctx = createCtx({
      pdsPutRecord: async () => ({
        uri: "at://did:web:gsv.example/space.gsv.agent.card/self",
        cid: "bafy-card",
      }),
    });
    handleSocialIdentitySet({
      handle: "gsv.example",
      pdsEndpoint: "https://gsv.example",
    }, ctx);

    const record: SpaceGsvAgentCardRecord = {
      $type: SPACE_GSV_AGENT_CARD,
      createdAt: "2026-05-12T12:00:00Z",
      acceptsMessages: true,
      acceptsRequests: true,
      humanEscalation: "sometimes",
    };

    await expect(handleSocialAgentCardUpdate({ record }, ctx)).resolves.toEqual({
      record,
      uri: "at://did:web:gsv.example/space.gsv.agent.card/self",
    });
    await expect(handleSocialAgentCardUpdate({
      record: {
        ...record,
        acceptsMessages: "yes",
      } as unknown as SpaceGsvAgentCardRecord,
    }, ctx)).rejects.toThrow("acceptsMessages must be a boolean");
  });

  it("adds friends by handle, stores public records privately, and manages grants", async () => {
    const ctx = createCtx();
    handleSocialIdentitySet({
      handle: "gsv.example",
      pdsEndpoint: "https://gsv.example",
    }, ctx);

    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href === "https://alice.example/.well-known/atproto-did") {
        return new Response("did:web:alice.example");
      }
      const parsed = new URL(href);
      const collection = parsed.searchParams.get("collection");
      if (parsed.origin === "https://alice.example" && parsed.pathname === "/xrpc/com.atproto.repo.getRecord") {
        if (collection === SPACE_GSV_PROFILE) {
          return Response.json({
            uri: "at://did:web:alice.example/space.gsv.profile/self",
            cid: "bafy-profile",
            value: {
              $type: SPACE_GSV_PROFILE,
              createdAt: "2026-05-12T12:00:00Z",
              displayName: "Alice",
              description: "Builds small agents.",
            },
          });
        }
        if (collection === SPACE_GSV_INSTANCE) {
          return Response.json({
            uri: "at://did:web:alice.example/space.gsv.instance/self",
            cid: "bafy-instance",
            value: {
              $type: SPACE_GSV_INSTANCE,
              createdAt: "2026-05-12T12:00:00Z",
              endpoint: "https://alice.example",
              protocolVersion: 1,
              serviceKey: {
                id: "did:web:alice.example#gsv-social-key",
                type: "Multikey",
                publicKeyMultibase: "zAliceKey",
              },
              acceptedSocialMethods: ["social.message.send", "social.request.create"],
            },
          });
        }
        if (collection === SPACE_GSV_AGENT_CARD) {
          return Response.json({
            uri: "at://did:web:alice.example/space.gsv.agent.card/self",
            cid: "bafy-agent-card",
            value: {
              $type: SPACE_GSV_AGENT_CARD,
              createdAt: "2026-05-12T12:00:00Z",
              displayName: "Alice's GSV",
              summary: "Can talk about projects.",
              acceptsMessages: true,
              acceptsRequests: true,
            },
          });
        }
      }
      return Response.json({ error: "not found" }, { status: 404 });
    }));

    await expect(handleSocialFriendAdd({
      handle: "Alice.Example",
      grants: [{ operation: "social.message.send" }],
    }, ctx)).resolves.toMatchObject({
      created: true,
      friend: {
        handle: "alice.example",
        displayName: "Alice",
        description: "Builds small agents.",
        agentDisplayName: "Alice's GSV",
        acceptsMessages: true,
        acceptsRequests: true,
        acceptedSocialMethods: ["social.message.send", "social.request.create"],
        grants: [{ operation: "social.message.send" }],
      },
    });

    expect(handleSocialFriendList({}, ctx).friends).toHaveLength(1);

    const updated = handleSocialFriendGrantsSet({
      handle: "alice.example",
      grants: [
        {
          operation: "social.request.create",
          scope: { kind: "question" },
          expiresAt: "2027-01-01T00:00:00Z",
        },
      ],
    }, ctx);
    expect(updated.friend.grants).toEqual([
      {
        operation: "social.request.create",
        scope: { kind: "question" },
        expiresAt: "2027-01-01T00:00:00Z",
      },
    ]);

    expect(handleSocialFriendRemove({ handle: "alice.example" }, ctx)).toEqual({ removed: true });
    expect(handleSocialFriendList({}, ctx).friends).toEqual([]);
  });

  it("rejects duplicate or unsupported friend grants", async () => {
    const ctx = createCtx();
    expect(() => handleSocialFriendGrantsSet({
      handle: "alice.example",
      grants: [
        { operation: "social.message.send" },
        { operation: "social.message.send" },
      ],
    }, ctx)).toThrow("duplicate grant operation");
    expect(() => handleSocialFriendGrantsSet({
      handle: "alice.example",
      grants: [{ operation: "fs.read" as never }],
    }, ctx)).toThrow("unsupported grant operation");
  });

  it("does not allow adding the local identity as a friend", async () => {
    const ctx = createCtx();
    handleSocialIdentitySet({
      handle: "gsv.example",
      pdsEndpoint: "https://gsv.example",
    }, ctx);

    await expect(handleSocialFriendAdd({
      handle: "gsv.example",
    }, ctx)).rejects.toThrow("Cannot add the local GSV identity as a friend");
  });

  it("creates, lists, and reads social threads with outbound delivery state", async () => {
    const ctx = createCtx();
    handleSocialIdentitySet({
      handle: "gsv.example",
      pdsEndpoint: "https://gsv.example",
    }, ctx);
    const aliceKeys = await generateP256ServiceKey();
    const inboundBodies: unknown[] = [];
    stubAlicePublicIdentity(aliceKeys.publicKeyMultibase, {
      inbound: (body) => {
        inboundBodies.push(body);
        return Response.json({ ok: true, status: "accepted" });
      },
    });
    await handleSocialFriendAdd({
      handle: "alice.example",
      grants: [{ operation: "social.message.send" }],
    }, ctx);

    const created = await handleSocialThreadCreate({
      peerHandle: "alice.example",
      topic: "Project planning",
      initialMessage: "Can your agent look at this plan?",
    }, ctx);

    expect(created.thread).toMatchObject({
      peerHandle: "alice.example",
      status: "active",
      topic: "Project planning",
    });
    expect(created.thread.conversationId).toBe(`social:alice.example:${created.thread.threadId}`);
    expect(created.initialMessage).toMatchObject({
      threadId: created.thread.threadId,
      direction: "outbound",
      fromHandle: "gsv.example",
      toHandle: "alice.example",
      text: "Can your agent look at this plan?",
      deliveryStatus: "accepted",
    });
    expect(inboundBodies).toHaveLength(1);
    expect((inboundBodies[0] as { envelope: { method: string; body: { threadId: string } } }).envelope).toMatchObject({
      method: "social.thread.create",
      body: { threadId: created.thread.threadId },
    });

    expect(handleSocialThreadList({}, ctx).threads.map((thread) => thread.threadId)).toEqual([
      created.thread.threadId,
    ]);
    expect(handleSocialThreadGet({ threadId: created.thread.threadId }, ctx)).toMatchObject({
      thread: {
        threadId: created.thread.threadId,
        peerHandle: "alice.example",
      },
      messages: [
        {
          threadId: created.thread.threadId,
          deliveryStatus: "accepted",
        },
      ],
      requests: [],
    });
  });

  it("sends and replies to social messages on existing threads", async () => {
    const ctx = createCtx();
    handleSocialIdentitySet({
      handle: "gsv.example",
      pdsEndpoint: "https://gsv.example",
    }, ctx);
    const aliceKeys = await generateP256ServiceKey();
    stubAlicePublicIdentity(aliceKeys.publicKeyMultibase, {
      inbound: () => Response.json({ ok: true, status: "accepted" }),
    });
    await handleSocialFriendAdd({
      handle: "alice.example",
      grants: [{ operation: "social.message.send" }],
    }, ctx);

    const sent = await handleSocialMessageSend({
      toHandle: "alice.example",
      text: "hello from Hank",
      body: { kind: "note", priority: 1 },
    }, ctx);
    expect(sent.message).toMatchObject({
      direction: "outbound",
      text: "hello from Hank",
      body: { kind: "note", priority: 1 },
      deliveryStatus: "accepted",
    });

    const reply = await handleSocialMessageReply({
      threadId: sent.thread.threadId,
      text: "follow-up",
      replyToMessageId: sent.message.messageId,
    }, ctx);
    expect(reply.message).toMatchObject({
      threadId: sent.thread.threadId,
      direction: "outbound",
      text: "follow-up",
      replyToMessageId: sent.message.messageId,
      deliveryStatus: "accepted",
    });
    expect(handleSocialThreadGet({ threadId: sent.thread.threadId }, ctx).messages).toHaveLength(2);
  });

  it("accepts signed inbound envelopes from granted friends idempotently and delivers to init", async () => {
    const { ctx, aliceKeys } = await setupSignedInboundFriend();
    const envelope = await aliceEnvelope(aliceKeys.privateJwk, {
      body: {
        threadId: "thread-alice",
        messageId: "msg-alice",
        text: "hello",
      },
    });

    await expect(handleSocialInbound({
      envelope,
      receivedAt: "2026-05-12T12:01:00Z",
    }, ctx)).resolves.toEqual({
      ok: true,
      status: "accepted",
      threadId: "thread-alice",
      messageId: "msg-alice",
    });

    const processSend = vi.mocked(sendFrameToProcess).mock.calls.find(([, frame]) =>
      frame.type === "req" && frame.call === "proc.send"
    );
    expect(processSend).toBeTruthy();
    expect(processSend?.[0]).toBe("init:1000");
    expect(processSend?.[1]).toMatchObject({
      type: "req",
      call: "proc.send",
      args: {
        conversationId: "social:alice.example:thread-alice",
        message: expect.stringContaining("From: alice.example"),
      },
    });

    setContextRole(ctx, "user");
    expect(handleSocialThreadGet({ threadId: "thread-alice" }, ctx)).toMatchObject({
      thread: {
        threadId: "thread-alice",
        peerHandle: "alice.example",
        conversationId: "social:alice.example:thread-alice",
      },
      messages: [
        {
          messageId: "msg-alice",
          direction: "inbound",
          fromHandle: "alice.example",
          toHandle: "gsv.example",
          text: "hello",
          deliveryStatus: "delivered",
        },
      ],
    });
    setContextRole(ctx, "service");

    await expect(handleSocialInbound({
      envelope,
      receivedAt: "2026-05-12T12:02:00Z",
    }, ctx)).resolves.toEqual({
      ok: true,
      status: "accepted",
      threadId: "thread-alice",
      messageId: "msg-alice",
    });
  });

  it("rejects inbound envelopes outside the service-only path", async () => {
    const { ctx, aliceKeys } = await setupSignedInboundFriend();
    setContextRole(ctx, "user");
    await expect(handleSocialInbound({
      envelope: await aliceEnvelope(aliceKeys.privateJwk),
      receivedAt: "2026-05-12T12:01:00Z",
    }, ctx)).resolves.toMatchObject({
      ok: false,
      status: "rejected",
      error: "social.inbound is service-only",
    });
  });

  it("rejects malformed inbound envelopes", async () => {
    const { ctx } = await setupSignedInboundFriend();
    await expect(handleSocialInbound({
      envelope: { id: "env-malformed" } as unknown as SocialSignedRequestEnvelope,
      receivedAt: "2026-05-12T12:01:00Z",
    }, ctx)).resolves.toMatchObject({
      ok: false,
      status: "rejected",
      error: "envelope.method must be a non-empty string",
    });
  });

  it("rejects inbound envelopes with bad signatures", async () => {
    const { ctx, aliceKeys } = await setupSignedInboundFriend();
    const envelope = await aliceEnvelope(aliceKeys.privateJwk);

    await expect(handleSocialInbound({
      envelope: {
        ...envelope,
        body: { text: "tampered" },
      },
      receivedAt: "2026-05-12T12:01:00Z",
    }, ctx)).resolves.toMatchObject({
      ok: false,
      status: "rejected",
      error: "Invalid envelope signature",
    });
  });

  it("rejects inbound envelopes for the wrong recipient or after expiry", async () => {
    const { ctx, aliceKeys } = await setupSignedInboundFriend();

    await expect(handleSocialInbound({
      envelope: await aliceEnvelope(aliceKeys.privateJwk, {
        toDid: "did:web:other.example",
      }),
      receivedAt: "2026-05-12T12:01:00Z",
    }, ctx)).resolves.toMatchObject({
      ok: false,
      status: "rejected",
      error: "Envelope recipient does not match local identity",
    });

    await expect(handleSocialInbound({
      envelope: await aliceEnvelope(aliceKeys.privateJwk, {
        id: "env-expired",
        nonce: "nonce-expired",
        expiresAt: "2026-05-12T11:59:00Z",
      }),
      receivedAt: "2026-05-12T12:01:00Z",
    }, ctx)).resolves.toMatchObject({
      ok: false,
      status: "rejected",
      error: "Envelope expired",
    });
  });

  it("rejects inbound envelopes from unknown or ungranted friends", async () => {
    const ctx = createCtx();
    handleSocialIdentitySet({
      handle: "gsv.example",
      pdsEndpoint: "https://gsv.example",
    }, ctx);
    setContextRole(ctx, "service");
    const aliceKeys = await generateP256ServiceKey();
    stubAlicePublicIdentity(aliceKeys.publicKeyMultibase);

    await expect(handleSocialInbound({
      envelope: await aliceEnvelope(aliceKeys.privateJwk),
      receivedAt: "2026-05-12T12:01:00Z",
    }, ctx)).resolves.toMatchObject({
      ok: false,
      status: "rejected",
      error: "Unknown sender",
    });

    const prepared = await setupSignedInboundFriend([{ operation: "social.request.create" }]);
    await expect(handleSocialInbound({
      envelope: await aliceEnvelope(prepared.aliceKeys.privateJwk),
      receivedAt: "2026-05-12T12:01:00Z",
    }, prepared.ctx)).resolves.toMatchObject({
      ok: false,
      status: "rejected",
      error: "Missing grant for social.message.send",
    });
  });

  it("rejects inbound envelopes with expired grants or mismatched keys", async () => {
    const expired = await setupSignedInboundFriend([
      { operation: "social.message.send", expiresAt: "2026-05-12T12:00:30Z" },
    ]);
    await expect(handleSocialInbound({
      envelope: await aliceEnvelope(expired.aliceKeys.privateJwk),
      receivedAt: "2026-05-12T12:01:00Z",
    }, expired.ctx)).resolves.toMatchObject({
      ok: false,
      status: "rejected",
      error: "Grant expired for social.message.send",
    });

    const wrongKey = await setupSignedInboundFriend();
    await expect(handleSocialInbound({
      envelope: await aliceEnvelope(wrongKey.aliceKeys.privateJwk, {
        id: "env-wrong-key",
        nonce: "nonce-wrong-key",
        keyId: "did:web:alice.example#other-key",
      }),
      receivedAt: "2026-05-12T12:01:00Z",
    }, wrongKey.ctx)).resolves.toMatchObject({
      ok: false,
      status: "rejected",
      error: "Envelope key does not match sender service key",
    });
  });
});
