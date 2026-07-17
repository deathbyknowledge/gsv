import { describe, it, expect, vi, beforeEach } from "vitest";
import type { KernelContext } from "./context";
import {
  handleAdapterConnect,
  handleAdapterDisconnect,
  deliverAdapterReply,
  handleAdapterInbound,
  handleAdapterList,
  handleAdapterSend,
  handleAdapterStateUpdate,
  handleAdapterStatus,
} from "./adapter-handlers";
import { sendFrameToProcess } from "../shared/utils";
import { bodyFromBytes, bodyToBytes } from "@humansandmachines/gsv/protocol";

vi.mock("../shared/utils", () => ({
  sendFrameToProcess: vi.fn(),
}));

type FakeAdapterStatusStore = {
  upsert: ReturnType<typeof vi.fn>;
  list?: ReturnType<typeof vi.fn>;
  listAll?: ReturnType<typeof vi.fn>;
};
type MakeContextOptions = {
  identity?: KernelContext["identity"];
  identityLinks?: Record<string, unknown>;
  routePid?: string | null;
  surfaceRoute?: Record<string, unknown> | null;
  processId?: string;
  processRunId?: string;
  runRoute?: Record<string, unknown> | null;
  ingressReceipts?: Record<string, unknown>;
  callerOwnerUid?: number;
};

function makeStorageBucket() {
  return {
    head: vi.fn(async () => null),
    put: vi.fn(async () => undefined),
  };
}

function userIdentity(uid = 1000): KernelContext["identity"] {
  return {
    role: "user",
    process: {
      uid,
      gid: uid,
      gids: [uid],
      username: uid === 0 ? "root" : "sam",
      home: uid === 0 ? "/root" : "/home/sam",
      cwd: uid === 0 ? "/root" : "/home/sam",
    },
    capabilities: ["adapter.*"],
  };
}

function makeContext(
  env: Record<string, unknown>,
  status: FakeAdapterStatusStore,
  options: MakeContextOptions = {},
): KernelContext {
  const human = {
    uid: 1000,
    gid: 1000,
    username: "sam",
    gecos: "Sam",
    home: "/home/sam",
    shell: "/bin/init",
  };
  const personalAgent = {
    uid: 1001,
    gid: 1001,
    username: "sam-agent",
    gecos: "sam-agent",
    home: "/home/sam-agent",
    shell: "/bin/init",
  };
  const processRecord = {
    processId: "pid-1",
    uid: personalAgent.uid,
    ownerUid: human.uid,
    interactive: true,
    gid: personalAgent.gid,
    gids: [human.gid],
    username: personalAgent.username,
    home: personalAgent.home,
    cwd: personalAgent.home,
    state: "idle",
    activeRunId: null,
    activeConversationId: null,
    queuedCount: 0,
    lastActiveAt: null,
    label: "sam-agent (sam)",
    parentPid: null,
    createdAt: 1,
    contextFiles: [],
  };
  const helperAgent = {
    uid: 1002,
    gid: 1002,
    username: "helper",
    gecos: "Helper",
    home: "/home/helper",
    shell: "/bin/init",
  };
  const ingressReceipts = new Map<string, {
    state: "in_progress" | "completed";
    result?: Record<string, unknown>;
  }>();

  return {
    env: {
      STORAGE: makeStorageBucket(),
      ...env,
    },
    processId: options.processId,
    processRunId: options.processRunId,
    auth: {
      getPasswdByUid: vi.fn((uid: number) => {
        if (uid === human.uid) return human;
        if (uid === personalAgent.uid) return personalAgent;
        if (uid === helperAgent.uid) return helperAgent;
        return null;
      }),
      getPasswdEntries: vi.fn(() => [human, personalAgent, helperAgent]),
      getPasswdByUsername: vi.fn((username: string) => {
        if (username === human.username) return human;
        if (username === personalAgent.username) return personalAgent;
        if (username === helperAgent.username) return helperAgent;
        return null;
      }),
      getShadowByUsername: vi.fn((username: string) => (
        username === personalAgent.username || username === helperAgent.username
          ? { username, hash: "!", lastchanged: "", min: "", max: "", warn: "", inactive: "", expire: "", reserved: "" }
          : { username, hash: "$hash", lastchanged: "", min: "", max: "", warn: "", inactive: "", expire: "", reserved: "" }
      )),
      getGroupByGid: vi.fn((gid: number) => {
        if (gid === personalAgent.gid) return { name: personalAgent.username, gid, members: [human.username] };
        if (gid === helperAgent.gid) return { name: helperAgent.username, gid, members: [human.username] };
        if (gid === human.gid) return { name: human.username, gid, members: [personalAgent.username, helperAgent.username] };
        return null;
      }),
      getGroupByName: vi.fn(() => null),
      resolveGids: vi.fn(() => [1000]),
      getPersonalAgentUid: vi.fn(() => personalAgent.uid),
      isPersonalAgentUid: vi.fn((uid: number) => uid === personalAgent.uid),
    },
    procs: {
      get: vi.fn((pid: string) => pid === "pid-1" ? processRecord : null),
      getOwnerUid: vi.fn((pid: string) => pid === "pid-1" ? human.uid : null),
      list: vi.fn(() => [processRecord]),
      spawn: vi.fn(),
    },
    conversations: {
      ensureDefault: vi.fn(() => ({
        record: {
          conversationId: "conv-1",
          ownerUid: 1000,
          agentUid: 1001,
          title: null,
          isDefault: true,
          activePid: "pid-1",
          archiveBase: "/home/agent/conversations/conv-1",
          latestArchive: null,
          createdAt: 0,
          lastActiveAt: null,
        },
        created: false,
      })),
      create: vi.fn(() => ({
        conversationId: "conv-agent",
        ownerUid: 1000,
        agentUid: 1002,
        title: "helper",
        isDefault: false,
        activePid: null,
        archiveBase: "/home/helper/conversations/conv-agent",
        latestArchive: null,
        createdAt: 0,
        lastActiveAt: null,
      })),
      setActivePid: vi.fn(),
    },
    adapters: {
      status: {
        get: vi.fn(() => null),
        setOwner: vi.fn(),
        beginLifecycle: vi.fn(),
        endLifecycle: vi.fn(),
        listByOwner: vi.fn(() => []),
        ...status,
      },
      identityLinks: {
        resolveUid: vi.fn(() => 1000),
        get: vi.fn(() => null),
        listByAccount: vi.fn(() => []),
        list: vi.fn(() => []),
        ...options.identityLinks,
      },
      linkChallenges: {
        issue: vi.fn(() => ({
          code: "ABCD",
          expiresAt: Date.now() + 60_000,
        })),
      },
      surfaceRoutes: {
        resolvePid: vi.fn(() => options.routePid === undefined ? "pid-1" : options.routePid),
        get: vi.fn(() => options.surfaceRoute ?? null),
        list: vi.fn(() => []),
        setRoute: vi.fn(),
        clearRoute: vi.fn(() => Boolean(options.routePid === undefined ? "pid-1" : options.routePid)),
      },
      ingressReceipts: {
        claim: vi.fn((input: { receiptId: string }) => {
          const existing = ingressReceipts.get(input.receiptId);
          if (!existing) {
            ingressReceipts.set(input.receiptId, { state: "in_progress" });
            return { state: "claimed", receiptId: input.receiptId };
          }
          return existing.state === "completed"
            ? {
                state: "completed",
                receiptId: input.receiptId,
                result: existing.result,
              }
            : { state: "in_progress", receiptId: input.receiptId };
        }),
        complete: vi.fn((receiptId: string, result: Record<string, unknown>) => {
          ingressReceipts.set(receiptId, { state: "completed", result });
        }),
        ...options.ingressReceipts,
      },
    },
    runRoutes: {
      setAdapterRoute: vi.fn(),
      get: vi.fn(() => options.runRoute ?? null),
      delete: vi.fn(),
    },
    broadcastToUserUid: vi.fn(),
    identity: options.identity ?? {
      role: "service",
      service: "test",
      capabilities: [],
    },
    callerOwnerUid: options.callerOwnerUid,
  } as unknown as KernelContext;
}

const sendFrameToProcessMock = vi.mocked(sendFrameToProcess);

