import { describe, it, expect, vi, beforeEach } from "vitest";
import type { KernelContext } from "./context";
import {
  handleAdapterConnect,
  handleAdapterDisconnect,
  handleAdapterInbound,
  handleAdapterList,
  handleAdapterSend,
  handleAdapterStatus,
} from "./adapter-handlers";
import { sendFrameToProcess } from "../shared/utils";

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
  callerOwnerUid?: number;
};

function makeStorageBucket() {
  return {
    head: vi.fn(async () => null),
    put: vi.fn(async () => undefined),
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

  return {
    env: {
      STORAGE: makeStorageBucket(),
      ...env,
    },
    processId: options.processId,
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
      status,
      identityLinks: {
        resolveUid: vi.fn(() => 1000),
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
        setRoute: vi.fn(),
        clearRoute: vi.fn(() => Boolean(options.routePid === undefined ? "pid-1" : options.routePid)),
      },
    },
    runRoutes: {
      setAdapterRoute: vi.fn(),
    },
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

  it("adapter.list discovers deployed adapter bindings and cached accounts", () => {
    const whatsappService = {
      adapterConnect: vi.fn(),
      adapterDisconnect: vi.fn(),
      adapterSend: vi.fn(),
      adapterStatus: vi.fn(),
      adapterShellExec: vi.fn(),
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
        supportsShellExec: true,
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
    ];
    const status = {
      upsert: vi.fn(),
      list: vi.fn((adapter: string, accountId?: string) =>
        rows.filter((row) => row.adapter === adapter && (!accountId || row.accountId === accountId))
      ),
      listAll: vi.fn(() => rows),
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

    const status = { upsert: vi.fn() };
    const ctx = makeContext(
      {
        CHANNEL_WHATSAPP: service,
      },
      status,
    );

    const result = await handleAdapterConnect(
      { adapter: "whatsapp", accountId: "default" },
      ctx,
    );

    expect(service.adapterConnect).toHaveBeenCalledWith("default", undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
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

    const status = { upsert: vi.fn() };
    const ctx = makeContext(
      {
        CHANNEL_DISCORD: service,
      },
      status,
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

    const status = { upsert: vi.fn() };
    const ctx = makeContext(
      {
        CHANNEL_WHATSAPP: service,
      },
      status,
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

  it("returns an error when adapter binding is missing", async () => {
    const status = { upsert: vi.fn() };
    const ctx = makeContext({}, status);

    const result = await handleAdapterConnect(
      { adapter: "unknown", accountId: "default" },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Adapter service unavailable");
    }
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
      .mockResolvedValueOnce({
        type: "res",
        id: "send-1",
        ok: true,
        data: {
          ok: true,
          status: "started",
          runId: "run-1",
          queued: false,
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
        runId: "run-1",
        queued: false,
      },
    });
    expect(sendFrameToProcessMock).toHaveBeenNthCalledWith(
      2,
      "pid-1",
      expect.objectContaining({
        call: "proc.send",
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
      .mockResolvedValueOnce({
        type: "res",
        id: "send-1",
        ok: true,
        data: {
          ok: true,
          status: "started",
          runId: "run-routed",
          queued: false,
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

    expect(ctx.adapters.surfaceRoutes.resolvePid).toHaveBeenCalledWith("whatsapp", "primary", "dm", "dm-1", 1000);
    expect(sendFrameToProcessMock).toHaveBeenNthCalledWith(
      2,
      "pid-1",
      expect.objectContaining({
        call: "proc.send",
        args: expect.objectContaining({ message: "hello routed process" }),
      }),
    );
  });

  it("adapter.inbound clears the route with /use personal", async () => {
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
    expect(ctx.adapters.surfaceRoutes.clearRoute).toHaveBeenCalledWith("whatsapp", "primary", "dm", "dm-1");
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
    expect(ctx.adapters.surfaceRoutes.setRoute).toHaveBeenCalledWith(
      "whatsapp",
      "primary",
      "dm",
      "dm-1",
      1000,
      "pid-1",
      1000,
    );
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
    expect(ctx.adapters.surfaceRoutes.setRoute).toHaveBeenCalledWith(
      "whatsapp",
      "primary",
      "dm",
      "dm-1",
      1000,
      expect.stringMatching(/^proc:/),
      1000,
    );
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

    expect(result).toEqual({ ok: false, error: "Permission denied" });
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
          metadata: null,
        }]),
      },
    });

    const result = await handleAdapterSend({
      adapter: "WhatsApp",
      accountId: "primary",
      surface: { kind: "dm", id: "wa:+123" },
      text: "hello",
    }, ctx);

    expect(result).toEqual({
      ok: true,
      adapter: "whatsapp",
      accountId: "primary",
      surfaceId: "wa:+123",
      messageId: "msg-1",
    });
    expect(adapterSend).toHaveBeenCalledWith("primary", {
      surface: { kind: "dm", id: "wa:+123" },
      text: "hello",
      media: undefined,
      replyToId: undefined,
    });
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
          metadata: null,
        }]),
      },
    });

    const result = await handleAdapterSend({
      adapter: "WhatsApp",
      accountId: "primary",
      surface: { kind: "dm", id: "wa:+999" },
      text: "hello",
    }, ctx);

    expect(result).toEqual({ ok: false, error: "Permission denied" });
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
      metadata: null,
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
});
