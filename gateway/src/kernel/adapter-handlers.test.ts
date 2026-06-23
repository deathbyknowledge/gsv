import { describe, it, expect, vi, beforeEach } from "vitest";
import type { KernelContext } from "./context";
import {
  handleAdapterConnect,
  handleAdapterDisconnect,
  handleAdapterInbound,
  handleAdapterList,
} from "./adapter-handlers";
import { sendFrameToProcess } from "../shared/utils";

vi.mock("../shared/utils", () => ({
  sendFrameToProcess: vi.fn(),
}));

type FakeAdapterStatusStore = {
  upsert: ReturnType<typeof vi.fn>;
  listAll?: ReturnType<typeof vi.fn>;
};
type MakeContextOptions = {
  routePid?: string | null;
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
    mounts: [],
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
      },
      linkChallenges: {
        issue: vi.fn(() => ({
          code: "ABCD",
          expiresAt: Date.now() + 60_000,
        })),
      },
      surfaceRoutes: {
        resolvePid: vi.fn(() => options.routePid === undefined ? "pid-1" : options.routePid),
        setRoute: vi.fn(),
        clearRoute: vi.fn(() => Boolean(options.routePid === undefined ? "pid-1" : options.routePid)),
      },
    },
    runRoutes: {
      setAdapterRoute: vi.fn(),
    },
    identity: {
      role: "service",
      service: "test",
      capabilities: [],
    },
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
});