describe("adapter lifecycle handlers", () => {
  beforeEach(() => {
    sendFrameToProcessMock.mockReset();
  });

  it("notifies root and linked users when adapter state changes", () => {
    const status = {
      upsert: vi.fn(() => ({ ownerUid: 1000 })),
    };
    const ctx = makeContext({}, status, {
      identityLinks: {
        listByAccount: vi.fn(() => [
          { adapter: "whatsapp", accountId: "primary", uid: 2000 },
          { adapter: "whatsapp", accountId: "primary", uid: 2000 },
        ]),
      },
    });

    handleAdapterStateUpdate({
      adapter: "WhatsApp",
      accountId: "primary",
      status: {
        accountId: "primary",
        connected: true,
        authenticated: true,
        extra: { selfE164: "+31612345678" },
      },
    }, ctx);

    expect(status.upsert).toHaveBeenCalledWith("whatsapp", "primary", expect.anything());
    expect(ctx.adapters.identityLinks.listByAccount).toHaveBeenCalledWith("whatsapp", "primary");
    expect(ctx.broadcastToUserUid).toHaveBeenCalledTimes(3);
    expect(ctx.broadcastToUserUid).toHaveBeenCalledWith(0, "adapter.status", {
      adapter: "whatsapp",
      accountId: "primary",
    });
    expect(ctx.broadcastToUserUid).toHaveBeenCalledWith(1000, "adapter.status", {
      adapter: "whatsapp",
      accountId: "primary",
    });
    expect(ctx.broadcastToUserUid).toHaveBeenCalledWith(2000, "adapter.status", {
      adapter: "whatsapp",
      accountId: "primary",
    });
  });

  it("adapter.list discovers deployed adapter bindings and cached accounts", () => {
    const whatsappService = {
      adapterConnect: vi.fn(),
      adapterDisconnect: vi.fn(),
      adapterSend: vi.fn(),
      adapterStatus: vi.fn(),
      adapterSetActivity: vi.fn(),
    };
    const status = {
      upsert: vi.fn(),
      listAll: vi.fn(() => [
        {
          adapter: "whatsapp",
          accountId: "primary",
          connected: true,
          authenticated: true,
          mode: "websocket",
          lastActivity: 123,
          error: null,
          extra: null,
          updatedAt: 456,
        },
        {
          adapter: "telegram",
          accountId: "alerts",
          connected: false,
          authenticated: false,
          mode: null,
          lastActivity: null,
          error: "binding removed",
          extra: { reason: "missing-worker" },
          updatedAt: 789,
        },
      ]),
    };
    const ctx = makeContext(
      {
        CHANNEL_WHATSAPP: whatsappService,
        CHANNEL_DISCORD: { adapterStatus: vi.fn() },
      },
      status,
    );

    const result = handleAdapterList({}, ctx);

    expect(result.adapters).toEqual([
      expect.objectContaining({
        adapter: "discord",
        available: true,
        supportsConnect: false,
        supportsStatus: true,
        accounts: [],
      }),
      expect.objectContaining({
        adapter: "telegram",
        available: false,
        supportsConnect: false,
        accounts: [
          {
            accountId: "alerts",
            connected: false,
            authenticated: false,
            mode: null,
            lastActivity: null,
            error: "binding removed",
            extra: { reason: "missing-worker" },
          },
        ],
      }),
      expect.objectContaining({
        adapter: "whatsapp",
        available: true,
        supportsConnect: true,
        supportsDisconnect: true,
        supportsSend: true,
        supportsStatus: true,
        supportsActivity: true,
        accounts: [
          {
            accountId: "primary",
            connected: true,
            authenticated: true,
            mode: "websocket",
            lastActivity: 123,
            error: null,
            extra: null,
          },
        ],
      }),
    ]);
  });

  it("adapter.list filters cached accounts to non-root identity links", () => {
    const rows = [
      {
        adapter: "whatsapp",
        accountId: "primary",
        connected: true,
        authenticated: true,
        mode: "websocket",
        lastActivity: 123,
        error: null,
        extra: null,
        updatedAt: 456,
      },
      {
        adapter: "telegram",
        accountId: "alerts",
        connected: false,
        authenticated: false,
        mode: null,
        lastActivity: null,
        error: "binding removed",
        extra: { reason: "missing-worker" },
        updatedAt: 789,
      },
      {
        adapter: "discord",
        accountId: "foreign",
        connected: true,
        authenticated: true,
        mode: "gateway",
        lastActivity: 456,
        error: null,
        extra: null,
        updatedAt: 790,
      },
    ];
    const status = {
      upsert: vi.fn(),
      list: vi.fn((adapter: string, accountId?: string) =>
        rows.filter((row) => row.adapter === adapter && (!accountId || row.accountId === accountId))
      ),
      listAll: vi.fn(() => rows),
      listByOwner: vi.fn(() => rows.filter((row) => row.adapter === "telegram")),
    };
    const ctx = makeContext(
      {
        CHANNEL_WHATSAPP: { adapterStatus: vi.fn() },
        CHANNEL_DISCORD: { adapterStatus: vi.fn() },
      },
      status,
      {
        identity: {
          role: "user",
          process: {
            uid: 1000,
            gid: 1000,
            gids: [100],
            username: "sam",
            home: "/home/sam",
            cwd: "/home/sam",
          },
          capabilities: ["adapter.list"],
        },
        identityLinks: {
          list: vi.fn(() => [
            {
              adapter: "whatsapp",
              accountId: "primary",
              actorId: "sam-phone",
              uid: 1000,
              createdAt: 1,
              linkedByUid: 1000,
              metadata: null,
            },
          ]),
        },
      },
    );

    const result = handleAdapterList({}, ctx);

    expect(status.listAll).not.toHaveBeenCalled();
    expect(result.adapters).toEqual([
      expect.objectContaining({
        adapter: "discord",
        accounts: [],
      }),
      expect.objectContaining({
        adapter: "telegram",
        accounts: [expect.objectContaining({ accountId: "alerts" })],
      }),
      expect.objectContaining({
        adapter: "whatsapp",
        accounts: [
          expect.objectContaining({
            accountId: "primary",
            connected: true,
            authenticated: true,
          }),
        ],
      }),
    ]);
  });

  it("adapter.list uses owning human links for agent process callers", () => {
    const rows = [
      {
        adapter: "telegram",
        accountId: "bot",
        connected: true,
        authenticated: true,
        mode: "polling",
        lastActivity: 123,
        error: null,
        extra: null,
        updatedAt: 456,
      },
    ];
    const status = {
      upsert: vi.fn(),
      list: vi.fn((adapter: string, accountId?: string) =>
        rows.filter((row) => row.adapter === adapter && (!accountId || row.accountId === accountId))
      ),
      listAll: vi.fn(() => rows),
    };
    const listLinks = vi.fn((filterUid?: number) =>
      filterUid === 1000
        ? [
            {
              adapter: "telegram",
              accountId: "bot",
              actorId: "sam-telegram",
              uid: 1000,
              createdAt: 1,
              linkedByUid: 1000,
              metadata: null,
            },
          ]
        : []
    );
    const ctx = makeContext(
      {
        CHANNEL_TELEGRAM: { adapterStatus: vi.fn() },
      },
      status,
      {
        processId: "pid-1",
        identity: {
          role: "user",
          process: {
            uid: 1001,
            gid: 1001,
            gids: [1000],
            username: "sam-agent",
            home: "/home/sam-agent",
            cwd: "/home/sam-agent",
          },
          capabilities: ["adapter.list"],
        },
        identityLinks: {
          list: listLinks,
        },
      },
    );

    const result = handleAdapterList({}, ctx);

    expect(listLinks).toHaveBeenCalledWith(1000);
    expect(result.adapters).toEqual([
      expect.objectContaining({
        adapter: "telegram",
        accounts: [
          expect.objectContaining({
            accountId: "bot",
            connected: true,
            authenticated: true,
          }),
        ],
      }),
    ]);
  });

  it("adapter.status filters non-root status refreshes to visible accounts", async () => {
    const rows = [
      {
        adapter: "whatsapp",
        accountId: "primary",
        connected: true,
        authenticated: true,
        mode: "websocket",
        lastActivity: 123,
        error: null,
        extra: null,
        updatedAt: 456,
      },
      {
        adapter: "whatsapp",
        accountId: "hidden",
        connected: true,
        authenticated: true,
        mode: "websocket",
        lastActivity: 789,
        error: "hidden error",
        extra: { secret: true },
        updatedAt: 790,
      },
    ];
    const adapterStatus = vi.fn(async () => [
      {
        accountId: "primary",
        connected: true,
        authenticated: true,
        mode: "websocket",
      },
      {
        accountId: "hidden",
        connected: true,
        authenticated: true,
        mode: "websocket",
        error: "hidden error",
        extra: { secret: true },
      },
    ]);
    const status = {
      upsert: vi.fn(),
      list: vi.fn((adapter: string, accountId?: string) =>
        rows.filter((row) => row.adapter === adapter && (!accountId || row.accountId === accountId))
      ),
      listAll: vi.fn(() => rows),
    };
    const ctx = makeContext(
      {
        CHANNEL_WHATSAPP: { adapterStatus },
      },
      status,
      {
        identity: {
          role: "user",
          process: {
            uid: 1000,
            gid: 1000,
            gids: [100],
            username: "sam",
            home: "/home/sam",
            cwd: "/home/sam",
          },
          capabilities: ["adapter.status"],
        },
        identityLinks: {
          list: vi.fn(() => [
            {
              adapter: "whatsapp",
              accountId: "primary",
              actorId: "sam-phone",
              uid: 1000,
              createdAt: 1,
              linkedByUid: 1000,
              metadata: null,
            },
          ]),
        },
      },
    );

    const result = await handleAdapterStatus({ adapter: "whatsapp" }, ctx);

    expect(adapterStatus).toHaveBeenCalledWith("primary");
    expect(adapterStatus).not.toHaveBeenCalledWith(undefined);
    expect(status.upsert).toHaveBeenCalledTimes(1);
    expect(status.upsert).toHaveBeenCalledWith(
      "whatsapp",
      "primary",
      expect.objectContaining({ accountId: "primary" }),
    );
    expect(result.accounts).toEqual([
      expect.objectContaining({
        accountId: "primary",
        connected: true,
        authenticated: true,
      }),
    ]);
  });

  it("adapter.status uses owning human links for agent process callers", async () => {
    const rows = [
      {
        adapter: "telegram",
        accountId: "bot",
        connected: true,
        authenticated: true,
        mode: "polling",
        lastActivity: 123,
        error: null,
        extra: null,
        updatedAt: 456,
      },
    ];
    const adapterStatus = vi.fn(async () => [
      {
        accountId: "bot",
        connected: true,
        authenticated: true,
        mode: "polling",
      },
    ]);
    const status = {
      upsert: vi.fn(),
      list: vi.fn((adapter: string, accountId?: string) =>
        rows.filter((row) => row.adapter === adapter && (!accountId || row.accountId === accountId))
      ),
      listAll: vi.fn(() => rows),
    };
    const listLinks = vi.fn((filterUid?: number) =>
      filterUid === 1000
        ? [
            {
              adapter: "telegram",
              accountId: "bot",
              actorId: "sam-telegram",
              uid: 1000,
              createdAt: 1,
              linkedByUid: 1000,
              metadata: null,
            },
          ]
        : []
    );
    const ctx = makeContext(
      {
        CHANNEL_TELEGRAM: { adapterStatus },
      },
      status,
      {
        processId: "pid-1",
        identity: {
          role: "user",
          process: {
            uid: 1001,
            gid: 1001,
            gids: [1000],
            username: "sam-agent",
            home: "/home/sam-agent",
            cwd: "/home/sam-agent",
          },
          capabilities: ["adapter.status"],
        },
        identityLinks: {
          list: listLinks,
        },
      },
    );

    const result = await handleAdapterStatus({ adapter: "telegram" }, ctx);

    expect(listLinks).toHaveBeenCalledWith(1000);
    expect(adapterStatus).toHaveBeenCalledWith("bot");
    expect(result.accounts).toEqual([
      expect.objectContaining({
        accountId: "bot",
        connected: true,
        authenticated: true,
      }),
    ]);
  });

  it("adapter.connect returns connect challenge payload and refreshes status", async () => {
    const service = {
      adapterConnect: vi.fn(async () => ({
        ok: true as const,
        message: "Scan QR code",
        connected: true,
        authenticated: false,
        challenge: {
          type: "qr",
          data: "qr-payload",
          message: "Scan QR code",
        },
      })),
      adapterStatus: vi.fn(async () => [
        {
          accountId: "default",
          connected: true,
          authenticated: false,
          mode: "websocket",
        },
      ]),
    };

    let ownerUid: number | null = null;
    let exists = false;
    const get = vi.fn(() => exists ? { ownerUid } : null);
    const status = {
      get,
      setOwner: vi.fn((_adapter: string, _accountId: string, nextOwnerUid: number) => {
        exists = true;
        ownerUid = nextOwnerUid;
        return { ownerUid };
      }),
      upsert: vi.fn(() => ({ ownerUid })),
    };
    const ctx = makeContext(
      {
        CHANNEL_WHATSAPP: service,
      },
      status,
      { identity: userIdentity() },
    );

    const result = await handleAdapterConnect(
      { adapter: "WhatsApp", accountId: "default" },
      ctx,
    );

    expect(service.adapterConnect).toHaveBeenCalledWith("default", undefined);
    expect(status.setOwner).toHaveBeenCalledWith("whatsapp", "default", 1000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.adapter).toBe("whatsapp");
      expect(result.challenge?.type).toBe("qr");
      expect(result.connected).toBe(true);
      expect(result.authenticated).toBe(false);
    }
    expect(status.upsert).toHaveBeenCalled();
  });

  it("adapter.connect returns error when binding does not implement connect", async () => {
    const service = {
      start: vi.fn(async () => ({ ok: true as const })),
    };

    const status = {
      upsert: vi.fn(),
      get: vi.fn(() => ({ ownerUid: 1000 })),
    };
    const ctx = makeContext(
      {
        CHANNEL_DISCORD: service,
      },
      status,
      { identity: userIdentity() },
    );

    const result = await handleAdapterConnect(
      { adapter: "discord", accountId: "default", config: { botToken: "x" } },
      ctx,
    );

    expect(service.start).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("does not implement connect");
    }
  });

  it.each([
    ["foreign", 2000, [], true],
    ["unlinked unowned", null, [], true],
    ["ambiguously linked unowned", null, [1000, 2000], true],
    ["missing with a foreign link", null, [2000], false],
  ])("rejects %s adapter accounts before connect", async (
    _label,
    ownerUid,
    linkedUids,
    exists,
  ) => {
    const adapterConnect = vi.fn(async () => ({
      ok: true as const,
      connected: true,
      authenticated: true,
    }));
    const ctx = makeContext(
      { CHANNEL_WHATSAPP: { adapterConnect } },
      {
        upsert: vi.fn(),
        get: vi.fn(() => exists ? { ownerUid } : null),
      },
      {
        identity: userIdentity(),
        identityLinks: {
          listByAccount: vi.fn(() => linkedUids.map((uid) => ({ uid }))),
        },
      },
    );

    await expect(handleAdapterConnect({ adapter: "whatsapp", accountId: "default" }, ctx))
      .rejects.toThrow("Permission denied");
    expect(adapterConnect).not.toHaveBeenCalled();
  });

  it("lets the sole linked user claim an unowned adapter account", async () => {
    const setOwner = vi.fn();
    const ctx = makeContext(
      {
        CHANNEL_WHATSAPP: {
          adapterConnect: vi.fn(async () => ({
            ok: true as const,
            connected: true,
            authenticated: true,
          })),
        },
      },
      {
        upsert: vi.fn(),
        get: vi.fn(() => ({ ownerUid: null })),
        setOwner,
      },
      {
        identity: userIdentity(),
        identityLinks: { listByAccount: vi.fn(() => [{ uid: 1000 }]) },
      },
    );

    await expect(handleAdapterConnect({ adapter: "whatsapp", accountId: "default" }, ctx))
      .resolves.toMatchObject({ ok: true });
    expect(setOwner).toHaveBeenCalledWith("whatsapp", "default", 1000);
  });

  it("retains ownership when adapter provisioning fails", async () => {
    let ownerUid: number | null = null;
    let exists = false;
    const beginLifecycle = vi.fn();
    const endLifecycle = vi.fn();
    const setOwner = vi.fn((_adapter: string, _accountId: string, nextOwnerUid: number) => {
      exists = true;
      ownerUid = nextOwnerUid;
      return { ownerUid };
    });
    const ctx = makeContext(
      {
        CHANNEL_DISCORD: {
          adapterConnect: vi.fn(async () => ({ ok: false as const, error: "bad token" })),
        },
      },
      {
        upsert: vi.fn(),
        get: vi.fn(() => exists ? { ownerUid } : null),
        setOwner,
        beginLifecycle,
        endLifecycle,
      },
      { identity: userIdentity() },
    );

    await expect(handleAdapterConnect({ adapter: "discord", accountId: "default" }, ctx))
      .resolves.toEqual({ ok: false, error: "bad token", challenge: undefined });
    expect(setOwner).toHaveBeenCalledWith("discord", "default", 1000);
    expect(ownerUid).toBe(1000);
    expect(beginLifecycle).toHaveBeenCalledWith("discord", "default");
    expect(endLifecycle).toHaveBeenCalledWith("discord", "default");
  });

  it("retains a new ownership claim when the adapter outcome is unknown", async () => {
    const setOwner = vi.fn();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = makeContext(
      {
        CHANNEL_DISCORD: {
          adapterConnect: vi.fn(async () => {
            throw new Error("rpc interrupted");
          }),
        },
      },
      {
        upsert: vi.fn(),
        get: vi.fn(() => null),
        setOwner,
      },
      { identity: userIdentity() },
    );

    await expect(handleAdapterConnect({ adapter: "discord", accountId: "default" }, ctx))
      .rejects.toThrow("rpc interrupted");
    expect(setOwner).toHaveBeenCalledWith("discord", "default", 1000);
    errorLog.mockRestore();
  });

  it("adapter.disconnect calls disconnect and refreshes status", async () => {
    const service = {
      adapterDisconnect: vi.fn(async () => ({ ok: true as const })),
      adapterStatus: vi.fn(async () => [
        {
          accountId: "default",
          connected: false,
          authenticated: false,
          mode: "disconnected",
        },
      ]),
    };

    const status = {
      upsert: vi.fn(),
      get: vi.fn(() => ({ ownerUid: 1000 })),
    };
    const ctx = makeContext(
      {
        CHANNEL_WHATSAPP: service,
      },
      status,
      { identity: userIdentity() },
    );

    const result = await handleAdapterDisconnect(
      { adapter: "whatsapp", accountId: "default" },
      ctx,
    );

    expect(service.adapterDisconnect).toHaveBeenCalledWith("default");
    expect(result).toMatchObject({
      ok: true,
      adapter: "whatsapp",
      accountId: "default",
    });
    expect(status.upsert).toHaveBeenCalled();
  });

  it("allows only the owner or root to disconnect an adapter account", async () => {
    const adapterDisconnect = vi.fn(async () => ({ ok: true as const }));
    const beginLifecycle = vi.fn();
    const endLifecycle = vi.fn();
    const status = {
      upsert: vi.fn(),
      get: vi.fn(() => ({ ownerUid: 2000 })),
      beginLifecycle,
      endLifecycle,
    };
    const env = { CHANNEL_WHATSAPP: { adapterDisconnect } };

    await expect(handleAdapterDisconnect(
      { adapter: "whatsapp", accountId: "default" },
      makeContext(env, status, { identity: userIdentity(1000) }),
    )).rejects.toThrow("Permission denied");
    expect(adapterDisconnect).not.toHaveBeenCalled();

    await expect(handleAdapterDisconnect(
      { adapter: "whatsapp", accountId: "default" },
      makeContext(env, status, { identity: userIdentity(0) }),
    )).resolves.toMatchObject({ ok: true });
    expect(adapterDisconnect).toHaveBeenCalledTimes(1);
    expect(beginLifecycle).toHaveBeenCalledTimes(1);
    expect(endLifecycle).toHaveBeenCalledTimes(1);
  });

  it("returns an error when adapter binding is missing", async () => {
    const status = { upsert: vi.fn() };
    const ctx = makeContext({}, status, { identity: userIdentity() });

    const result = await handleAdapterConnect(
      { adapter: "unknown", accountId: "default" },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Adapter service unavailable");
    }
  });

  it("drops an unaddressed group message before observing or delivering it", async () => {
    const ctx = makeContext({}, { upsert: vi.fn() });

    const result = await handleAdapterInbound({
      adapter: "discord",
      accountId: "primary",
      message: {
        messageId: "group-unmentioned",
        surface: { kind: "group", id: "shared-channel" },
        actor: { id: "discord:user:42" },
        text: "talking to everyone else",
        wasMentioned: false,
      },
    }, ctx);

    expect(result).toEqual({ ok: true, droppedReason: "not_addressed" });
    expect(ctx.adapters.surfaceRoutes.setRoute).not.toHaveBeenCalled();
    expect(ctx.runRoutes.setAdapterRoute).not.toHaveBeenCalled();
    expect(sendFrameToProcessMock).not.toHaveBeenCalled();
  });

  it("admits an addressed group and preallocates its reply route before Process delivery", async () => {
    const ctx = makeContext({
      CHANNEL_DISCORD: {
        adapterSetActivity: vi.fn(async () => ({ ok: true as const })),
      },
    }, { upsert: vi.fn() });
    let admittedRunId = "";
    sendFrameToProcessMock.mockImplementation(async (_pid: string, frame: any) => {
      if (frame.call === "proc.history") {
        return { type: "res", id: frame.id, ok: true, data: { pendingHil: null } };
      }
      if (frame.call === "proc.adapter.deliver") {
        admittedRunId = frame.args.runId;
        expect(ctx.runRoutes.setAdapterRoute).toHaveBeenCalledWith({
          runId: admittedRunId,
          processId: "pid-1",
          uid: 1000,
          adapter: "discord",
          accountId: "primary",
          actorId: "discord:user:42",
          surfaceKind: "group",
          surfaceId: "shared-channel",
          threadId: undefined,
          replyToId: "group-mentioned",
        });
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: {
            ok: true,
            status: "started",
            runId: admittedRunId,
            queued: false,
          },
        };
      }
      throw new Error(`Unexpected call: ${frame.call}`);
    });

    const result = await handleAdapterInbound({
      adapter: "discord",
      accountId: "primary",
      message: {
        messageId: "group-mentioned",
        surface: { kind: "group", id: "shared-channel" },
        actor: { id: "discord:user:42" },
        text: "@bot please help",
        wasMentioned: true,
      },
    }, ctx);

    expect(result).toEqual({
      ok: true,
      delivered: {
        uid: 1000,
        pid: "pid-1",
        runId: admittedRunId,
        queued: false,
      },
    });
    expect(ctx.adapters.surfaceRoutes.setRoute).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "discord:user:42",
      surfaceKind: "group",
      surfaceId: "shared-channel",
      pid: "pid-1",
    }));
  });

  it("derives the same run id when an adapter retries the same provider message", async () => {
    const adapterSetActivity = vi.fn(async () => ({ ok: true as const }));
    const ctx = makeContext({
      CHANNEL_TELEGRAM: {
        adapterSetActivity,
      },
    }, { upsert: vi.fn() });
    const deliveredRunIds: string[] = [];
    sendFrameToProcessMock.mockImplementation(async (_pid: string, frame: any) => {
      if (frame.call === "proc.history") {
        return { type: "res", id: frame.id, ok: true, data: { pendingHil: null } };
      }
      if (frame.call === "proc.adapter.deliver") {
        deliveredRunIds.push(frame.args.runId);
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: {
            ok: true,
            status: "started",
            runId: frame.args.runId,
            queued: false,
          },
        };
      }
      throw new Error(`Unexpected call: ${frame.call}`);
    });
    const inbound = {
      adapter: "telegram",
      accountId: "bot",
      message: {
        messageId: "provider-message-42",
        surface: { kind: "dm" as const, id: "chat-42" },
        actor: { id: "telegram:user:42" },
        text: "Please remind me tomorrow.",
      },
    };

    const first = await handleAdapterInbound(inbound, ctx);
    const cancelReplayBody = vi.fn(async () => undefined);
    const retry = await handleAdapterInbound({
      ...inbound,
      message: {
        ...inbound.message,
        media: [{
          type: "image" as const,
          mimeType: "image/png",
          body: { offset: 0, length: 1 },
        }],
      },
    }, ctx, {
      length: 1,
      stream: {
        locked: false,
        cancel: cancelReplayBody,
      } as unknown as ReadableStream<Uint8Array>,
    });

    expect(deliveredRunIds).toHaveLength(1);
    expect(deliveredRunIds[0]).toMatch(/^adapter-run:[0-9a-f]{64}$/);
    expect(first.delivered?.runId).toBe(deliveredRunIds[0]);
    expect(retry.delivered?.runId).toBe(deliveredRunIds[0]);
    expect(retry.replayed).toBe("completed");
    expect(cancelReplayBody).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ctx.runRoutes.setAdapterRoute).mock.calls.map(([route]) => route.runId)).toEqual([
      deliveredRunIds[0],
    ]);
    expect(adapterSetActivity).toHaveBeenCalledTimes(1);
    expect(adapterSetActivity).toHaveBeenCalledWith(
      "bot",
      { kind: "dm", id: "chat-42" },
      { kind: "typing", active: true },
    );
  });

  it("replays completed commands without repeating their side effects", async () => {
    const ctx = makeContext({}, { upsert: vi.fn() }, { routePid: "pid-1" });
    const inbound = {
      adapter: "whatsapp",
      accountId: "primary",
      message: {
        messageId: "command-once",
        surface: { kind: "dm" as const, id: "dm-1" },
        actor: { id: "wa:+123" },
        text: "/use personal",
      },
    };

    const first = await handleAdapterInbound(inbound, ctx);
    const replay = await handleAdapterInbound(inbound, ctx);

    expect(first.reply?.deliveryId).toMatch(/^adapter-ingress:[0-9a-f]{64}:reply$/);
    expect(replay).toEqual({ ...first, replayed: "completed" });
    expect(ctx.adapters.surfaceRoutes.setRoute).toHaveBeenCalledTimes(1);
    expect(sendFrameToProcessMock).not.toHaveBeenCalled();
  });

  it("replays a link challenge with one challenge mutation and one delivery id", async () => {
    const ctx = makeContext({}, { upsert: vi.fn() }, {
      identityLinks: { resolveUid: vi.fn(() => null) },
    });
    const inbound = {
      adapter: "telegram",
      accountId: "bot",
      message: {
        messageId: "challenge-once",
        surface: { kind: "dm" as const, id: "chat-1" },
        actor: { id: "telegram:user:1" },
        text: "hello",
      },
    };

    const first = await handleAdapterInbound(inbound, ctx);
    const replay = await handleAdapterInbound(inbound, ctx);

    expect(first.challenge?.deliveryId).toMatch(/^adapter-ingress:[0-9a-f]{64}:challenge$/);
    expect(replay).toEqual({ ...first, replayed: "completed" });
    expect(ctx.adapters.linkChallenges.issue).toHaveBeenCalledTimes(1);
    expect(sendFrameToProcessMock).not.toHaveBeenCalled();
  });

  it("drops an in-progress replay before identity, routing, media, or Process effects", async () => {
    const claim = vi.fn(() => ({
      state: "in_progress" as const,
      receiptId: "adapter-ingress:claimed",
    }));
    const ctx = makeContext({}, { upsert: vi.fn() }, {
      ingressReceipts: { claim },
    });
    const cancel = vi.fn(async () => undefined);
    const body = {
      length: 1,
      stream: {
        locked: false,
        cancel,
      } as unknown as ReadableStream<Uint8Array>,
    };

    const result = await handleAdapterInbound({
      adapter: "telegram",
      accountId: "bot",
      message: {
        messageId: "still-processing",
        surface: { kind: "dm", id: "chat-1" },
        actor: { id: "telegram:user:1" },
        text: "hello",
        media: [{
          type: "image",
          mimeType: "image/png",
          body: { offset: 0, length: 1 },
        }],
      },
    }, ctx, body);

    expect(result).toEqual({
      ok: true,
      droppedReason: "duplicate_in_progress",
      replayed: "in_progress",
    });
    expect(ctx.adapters.identityLinks.resolveUid).not.toHaveBeenCalled();
    expect(ctx.adapters.surfaceRoutes.setRoute).not.toHaveBeenCalled();
    expect(ctx.runRoutes.setAdapterRoute).not.toHaveBeenCalled();
    expect(sendFrameToProcessMock).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("removes route and typing state when Process reports an already-recorded run", async () => {
    const adapterSetActivity = vi.fn(async () => ({ ok: true as const }));
    const ctx = makeContext({
      CHANNEL_TELEGRAM: { adapterSetActivity },
    }, { upsert: vi.fn() });
    sendFrameToProcessMock.mockImplementation(async (_pid: string, frame: any) => {
      if (frame.call === "proc.history") {
        return { type: "res", id: frame.id, ok: true, data: { pendingHil: null } };
      }
      if (frame.call === "proc.media.write") {
        await bodyToBytes(frame.body);
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: {
            ok: true,
            media: {
              type: "image",
              mimeType: "image/png",
              key: "var/media/1000/pid-1/replayed",
              size: 1,
            },
          },
        };
      }
      if (frame.call === "proc.adapter.deliver") {
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: {
            ok: true,
            status: "started",
            runId: frame.args.runId,
            replayed: "recorded",
          },
        };
      }
      if (frame.call === "proc.media.delete") {
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: {
            ok: false,
            error: "media is referenced by process history",
          },
        };
      }
      throw new Error(`Unexpected call: ${frame.call}`);
    });

    const result = await handleAdapterInbound({
      adapter: "telegram",
      accountId: "bot",
      message: {
        messageId: "old-provider-message",
        surface: { kind: "dm", id: "chat-1" },
        actor: { id: "telegram:user:1" },
        text: "old message",
        media: [{
          type: "image",
          mimeType: "image/png",
          body: { offset: 0, length: 1 },
        }],
      },
    }, ctx, bodyFromBytes(new Uint8Array([1])));

    expect(result.ok).toBe(true);
    const runId = result.delivered?.runId;
    expect(ctx.runRoutes.delete).toHaveBeenCalledWith(runId);
    expect(sendFrameToProcessMock).toHaveBeenCalledWith("pid-1", expect.objectContaining({
      call: "proc.media.delete",
      args: {
        pid: "pid-1",
        key: "var/media/1000/pid-1/replayed",
      },
    }));
    expect(adapterSetActivity).toHaveBeenLastCalledWith(
      "bot",
      { kind: "dm", id: "chat-1" },
      { kind: "typing", active: false },
    );
  });

  it("adapter.inbound returns a reminder when a confirmation is pending", async () => {
    sendFrameToProcessMock.mockResolvedValueOnce({
      type: "res",
      id: "history-1",
      ok: true,
      data: {
        pendingHil: {
          requestId: "hil-1",
          toolName: "Read",
          syscall: "fs.read",
          args: { path: "~/secret.txt", target: "gsv" },
        },
      },
    } as any);

    const service = {
      adapterSetActivity: vi.fn(async () => ({ ok: true as const })),
    };
    const status = { upsert: vi.fn() };
    const ctx = makeContext(
      {
        CHANNEL_WHATSAPP: service,
      },
      status,
    );

    const result = await handleAdapterInbound(
      {
        adapter: "whatsapp",
        accountId: "primary",
        message: {
          messageId: "msg-1",
          surface: { kind: "dm", id: "dm-1" },
          actor: { id: "wa:+123" },
          text: "what's going on?",
        },
      },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      reply: {
        replyToId: "msg-1",
      },
    });
    expect(result.reply?.text).toContain('"approve always"');
    expect(sendFrameToProcessMock).toHaveBeenCalledTimes(1);
  });

  it("passes adapter interaction origin to proc.send", async () => {
    sendFrameToProcessMock
      .mockResolvedValueOnce({
        type: "res",
        id: "history-1",
        ok: true,
        data: { pendingHil: null },
      } as any)
      .mockImplementationOnce(async (_pid: string, frame: any) => ({
        type: "res",
        id: frame.id,
        ok: true,
        data: {
          ok: true,
          status: "started",
          runId: frame.args.runId,
          queued: false,
        },
      } as any));

    const service = {
      adapterSetActivity: vi.fn(async () => ({ ok: true as const })),
    };
    const status = { upsert: vi.fn() };
    const ctx = makeContext(
      {
        CHANNEL_WHATSAPP: service,
      },
      status,
    );

    const result = await handleAdapterInbound(
      {
        adapter: "whatsapp",
        accountId: "primary",
        message: {
          messageId: "msg-3",
          surface: { kind: "dm", id: "dm-1", name: "Sam" },
          actor: { id: "wa:+123", handle: "@sam" },
          text: "hello",
        },
      },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      delivered: {
        uid: 1000,
        pid: "pid-1",
        runId: expect.any(String),
        queued: false,
      },
    });
    expect(sendFrameToProcessMock).toHaveBeenNthCalledWith(
      2,
      "pid-1",
      expect.objectContaining({
        call: "proc.adapter.deliver",
        args: expect.objectContaining({
          message: "hello",
          origin: {
            kind: "adapter",
            adapter: "whatsapp",
            accountId: "primary",
            surface: { kind: "dm", id: "dm-1", name: "Sam" },
            actorId: "wa:+123",
            actorLabel: "@sam",
            messageId: "msg-3",
          },
        }),
      }),
    );
  });

  it("stores adapter media before delivering proc.send", async () => {
    let uploadedBytes: number[] = [];
    sendFrameToProcessMock.mockImplementation(async (_pid: string, frame: any) => {
      if (frame.call === "proc.history") {
        return { type: "res", id: frame.id, ok: true, data: { pendingHil: null } };
      }
      if (frame.call === "proc.media.write") {
        uploadedBytes = [...await bodyToBytes(frame.body)];
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: {
            ok: true,
            media: {
              type: "image",
              mimeType: "image/png",
              key: "var/media/1000/pid-1/image",
              size: 3,
            },
          },
        };
      }
      if (frame.call === "proc.adapter.deliver") {
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: { ok: true, status: "started", runId: frame.args.runId },
        };
      }
      throw new Error(`Unexpected call: ${frame.call}`);
    });
    const ctx = makeContext({
      CHANNEL_WHATSAPP: {
        adapterSetActivity: vi.fn(async () => ({ ok: true as const })),
      },
    }, { upsert: vi.fn() });

    await handleAdapterInbound({
      adapter: "whatsapp",
      accountId: "primary",
      message: {
        messageId: "msg-media",
        surface: { kind: "dm", id: "dm-1" },
        actor: { id: "wa:+123" },
        text: "photo",
        media: [{
          type: "image",
          mimeType: "image/png",
          size: 3,
          body: { offset: 0, length: 3 },
        }],
      },
    }, ctx, bodyFromBytes(new Uint8Array([1, 2, 3])));

    const upload = sendFrameToProcessMock.mock.calls[1]?.[1];
    expect(upload).toMatchObject({
      call: "proc.media.write",
      args: { type: "image", mimeType: "image/png" },
    });
    expect(upload?.args).not.toHaveProperty("size");
    expect(uploadedBytes).toEqual([1, 2, 3]);
    expect(sendFrameToProcessMock.mock.calls[2]?.[1]).toMatchObject({
      call: "proc.adapter.deliver",
      args: {
        media: [{
          type: "image",
          mimeType: "image/png",
          key: "var/media/1000/pid-1/image",
          size: 3,
        }],
      },
    });
  });

  it("rolls back adapter uploads when another upload fails", async () => {
    sendFrameToProcessMock.mockImplementation(async (_pid: string, frame: any) => {
      if (frame.call === "proc.history") {
        return { type: "res", id: frame.id, ok: true, data: { pendingHil: null } };
      }
      if (frame.call === "proc.media.write" && frame.args.filename === "good.png") {
        await bodyToBytes(frame.body);
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: {
            ok: true,
            media: {
              type: "image",
              mimeType: "image/png",
              key: "var/media/1000/pid-1/good",
              size: 1,
            },
          },
        };
      }
      if (frame.call === "proc.media.write") {
        await bodyToBytes(frame.body);
        return { type: "res", id: frame.id, ok: true, data: { ok: false, error: "upload failed" } };
      }
      if (frame.call === "proc.media.delete") {
        return { type: "res", id: frame.id, ok: true, data: { ok: true, key: frame.args.key } };
      }
      throw new Error(`Unexpected call: ${frame.call}`);
    });
    const ctx = makeContext({
      CHANNEL_WHATSAPP: {
        adapterSetActivity: vi.fn(async () => ({ ok: true as const })),
      },
    }, { upsert: vi.fn() });

    await expect(handleAdapterInbound({
      adapter: "whatsapp",
      accountId: "primary",
      message: {
        messageId: "msg-media-rollback",
        surface: { kind: "dm", id: "dm-1" },
        actor: { id: "wa:+123" },
        text: "photos",
        media: [
          {
            type: "image",
            mimeType: "image/png",
            filename: "good.png",
            size: 1,
            body: { offset: 0, length: 1 },
          },
          {
            type: "image",
            mimeType: "image/png",
            filename: "bad.png",
            size: 1,
            body: { offset: 1, length: 1 },
          },
        ],
      },
    }, ctx, bodyFromBytes(new Uint8Array([1, 2])))).rejects.toThrow("upload failed");

    expect(sendFrameToProcessMock).toHaveBeenCalledWith("pid-1", expect.objectContaining({
      call: "proc.media.delete",
      args: { pid: "pid-1", key: "var/media/1000/pid-1/good" },
    }));
    expect(sendFrameToProcessMock.mock.calls.some(([, frame]) => frame.call === "proc.adapter.deliver")).toBe(false);
  });

  it("preserves adapter uploads when a Process error response leaves admission ambiguous", async () => {
    sendFrameToProcessMock.mockImplementation(async (_pid: string, frame: any) => {
      if (frame.call === "proc.history") {
        return { type: "res", id: frame.id, ok: true, data: { pendingHil: null } };
      }
      if (frame.call === "proc.media.write") {
        await bodyToBytes(frame.body);
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: {
            ok: true,
            media: {
              type: "image",
              mimeType: "image/png",
              key: "var/media/1000/pid-1/staged",
              size: 1,
            },
          },
        };
      }
      if (frame.call === "proc.adapter.deliver") {
        return { type: "res", id: frame.id, ok: false, error: { code: 500, message: "delivery failed" } };
      }
      if (frame.call === "proc.media.delete") {
        return { type: "res", id: frame.id, ok: true, data: { ok: true, key: frame.args.key } };
      }
      throw new Error(`Unexpected call: ${frame.call}`);
    });
    const ctx = makeContext({
      CHANNEL_WHATSAPP: {
        adapterSetActivity: vi.fn(async () => ({ ok: true as const })),
      },
    }, { upsert: vi.fn() });

    const result = await handleAdapterInbound({
      adapter: "whatsapp",
      accountId: "primary",
      message: {
        messageId: "msg-media-send-fail",
        surface: { kind: "dm", id: "dm-1" },
        actor: { id: "wa:+123" },
        text: "photo",
        media: [{
          type: "image",
          mimeType: "image/png",
          size: 1,
          body: { offset: 0, length: 1 },
        }],
      },
    }, ctx, bodyFromBytes(new Uint8Array([1])));

    expect(result).toEqual({ ok: false, error: "delivery failed" });
    expect(sendFrameToProcessMock.mock.calls.some(([, frame]) =>
      frame.call === "proc.media.delete"
    )).toBe(false);
    const preallocatedRunId = vi.mocked(ctx.runRoutes.setAdapterRoute).mock.calls[0]?.[0]?.runId;
    expect(preallocatedRunId).toEqual(expect.any(String));
    expect(ctx.runRoutes.delete).not.toHaveBeenCalled();
  });

  it("preserves the preallocated route and media when Process delivery throws ambiguously", async () => {
    const adapterSetActivity = vi.fn(async () => ({ ok: true as const }));
    sendFrameToProcessMock.mockImplementation(async (_pid: string, frame: any) => {
      if (frame.call === "proc.history") {
        return { type: "res", id: frame.id, ok: true, data: { pendingHil: null } };
      }
      if (frame.call === "proc.media.write") {
        await bodyToBytes(frame.body);
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: {
            ok: true,
            media: {
              type: "image",
              mimeType: "image/png",
              key: "var/media/1000/pid-1/ambiguous",
              size: 1,
            },
          },
        };
      }
      if (frame.call === "proc.adapter.deliver") {
        throw new Error("Process RPC transport lost");
      }
      if (frame.call === "proc.media.delete") {
        throw new Error("Ambiguous delivery must not delete admitted media");
      }
      throw new Error(`Unexpected call: ${frame.call}`);
    });
    const ctx = makeContext({
      CHANNEL_WHATSAPP: { adapterSetActivity },
    }, { upsert: vi.fn() });
    const inbound = {
      adapter: "whatsapp",
      accountId: "primary",
      message: {
        messageId: "msg-media-ambiguous",
        surface: { kind: "dm" as const, id: "dm-1" },
        actor: { id: "wa:+123" },
        text: "photo",
        media: [{
          type: "image" as const,
          mimeType: "image/png",
          size: 1,
          body: { offset: 0, length: 1 },
        }],
      },
    };

    await expect(handleAdapterInbound(
      inbound,
      ctx,
      bodyFromBytes(new Uint8Array([1])),
    )).rejects.toThrow(
      "Process RPC transport lost",
    );

    const replay = await handleAdapterInbound(inbound, ctx);
    expect(replay).toEqual({
      ok: true,
      droppedReason: "duplicate_in_progress",
      replayed: "in_progress",
    });

    const preallocatedRunId = vi.mocked(ctx.runRoutes.setAdapterRoute).mock.calls[0]?.[0]?.runId;
    expect(preallocatedRunId).toEqual(expect.any(String));
    expect(ctx.runRoutes.delete).not.toHaveBeenCalled();
    expect(sendFrameToProcessMock.mock.calls.some(([, frame]) =>
      frame.call === "proc.media.delete"
    )).toBe(false);
    expect(sendFrameToProcessMock.mock.calls.filter(([, frame]) => (
      frame.call === "proc.adapter.deliver"
    ))).toHaveLength(1);
    expect(adapterSetActivity).toHaveBeenNthCalledWith(
      1,
      "primary",
      { kind: "dm", id: "dm-1" },
      { kind: "typing", active: true },
    );
    expect(adapterSetActivity).toHaveBeenNthCalledWith(
      2,
      "primary",
      { kind: "dm", id: "dm-1" },
      { kind: "typing", active: false },
    );
  });

  it("adapter.inbound accepts approve in dm while a confirmation is pending", async () => {
    const service = {
      adapterSetActivity: vi.fn(async () => ({ ok: true as const })),
    };
    sendFrameToProcessMock
      .mockResolvedValueOnce({
        type: "res",
        id: "history-1",
        ok: true,
        data: {
          pendingHil: {
            requestId: "hil-2",
            toolName: "Read",
            syscall: "fs.read",
            args: { path: "~/secret.txt", target: "gsv" },
          },
        },
      } as any)
      .mockResolvedValueOnce({
        type: "res",
        id: "hil-2",
        ok: true,
        data: {
          ok: true,
          pid: "pid-1",
          requestId: "hil-2",
          decision: "approve",
          resumed: true,
          pendingHil: null,
        },
      } as any);

    const status = { upsert: vi.fn() };
    const ctx = makeContext(
      {
        CHANNEL_WHATSAPP: service,
      },
      status,
    );

    const result = await handleAdapterInbound(
      {
        adapter: "whatsapp",
        accountId: "primary",
        message: {
          messageId: "msg-2",
          surface: { kind: "dm", id: "dm-1" },
          actor: { id: "wa:+123" },
          text: "approve",
        },
      },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      reply: {
        text: "Approved. Continuing.",
        replyToId: "msg-2",
      },
    });
    expect(service.adapterSetActivity).toHaveBeenCalledWith(
      "primary",
      { kind: "dm", id: "dm-1" },
      { kind: "typing", active: true },
    );
    expect(sendFrameToProcessMock).toHaveBeenCalledTimes(2);
  });

  it("replays a completed HIL decision without deciding twice", async () => {
    sendFrameToProcessMock
      .mockResolvedValueOnce({
        type: "res",
        id: "history-once",
        ok: true,
        data: {
          pendingHil: {
            requestId: "hil-once",
            toolName: "Write",
            syscall: "fs.write",
            args: { path: "~/result.txt" },
          },
        },
      } as any)
      .mockResolvedValueOnce({
        type: "res",
        id: "hil-once",
        ok: true,
        data: {
          ok: true,
          requestId: "hil-once",
          decision: "deny",
          resumed: true,
          pendingHil: null,
        },
      } as any);
    const ctx = makeContext({
      CHANNEL_WHATSAPP: {
        adapterSetActivity: vi.fn(async () => ({ ok: true as const })),
      },
    }, { upsert: vi.fn() });
    const inbound = {
      adapter: "whatsapp",
      accountId: "primary",
      message: {
        messageId: "hil-provider-once",
        surface: { kind: "dm" as const, id: "dm-1" },
        actor: { id: "wa:+123" },
        text: "deny",
      },
    };

    const first = await handleAdapterInbound(inbound, ctx);
    const replay = await handleAdapterInbound(inbound, ctx);

    expect(replay).toEqual({ ...first, replayed: "completed" });
    expect(replay.reply?.deliveryId).toBe(first.reply?.deliveryId);
    expect(sendFrameToProcessMock).toHaveBeenCalledTimes(2);
    expect(sendFrameToProcessMock.mock.calls.filter(([, frame]) => (
      frame.call === "proc.hil"
    ))).toHaveLength(1);
  });

  it("adapter.inbound accepts approve always with remembered approval", async () => {
    const service = {
      adapterSetActivity: vi.fn(async () => ({ ok: true as const })),
    };
    sendFrameToProcessMock
      .mockResolvedValueOnce({
        type: "res",
        id: "history-1",
        ok: true,
        data: {
          pendingHil: {
            requestId: "hil-3",
            toolName: "Read",
            syscall: "fs.read",
            args: { path: "~/secret.txt", target: "gsv" },
          },
        },
      } as any)
      .mockResolvedValueOnce({
        type: "res",
        id: "hil-3",
        ok: true,
        data: {
          ok: true,
          pid: "pid-1",
          requestId: "hil-3",
          decision: "approve",
          resumed: true,
          remembered: true,
          pendingHil: null,
        },
      } as any);

    const status = { upsert: vi.fn() };
    const ctx = makeContext(
      {
        CHANNEL_WHATSAPP: service,
      },
      status,
    );

    const result = await handleAdapterInbound(
      {
        adapter: "whatsapp",
        accountId: "primary",
        message: {
          messageId: "msg-4",
          surface: { kind: "dm", id: "dm-1" },
          actor: { id: "wa:+123" },
          text: "approve always",
        },
      },
      ctx,
    );

    expect(result.reply?.text).toContain("remember");
    expect(sendFrameToProcessMock).toHaveBeenNthCalledWith(
      2,
      "pid-1",
      expect.objectContaining({
        call: "proc.hil",
        args: expect.objectContaining({
          requestId: "hil-3",
          decision: "approve",
          remember: true,
        }),
      }),
    );
  });

  it("adapter.inbound routes normal messages through a surface route", async () => {
    sendFrameToProcessMock
      .mockResolvedValueOnce({
        type: "res",
        id: "history-1",
        ok: true,
        data: { pendingHil: null },
      } as any)
      .mockImplementationOnce(async (_pid: string, frame: any) => ({
        type: "res",
        id: frame.id,
        ok: true,
        data: {
          ok: true,
          status: "started",
          runId: frame.args.runId,
          queued: false,
        },
      } as any));

    const service = {
      adapterSetActivity: vi.fn(async () => ({ ok: true as const })),
    };
    const status = { upsert: vi.fn() };
    const ctx = makeContext(
      {
        CHANNEL_WHATSAPP: service,
      },
      status,
      { routePid: "pid-1" },
    );

    await handleAdapterInbound(
      {
        adapter: "whatsapp",
        accountId: "primary",
        message: {
          messageId: "msg-5",
          surface: { kind: "dm", id: "dm-1" },
          actor: { id: "wa:+123" },
          text: "hello routed process",
        },
      },
      ctx,
    );

    expect(ctx.adapters.surfaceRoutes.resolvePid).toHaveBeenCalledWith({
      adapter: "whatsapp",
      accountId: "primary",
      actorId: "wa:+123",
      surfaceKind: "dm",
      surfaceId: "dm-1",
      threadId: undefined,
      uid: 1000,
    });
    expect(sendFrameToProcessMock).toHaveBeenNthCalledWith(
      2,
      "pid-1",
      expect.objectContaining({
        call: "proc.adapter.deliver",
        args: expect.objectContaining({ message: "hello routed process" }),
      }),
    );
  });

  it("adapter.inbound routes /use personal to the default conversation", async () => {
    const status = { upsert: vi.fn() };
    const ctx = makeContext({}, status, { routePid: "pid-1" });

    const result = await handleAdapterInbound(
      {
        adapter: "whatsapp",
        accountId: "primary",
        message: {
          messageId: "msg-6",
          surface: { kind: "dm", id: "dm-1" },
          actor: { id: "wa:+123" },
          text: "/use personal",
        },
      },
      ctx,
    );

    expect(result.reply?.text).toContain("personal conversation");
    expect(ctx.adapters.surfaceRoutes.setRoute).toHaveBeenCalledWith({
      adapter: "whatsapp",
      accountId: "primary",
      actorId: "wa:+123",
      surfaceKind: "dm",
      surfaceId: "dm-1",
      threadId: undefined,
      uid: 1000,
      pid: "pid-1",
      updatedByUid: 1000,
    });
    expect(sendFrameToProcessMock).not.toHaveBeenCalled();
  });

  it("adapter.inbound routes a dm to a listed process with /use", async () => {
    const status = { upsert: vi.fn() };
    const ctx = makeContext({}, status, { routePid: null });

    const result = await handleAdapterInbound(
      {
        adapter: "whatsapp",
        accountId: "primary",
        message: {
          messageId: "msg-7",
          surface: { kind: "dm", id: "dm-1" },
          actor: { id: "wa:+123" },
          text: "/use pid-1",
        },
      },
      ctx,
    );

    expect(result.reply?.text).toContain("pid-1");
    expect(ctx.adapters.surfaceRoutes.setRoute).toHaveBeenCalledWith({
      adapter: "whatsapp",
      accountId: "primary",
      actorId: "wa:+123",
      surfaceKind: "dm",
      surfaceId: "dm-1",
      threadId: undefined,
      uid: 1000,
      pid: "pid-1",
      updatedByUid: 1000,
    });
    expect(sendFrameToProcessMock).not.toHaveBeenCalled();
  });

  it("adapter.inbound reports current route with /where", async () => {
    const status = { upsert: vi.fn() };
    const ctx = makeContext({}, status, { routePid: "pid-1" });

    const result = await handleAdapterInbound(
      {
        adapter: "whatsapp",
        accountId: "primary",
        message: {
          messageId: "msg-8",
          surface: { kind: "dm", id: "dm-1" },
          actor: { id: "wa:+123" },
          text: "/where",
        },
      },
      ctx,
    );

    expect(result.reply?.text).toContain("routed to");
    expect(sendFrameToProcessMock).not.toHaveBeenCalled();
  });

  it("adapter.inbound starts and routes to an agent with /use agent-name", async () => {
    const status = { upsert: vi.fn() };
    const ctx = makeContext({}, status, { routePid: null });

    const result = await handleAdapterInbound(
      {
        adapter: "whatsapp",
        accountId: "primary",
        message: {
          messageId: "msg-9",
          surface: { kind: "dm", id: "dm-1" },
          actor: { id: "wa:+123" },
          text: "/use helper",
        },
      },
      ctx,
    );

    expect(result.reply?.text).toContain("helper");
    expect(ctx.procs.spawn).toHaveBeenCalledWith(
      expect.stringMatching(/^proc:/),
      expect.objectContaining({ username: "helper" }),
      expect.objectContaining({ ownerUid: 1000, interactive: true }),
    );
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      expect.stringMatching(/^proc:/),
      expect.objectContaining({
        call: "proc.setidentity",
        args: expect.objectContaining({
          identity: expect.objectContaining({ username: "helper" }),
          conversationId: "conv-agent",
        }),
      }),
    );
    expect(ctx.adapters.surfaceRoutes.setRoute).toHaveBeenCalledWith({
      adapter: "whatsapp",
      accountId: "primary",
      actorId: "wa:+123",
      surfaceKind: "dm",
      surfaceId: "dm-1",
      threadId: undefined,
      uid: 1000,
      pid: expect.stringMatching(/^proc:/),
      updatedByUid: 1000,
    });
  });

  it("forwards the original outbound body without reading it and cancels after delivery", async () => {
    const getReader = vi.fn();
    const cancel = vi.fn(async () => undefined);
    const body = {
      length: 3,
      stream: {
        locked: false,
        getReader,
        cancel,
      } as unknown as ReadableStream<Uint8Array>,
    };
    const adapterSend = vi.fn(async (
      _accountId: string,
      _message: unknown,
      forwardedBody: unknown,
    ) => {
      expect(forwardedBody).toBe(body);
      expect(getReader).not.toHaveBeenCalled();
      return { ok: true as const, messageId: "outbound-1" };
    });
    const ctx = makeContext({
      CHANNEL_WHATSAPP: { adapterSend },
    }, { upsert: vi.fn() });

    const result = await handleAdapterSend({
      adapter: "whatsapp",
      accountId: "primary",
      deliveryId: "outbound-body-1",
      surface: { kind: "dm", id: "dm-1" },
      text: "photo",
      media: [{
        type: "image",
        mimeType: "image/png",
        size: 3,
        body: { offset: 0, length: 3 },
      }],
    }, ctx, body);

    expect(result).toEqual({
      ok: true,
      adapter: "whatsapp",
      accountId: "primary",
      surfaceId: "dm-1",
      deliveryId: "outbound-body-1",
      messageId: "outbound-1",
      deliveryState: "sent",
    });
    expect(adapterSend).toHaveBeenCalledWith(
      "primary",
      expect.objectContaining({
        surface: { kind: "dm", id: "dm-1" },
        media: [expect.objectContaining({ body: { offset: 0, length: 3 } })],
      }),
      body,
    );
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("classifies adapter service RPC throws as retryable transport failures", async () => {
    const adapterSend = vi.fn(async () => {
      throw new Error("service binding disconnected");
    });
    const ctx = makeContext({
      CHANNEL_TELEGRAM: { adapterSend },
    }, { upsert: vi.fn() });

    const result = await handleAdapterSend({
      adapter: "telegram",
      accountId: "bot",
      deliveryId: "retryable-delivery-1",
      surface: { kind: "dm", id: "chat-42" },
      text: "retry safely",
    }, ctx);

    expect(adapterSend).toHaveBeenCalledWith(
      "bot",
      expect.objectContaining({ deliveryId: "retryable-delivery-1" }),
      undefined,
    );
    expect(result).toEqual({
      ok: false,
      error: "Telegram delivery is temporarily unavailable",
      deliveryId: "retryable-delivery-1",
      retryable: true,
    });

    const generated = await handleAdapterSend({
      adapter: "telegram",
      accountId: "bot",
      surface: { kind: "dm", id: "chat-42" },
      text: "retry with generated id",
    }, ctx);
    expect(generated).toMatchObject({
      ok: false,
      deliveryId: expect.stringMatching(/^[a-f0-9-]+$/),
      retryable: true,
    });
  });

  it.each([
    ["surface kind", { surface: { kind: "room", id: "chat-42" } }, "surface.kind is invalid"],
    ["surface id", { surface: { kind: "dm", id: 42 } }, "surface.id is required"],
    ["text", { text: 42 }, "text must be a string"],
    ["reply id", { replyToId: 42 }, "replyToId must be a string"],
    ["duplicate acknowledgement", { also: "true" }, "also must be a boolean"],
    ["delivery id", { deliveryId: 42 }, "Adapter deliveryId is invalid"],
  ])("rejects malformed outbound %s values before adapter I/O", async (
    _label,
    patch,
    expectedError,
  ) => {
    const adapterSend = vi.fn(async () => ({ ok: true as const, messageId: "msg-1" }));
    const cancel = vi.fn(async () => undefined);
    const body = {
      length: 0,
      stream: {
        locked: false,
        cancel,
      } as unknown as ReadableStream<Uint8Array>,
    };
    const ctx = makeContext({ CHANNEL_TELEGRAM: { adapterSend } }, { upsert: vi.fn() });
    const args = {
      adapter: "telegram",
      accountId: "bot",
      surface: { kind: "dm", id: "chat-42" },
      text: "hello",
      ...patch,
    } as unknown as Parameters<typeof handleAdapterSend>[0];

    await expect(handleAdapterSend(args, ctx, body)).resolves.toEqual({
      ok: false,
      error: expectedError,
      retryable: false,
    });
    expect(adapterSend).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("denies adapter.send for non-root users without a linked account", async () => {
    const adapterSend = vi.fn(async () => ({ ok: true as const, messageId: "msg-1" }));
    const status = {
      upsert: vi.fn(),
      list: vi.fn(() => []),
    };
    const ctx = makeContext({ CHANNEL_WHATSAPP: { adapterSend } }, status, {
      identity: {
        role: "user",
        process: {
          uid: 1000,
          gid: 1000,
          gids: [1000],
          username: "sam",
          home: "/home/sam",
          cwd: "/home/sam",
        },
        capabilities: ["adapter.send"],
      },
      identityLinks: {
        list: vi.fn(() => []),
      },
    });

    const result = await handleAdapterSend({
      adapter: "WhatsApp",
      accountId: "primary",
      surface: { kind: "dm", id: "wa:+123" },
      text: "hello",
    }, ctx);

    expect(result).toEqual({ ok: false, error: "Permission denied", retryable: false });
    expect(adapterSend).not.toHaveBeenCalled();
  });

  it("allows adapter.send for non-root users with a linked account", async () => {
    const adapterSend = vi.fn(async () => ({ ok: true as const, messageId: "msg-1" }));
    const status = {
      upsert: vi.fn(),
      list: vi.fn(() => []),
    };
    const ctx = makeContext({ CHANNEL_WHATSAPP: { adapterSend } }, status, {
      identity: {
        role: "user",
        process: {
          uid: 1000,
          gid: 1000,
          gids: [1000],
          username: "sam",
          home: "/home/sam",
          cwd: "/home/sam",
        },
        capabilities: ["adapter.send"],
      },
      identityLinks: {
        list: vi.fn(() => [{
          adapter: "whatsapp",
          accountId: "primary",
          actorId: "wa:+123",
          uid: 1000,
          linkedByUid: 1000,
          createdAt: 1,
          metadata: { surfaceKind: "dm", surfaceId: "wa:+123" },
        }]),
      },
    });

    const result = await handleAdapterSend({
      adapter: "WhatsApp",
      accountId: "primary",
      deliveryId: "explicit-linked-1",
      surface: { kind: "dm", id: "wa:+123" },
      text: "hello",
    }, ctx);

    expect(result).toEqual({
      ok: true,
      adapter: "whatsapp",
      accountId: "primary",
      surfaceId: "wa:+123",
      deliveryId: "explicit-linked-1",
      messageId: "msg-1",
      deliveryState: "sent",
    });
    expect(adapterSend).toHaveBeenCalledWith("primary", {
      deliveryId: "explicit-linked-1",
      surface: { kind: "dm", id: "wa:+123" },
      text: "hello",
      media: undefined,
      replyToId: undefined,
    }, undefined);
  });

  it("denies adapter.send to an unlinked surface on the same account", async () => {
    const adapterSend = vi.fn(async () => ({ ok: true as const, messageId: "msg-1" }));
    const status = {
      upsert: vi.fn(),
      list: vi.fn(() => []),
    };
    const ctx = makeContext({ CHANNEL_WHATSAPP: { adapterSend } }, status, {
      identity: {
        role: "user",
        process: {
          uid: 1000,
          gid: 1000,
          gids: [1000],
          username: "sam",
          home: "/home/sam",
          cwd: "/home/sam",
        },
        capabilities: ["adapter.send"],
      },
      identityLinks: {
        list: vi.fn(() => [{
          adapter: "whatsapp",
          accountId: "primary",
          actorId: "wa:+123",
          uid: 1000,
          linkedByUid: 1000,
          createdAt: 1,
          metadata: { surfaceKind: "dm", surfaceId: "wa:+123" },
        }]),
      },
    });

    const result = await handleAdapterSend({
      adapter: "WhatsApp",
      accountId: "primary",
      surface: { kind: "dm", id: "wa:+999" },
      text: "hello",
    }, ctx);

    expect(result).toEqual({ ok: false, error: "Permission denied", retryable: false });
    expect(adapterSend).not.toHaveBeenCalled();
  });

  it("allows adapter.send to the linked challenge surface", async () => {
    const adapterSend = vi.fn(async () => ({ ok: true as const, messageId: "msg-1" }));
    const status = {
      upsert: vi.fn(),
      list: vi.fn(() => []),
    };
    const ctx = makeContext({ CHANNEL_DISCORD: { adapterSend } }, status, {
      identity: {
        role: "user",
        process: {
          uid: 1000,
          gid: 1000,
          gids: [1000],
          username: "sam",
          home: "/home/sam",
          cwd: "/home/sam",
        },
        capabilities: ["adapter.send"],
      },
      identityLinks: {
        list: vi.fn(() => [{
          adapter: "discord",
          accountId: "bot",
          actorId: "discord:user:42",
          uid: 1000,
          linkedByUid: 1000,
          createdAt: 1,
          metadata: {
            surfaceKind: "dm",
            surfaceId: "discord:dm:99",
          },
        }]),
      },
    });

    const result = await handleAdapterSend({
      adapter: "Discord",
      accountId: "bot",
      surface: { kind: "dm", id: "discord:dm:99" },
      text: "hello",
    }, ctx);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      adapter: "discord",
      accountId: "bot",
      messageId: "msg-1",
    }));
    expect(adapterSend).toHaveBeenCalled();
  });

  it("allows adapter.send to a routed surface owned by the caller", async () => {
    const adapterSend = vi.fn(async () => ({ ok: true as const, messageId: "msg-1" }));
    const status = {
      upsert: vi.fn(),
      list: vi.fn(() => []),
    };
    const ctx = makeContext({ CHANNEL_DISCORD: { adapterSend } }, status, {
      surfaceRoute: {
        adapter: "discord",
        accountId: "bot",
        surfaceKind: "channel",
        surfaceId: "channel-1",
        uid: 1000,
        pid: "pid-1",
        updatedAt: 1,
        updatedByUid: 1000,
      },
      identity: {
        role: "user",
        process: {
          uid: 1000,
          gid: 1000,
          gids: [1000],
          username: "sam",
          home: "/home/sam",
          cwd: "/home/sam",
        },
        capabilities: ["adapter.send"],
      },
      identityLinks: {
        list: vi.fn(() => [{
          adapter: "discord",
          accountId: "bot",
          actorId: "discord:user:42",
          uid: 1000,
          linkedByUid: 1000,
          createdAt: 1,
          metadata: {
            surfaceKind: "dm",
            surfaceId: "discord:dm:99",
          },
        }]),
      },
    });

    const result = await handleAdapterSend({
      adapter: "Discord",
      accountId: "bot",
      surface: { kind: "channel", id: "channel-1" },
      text: "hello channel",
    }, ctx);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      adapter: "discord",
      accountId: "bot",
      messageId: "msg-1",
    }));
    expect(adapterSend).toHaveBeenCalled();
  });

  it("uses the caller owner uid when adapter.send runs from an agent process", async () => {
    const adapterSend = vi.fn(async () => ({ ok: true as const, messageId: "msg-1" }));
    const listLinks = vi.fn(() => [{
      adapter: "whatsapp",
      accountId: "primary",
      actorId: "wa:+123",
      uid: 1000,
      linkedByUid: 1000,
      createdAt: 1,
      metadata: { surfaceKind: "dm", surfaceId: "wa:+123" },
    }]);
    const status = {
      upsert: vi.fn(),
      list: vi.fn(() => []),
    };
    const ctx = makeContext({ CHANNEL_WHATSAPP: { adapterSend } }, status, {
      callerOwnerUid: 1000,
      identity: {
        role: "user",
        process: {
          uid: 1001,
          gid: 1001,
          gids: [1000],
          username: "sam-agent",
          home: "/home/sam-agent",
          cwd: "/home/sam-agent",
        },
        capabilities: ["adapter.send"],
      },
      identityLinks: {
        list: listLinks,
      },
    });

    const result = await handleAdapterSend({
      adapter: "WhatsApp",
      accountId: "primary",
      surface: { kind: "dm", id: "wa:+123" },
      text: "hello",
    }, ctx);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      adapter: "whatsapp",
      accountId: "primary",
      messageId: "msg-1",
    }));
    expect(listLinks).toHaveBeenCalledWith(1000);
    expect(adapterSend).toHaveBeenCalled();
  });

  it("requires an explicit --also acknowledgement for the active reply destination", async () => {
    const adapterSend = vi.fn(async () => ({ ok: true as const, messageId: "msg-2" }));
    const link = {
      adapter: "telegram",
      accountId: "bot",
      actorId: "user-42",
      uid: 1000,
      linkedByUid: 1000,
      createdAt: 1,
      metadata: { surfaceKind: "dm", surfaceId: "chat-42" },
    };
    const ctx = makeContext({ CHANNEL_TELEGRAM: { adapterSend } }, {
      upsert: vi.fn(),
      list: vi.fn(() => []),
    }, {
      processId: "pid-1",
      processRunId: "run-1",
      runRoute: {
        kind: "adapter",
        runId: "run-1",
        processId: "pid-1",
        uid: 1000,
        adapter: "telegram",
        accountId: "bot",
        actorId: "user-42",
        surfaceKind: "dm",
        surfaceId: "chat-42",
        createdAt: 1,
        expiresAt: 2,
      },
      identity: userIdentity(),
      identityLinks: {
        list: vi.fn(() => [link]),
        get: vi.fn(() => link),
      },
    });

    await expect(handleAdapterSend({
      adapter: "telegram",
      accountId: "bot",
      surface: { kind: "dm", id: "chat-42" },
      text: "duplicate",
    }, ctx)).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("automatic reply destination"),
      retryable: false,
    });
    expect(adapterSend).not.toHaveBeenCalled();

    await expect(handleAdapterSend({
      adapter: "telegram",
      accountId: "bot",
      surface: { kind: "dm", id: "chat-42" },
      text: "intentional extra",
      also: true,
    }, ctx)).resolves.toEqual(expect.objectContaining({ ok: true, messageId: "msg-2" }));
    expect(adapterSend).toHaveBeenCalledTimes(1);
  });

  it("forwards reply threading and sanitizes automatic reply delivery failures", async () => {
    const adapterSend = vi.fn(async () => ({
      ok: false as const,
      error: "Telegram API 400 chat_id=chat-42: raw provider response",
      retryable: true,
    }));
    const link = {
      adapter: "telegram",
      accountId: "bot",
      actorId: "user-42",
      uid: 1000,
      linkedByUid: 1000,
      createdAt: 1,
      metadata: { surfaceKind: "dm", surfaceId: "chat-42" },
    };
    const ctx = makeContext({
      CHANNEL_TELEGRAM: { adapterSend },
    }, { upsert: vi.fn() }, {
      identityLinks: { get: vi.fn(() => link) },
    });
    const destination = {
      kind: "adapter" as const,
      adapter: "telegram",
      accountId: "bot",
      actorId: "user-42",
      surface: { kind: "dm" as const, id: "chat-42" },
    };

    const result = await deliverAdapterReply(
      destination,
      1000,
      {
        deliveryId: "run-1:finished",
        text: "automatic reply",
        replyToId: "incoming-7",
      },
      ctx,
    );

    expect(adapterSend).toHaveBeenCalledWith(
      "bot",
      {
        deliveryId: "run-1:finished",
        surface: { kind: "dm", id: "chat-42" },
        actorId: "user-42",
        text: "automatic reply",
        media: undefined,
        replyToId: "incoming-7",
      },
      undefined,
    );
    expect(result).toEqual({
      ok: false,
      error: "Telegram delivery is temporarily unavailable",
      deliveryId: "run-1:finished",
      retryable: true,
    });
  });

  it("rechecks the linked actor before delivering an automatic reply", async () => {
    const adapterSend = vi.fn(async () => ({ ok: true as const, messageId: "msg-3" }));
    const getLink = vi.fn(() => null);
    const ctx = makeContext({ CHANNEL_TELEGRAM: { adapterSend } }, {
      upsert: vi.fn(),
      list: vi.fn(() => []),
    }, {
      processId: "pid-1",
      identity: userIdentity(),
      identityLinks: { get: getLink },
    });
    const destination = {
      kind: "adapter" as const,
      adapter: "telegram",
      accountId: "bot",
      actorId: "user-42",
      surface: { kind: "dm" as const, id: "chat-42" },
    };

    await expect(deliverAdapterReply(destination, 1000, { text: "hello" }, ctx)).resolves.toEqual({
      ok: false,
      error: "Adapter destination is not authorized",
    });
    expect(adapterSend).not.toHaveBeenCalled();
  });
});
