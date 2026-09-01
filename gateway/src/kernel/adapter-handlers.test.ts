function isString<T>(value: T): value is T & string { return String(value) === value; }

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { KernelContext } from "./context";
import {
  handleAdapterConnect,
  handleAdapterDisconnect,
  deliverAdapterDestination,
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  handleAdapterInbound as handleAdapterInboundImpl,
  handleAdapterList,
  handleAdapterPairConfirm,
  handleAdapterPairDisconnect,
  handleAdapterPairInfo,
  handleAdapterPairInspect,
  handleAdapterSend,
  handleAdapterStateUpdate,
  handleAdapterStatus,
  setAdapterActivityForKernel,
} from "./adapter-handlers";
import * as sharedUtils from "../shared/utils";
import * as personalController from "./personal-controller";
import {
  bodyFromBytes,
  bodyToBytes,
  type AdapterInboundArgs,
  type BinaryBody,
  type ConversationSummary,
  type JsonObject,
} from "@humansandmachines/gsv/protocol";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { PrivateAdapterDestinationStore } from "./private-adapter-destinations";
import type {
  AdapterService,
  AdapterServiceDescriptor,
} from "../adapter-interface";
import type { SurfaceRouteRecord } from "./surface-routes";
import type { IdentityLinkRecord } from "./identity-links";
import type { AdapterStatusRecord } from "./adapter-status";

const ensurePersonalControllerMock = vi.spyOn(personalController, "ensurePersonalController");
const getConversationByIdMock = vi.spyOn(sharedUtils, "getConversationById");
const sendFrameToProcessMock = vi.spyOn(sharedUtils, "sendFrameToProcess");

type FakeAdapterStatusStore = {
  upsert: ReturnType<typeof vi.fn>;
  list?: ReturnType<typeof vi.fn>;
  listAll?: ReturnType<typeof vi.fn>;
};
type MakeContextOptions = {
  identity?: KernelContext["identity"];
  identityLinks?: { get?: (adapter: string, accountId: string, actorId: string) => IdentityLinkRecord | null };
  routePid?: string | null;
  surfaceRoute?: Partial<SurfaceRouteRecord> | null;
  processId?: string;
  processRunId?: string;
  runRoute?: { get?: (runId: string) => object | null } | null;
  ingressReceipts?: { prepare?: (...args: never[]) => void };
  callerOwnerUid?: number;
  installationId?: KernelContext["installationId"];
  processState?: "idle" | "queued" | "running" | "waiting_tool" | "waiting_hil";
  connection?: KernelContext["connection"];
  installationIdentity?: KernelContext["installationIdentity"];
  request?: KernelContext["request"];
};
// SAFETY: test fixture is constructed with the asserted kernel domain shape.
const TEST_INSTALLATION_ID = "singleton" as KernelContext["installationId"];

function successfulAdapterFrame(adapter: string, messageId: string) {
  return vi.fn(async (
    _installation: Parameters<NonNullable<AdapterService["adapterFrame"]>>[0],
    context: Parameters<NonNullable<AdapterService["adapterFrame"]>>[1],
    frame: Parameters<NonNullable<AdapterService["adapterFrame"]>>[2],
  ) => {
    if (frame.type !== "req" || frame.call !== "adapter.send") {
      throw new Error("Expected an adapter.send request frame");
    }
    return {
      type: "res" as const,
      id: frame.id,
      ok: true as const,
      data: {
        ok: true as const,
        adapter,
        accountId: context.accountId,
        surfaceId: context.surface.id,
        deliveryId: context.deliveryId,
        messageId,
        deliveryState: "sent" as const,
      },
    };
  });
}

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

function makeConversationRegistry() {
  const conversations = new Map<string, ConversationSummary>();
  const shipByOwner = new Map<number, string>();
  const workByProcess = new Map<string, string>();
  const groupBySurface = new Map<string, string>();
  const create = (
    ownerUid: number,
    handlerPid: string,
    kind: ConversationSummary["kind"],
    title: string | null,
  ) => {
    const now = Date.now();
    const conversation: ConversationSummary = {
      id: `conv:${crypto.randomUUID()}`,
      ownerUid,
      kind,
      title,
      handlerPid,
      latestSequence: 0,
      createdAt: now,
      updatedAt: now,
    };
    conversations.set(conversation.id, conversation);
    return conversation;
  };
  return {
    ensureShip: vi.fn((ownerUid: number, handlerPid: string) => {
      const id = shipByOwner.get(ownerUid);
      const existing = id ? conversations.get(id)! : null;
      if (existing) {
        existing.handlerPid = handlerPid;
        return { ...existing };
      }
      const conversation = create(ownerUid, handlerPid, "ship", "Ship");
      shipByOwner.set(ownerUid, conversation.id);
      return { ...conversation };
    }),
    ensureWork: vi.fn((ownerUid: number, handlerPid: string, title: string | null) => {
      const id = workByProcess.get(handlerPid);
      if (id) return { ...conversations.get(id)! };
      const conversation = create(ownerUid, handlerPid, "work", title);
      workByProcess.set(handlerPid, conversation.id);
      return { ...conversation };
    }),
    ensureGroup: vi.fn((ownerUid: number, handlerPid: string, title: string | null, surface: string) => {
      const id = groupBySurface.get(surface);
      if (id) {
        const existing = conversations.get(id)!;
        existing.handlerPid = handlerPid;
        return { ...existing };
      }
      const conversation = create(ownerUid, handlerPid, "group", title);
      groupBySurface.set(surface, conversation.id);
      return { ...conversation };
    }),
    get: vi.fn((id: string) => {
      const conversation = conversations.get(id);
      return conversation ? { ...conversation } : null;
    }),
    list: vi.fn((ownerUid: number) => [...conversations.values()]
      .filter((conversation) => conversation.ownerUid === ownerUid)
      .map((conversation) => ({ ...conversation }))),
    recordSequence: vi.fn((id: string, sequence: number) => {
      const conversation = conversations.get(id);
      if (conversation) conversation.latestSequence = Math.max(conversation.latestSequence, sequence);
    }),
  };
}

function handleAdapterInbound(
  args: Omit<AdapterInboundArgs, "deliveryId"> & { deliveryId?: string },
  ctx: KernelContext,
  body?: BinaryBody,
) {
  return handleAdapterInboundImpl({
    ...args,
    deliveryId: args.deliveryId ?? args.message.messageId,
  }, ctx, body);
}

function retainedAdapterResource(
  frameId: string,
  {
    contentType = "image/png",
    mediaType = "image" as const,
    filename,
    size = 1,
    digest = "a",
  }: {
    contentType?: string;
    mediaType?: "image" | "audio" | "video" | "document";
    filename?: string;
    size?: number;
    digest?: string;
  } = {},
) {
  return {
    type: "res" as const,
    id: frameId,
    ok: true as const,
    data: {
      resource: {
        type: "resource" as const,
        ref: {
          type: "file" as const,
          target: "gsv",
          path: `/home/sam/.gsv/media/archived-media:${digest.repeat(64)}`,
          revision: `"${digest.repeat(32)}"`,
          contentType,
          size,
        },
        mediaType,
        filename,
      },
    },
  };
}

function makeContext(
  env: Partial<Env>,
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
    isPersonalController: true,
    gid: personalAgent.gid,
    gids: [human.gid],
    username: personalAgent.username,
    home: personalAgent.home,
    cwd: personalAgent.home,
    state: options.processState ?? "idle",
    activeRunId: null,
    queuedCount: 0,
    lastActiveAt: null,
    label: "sam-agent (sam)",
    parentPid: null,
    createdAt: 1,
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
    result?: JsonObject;
    claimToken: string;
    active: boolean;
    recovery?: JsonObject;
  }>();
  const privateMessageOrder: Array<{
    adapter: string;
    accountId: string;
    surfaceId: string;
    threadId: string;
    messageId: string;
  }> = [];
  const ingressReceiptStore = {
    claim: vi.fn((input: {
      receiptId: string;
      adapter: string;
      accountId: string;
      surfaceKind: string;
      surfaceId: string;
      threadId?: string;
      providerMessageId: string;
    }) => {
      const existing = ingressReceipts.get(input.receiptId);
      if (!existing) {
        const claimToken = `claim:${input.receiptId}`;
        ingressReceipts.set(input.receiptId, {
          state: "in_progress",
          claimToken,
          active: true,
        });
        if (input.surfaceKind === "dm") {
          privateMessageOrder.push({
            adapter: input.adapter,
            accountId: input.accountId,
            surfaceId: input.surfaceId,
            threadId: input.threadId ?? "",
            messageId: input.providerMessageId,
          });
        }
        return { state: "claimed", receiptId: input.receiptId, claimToken };
      }
      if (existing.state === "completed") {
        return {
          state: "completed",
          receiptId: input.receiptId,
          result: existing.result,
        };
      }
      if (existing.active) {
        return { state: "in_progress", receiptId: input.receiptId };
      }
      existing.active = true;
      existing.claimToken = `${existing.claimToken}:reclaimed`;
      return existing.result
        ? {
            state: "prepared",
            receiptId: input.receiptId,
            claimToken: existing.claimToken,
            result: existing.result,
          }
        : {
            state: "claimed",
            receiptId: input.receiptId,
            claimToken: existing.claimToken,
            ...(existing.recovery !== undefined ? { recovery: existing.recovery } : undefined),
          };
    }),
    prepare: vi.fn((receiptId: string, claimToken: string, result: JsonObject) => {
      const existing = ingressReceipts.get(receiptId);
      if (!existing || existing.claimToken !== claimToken) {
        throw new Error(`receipt is not owned: ${receiptId}`);
      }
      existing.result = result;
    }),
    checkpoint: vi.fn((receiptId: string, claimToken: string, recovery: JsonObject) => {
      const existing = ingressReceipts.get(receiptId);
      if (!existing || existing.claimToken !== claimToken) {
        throw new Error(`receipt is not owned: ${receiptId}`);
      }
      existing.recovery = recovery;
    }),
    complete: vi.fn((receiptId: string, claimToken: string) => {
      const existing = ingressReceipts.get(receiptId);
      if (!existing || existing.claimToken !== claimToken || !existing.result) {
        throw new Error(`receipt is not owned: ${receiptId}`);
      }
      existing.state = "completed";
      existing.active = false;
    }),
    abandon: vi.fn((receiptId: string, claimToken: string) => {
      const existing = ingressReceipts.get(receiptId);
      if (existing?.claimToken === claimToken) {
        existing.active = false;
      }
    }),
    isLatestPrivateMessage: vi.fn((destination: {
      adapter: string;
      accountId: string;
      surface: { id: string; threadId?: string };
    }, messageId: string) => {
      const matches = privateMessageOrder.filter((entry) => (
        entry.adapter === destination.adapter
        && entry.accountId === destination.accountId
        && entry.surfaceId === destination.surface.id
        && entry.threadId === (destination.surface.threadId ?? "")
      ));
      return matches.at(-1)?.messageId === messageId;
    }),
    ...options.ingressReceipts,
  };
  let surfaceRoute = options.surfaceRoute
    ? { mode: "surface", ...options.surfaceRoute }
    : options.routePid !== undefined && options.routePid !== null
      ? {
          adapter: "whatsapp",
          accountId: "primary",
          actorId: "wa:+123",
          surfaceKind: "dm",
          surfaceId: "dm-1",
          uid: human.uid,
          pid: options.routePid,
          mode: "work",
          updatedAt: 1,
          updatedByUid: human.uid,
        }
      : null;
  const resolveSurfaceRoute = vi.fn((key: { uid: number }) => (
    surfaceRoute && surfaceRoute.uid === key.uid ? surfaceRoute : null
  ));
  const setSurfaceRoute = vi.fn((input: Partial<SurfaceRouteRecord>) => {
    surfaceRoute = { ...input, updatedAt: Date.now() };
    return surfaceRoute;
  });
  const clearSurfaceRoute = vi.fn(() => {
    const cleared = surfaceRoute !== null;
    surfaceRoute = null;
    return cleared;
  });
  const clearSurfaceRouteIfMatches = vi.fn((input: { pid: string; mode: string }) => {
    if (surfaceRoute?.pid !== input.pid || surfaceRoute.mode !== input.mode) {
      return false;
    }
    surfaceRoute = null;
    return true;
  });
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  const configuredIdentityLinkGet = options.identityLinks?.get != null
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    ? options.identityLinks.get as (adapter: string, accountId: string, actorId: string) => any
    : () => null;

  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  return {
    installationId: options.installationId ?? TEST_INSTALLATION_ID,
    env: {
      STORAGE: makeStorageBucket(),
      ...env,
    },
    processId: options.processId,
    processRunId: options.processRunId,
    connection: options.connection,
    installationIdentity: options.installationIdentity,
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
        username === personalAgent.username
          || username === helperAgent.username
          ? { username, hash: "!", lastchanged: "", min: "", max: "", warn: "", inactive: "", expire: "", reserved: "" }
          : { username, hash: "$hash", lastchanged: "", min: "", max: "", warn: "", inactive: "", expire: "", reserved: "" }
      )),
      getGroupByGid: vi.fn((gid: number) => {
        if (gid === personalAgent.gid) return { name: personalAgent.username, gid, members: [human.username] };
        if (gid === helperAgent.gid) return { name: helperAgent.username, gid, members: [human.username] };
        if (gid === human.gid) {
          return {
            name: human.username,
            gid,
            members: [personalAgent.username, helperAgent.username],
          };
        }
        return null;
      }),
      getGroupByName: vi.fn(() => null),
      resolveGids: vi.fn((_username: string, gid: number) => (
        gid === human.gid ? [gid] : [gid, human.gid]
      )),
      getPersonalAgentUid: vi.fn(() => personalAgent.uid),
      isPersonalAgentUid: vi.fn((uid: number) => uid === personalAgent.uid),
    },
    caps: {
      resolve: vi.fn(() => ["proc.list"]),
    },
    procs: {
      get: vi.fn((pid: string) => pid === "pid-1" ? processRecord : null),
      getOwnerUid: vi.fn((pid: string) => pid === "pid-1" ? human.uid : null),
      getPersonalController: vi.fn((ownerUid: number) => ownerUid === human.uid ? processRecord : null),
      list: vi.fn(() => [processRecord]),
      spawn: vi.fn(),
      kill: vi.fn(() => true),
    },
    conversations: makeConversationRegistry(),
    adapters: {
      status: {
        get: vi.fn(() => null),
        setOwner: vi.fn(),
        markReadyForOwner: vi.fn(),
        beginLifecycle: vi.fn(),
        endLifecycle: vi.fn(),
        isLifecycleActive: vi.fn(() => false),
        listByOwner: vi.fn(() => []),
        ...status,
      },
      identityLinks: {
        resolveUid: vi.fn(() => 1000),
        get: vi.fn(configuredIdentityLinkGet),
        bindSurfaceIfMissing: vi.fn((adapter, accountId, actorId, surface) => {
          const existing = configuredIdentityLinkGet(adapter, accountId, actorId);
          if (!existing) return null;
          if (
            isString(existing.metadata?.surfaceKind)
            || isString(existing.metadata?.surfaceId)
          ) {
            return existing;
          }
          return {
            ...existing,
            metadata: {
              ...existing.metadata,
              surfaceKind: surface.kind,
              surfaceId: surface.id,
              ...(surface.threadId ? { threadId: surface.threadId } : undefined),
            },
          };
        }),
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
        resolvePid: vi.fn((key: { uid: number }) => resolveSurfaceRoute(key)?.pid ?? null),
        resolveRoute: resolveSurfaceRoute,
        get: vi.fn(() => surfaceRoute),
        list: vi.fn(() => surfaceRoute ? [surfaceRoute] : []),
        setRoute: setSurfaceRoute,
        clearRoute: clearSurfaceRoute,
        clearRouteIfMatches: clearSurfaceRouteIfMatches,
        clearLegacyForProcess: vi.fn(),
      },
      privateDestinations: {
        recordActivity: vi.fn(),
        get: vi.fn(() => null),
        clearIfMatches: vi.fn(() => false),
      },
      ingressReceipts: ingressReceiptStore,
    },
    responsibilities: {
      create: vi.fn(() => ({ created: false })),
      update: vi.fn(() => ({ changed: false })),
      getByDedupeKey: vi.fn(() => null),
      listActiveByDedupeKeyPrefix: vi.fn(() => []),
    },
    responsibilitySources: {
      isEnabled: vi.fn(() => false),
    },
    reconcileResponsibilityWake: vi.fn(async () => undefined),
    runRoutes: {
      setAdapterRoute: vi.fn(),
      get: vi.fn(() => options.runRoute ?? null),
      delete: vi.fn(),
    },
    defer: vi.fn((promise: Promise<unknown>) => {
      void promise;
    }),
    broadcastToUserUid: vi.fn(),
    request: options.request ?? vi.fn(async (frame) => {
      if (frame.call !== "proc.list") {
        return {
          type: "res",
          id: frame.id,
          ok: false,
          error: { code: 404, message: "Unknown syscall" },
        };
      }
      return {
        type: "res",
        id: frame.id,
        ok: true,
        data: {
          processes: [{
            pid: processRecord.processId,
            uid: processRecord.ownerUid,
            username: processRecord.username,
            interactive: processRecord.interactive,
            personal: processRecord.isPersonalController,
            parentPid: processRecord.parentPid,
            state: processRecord.state,
            activeRunId: processRecord.activeRunId,
            queuedCount: processRecord.queuedCount,
            lastActiveAt: processRecord.lastActiveAt,
            label: processRecord.label,
            createdAt: processRecord.createdAt,
            cwd: processRecord.cwd,
          }],
        },
      };
    }),
    identity: options.identity ?? {
      role: "service",
      service: "test",
      capabilities: [],
    },
    callerOwnerUid: options.callerOwnerUid,
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  } as KernelContext;
}


describe("adapter lifecycle handlers", () => {
  beforeEach(() => {
    sendFrameToProcessMock.mockReset();
    ensurePersonalControllerMock.mockReset();
    ensurePersonalControllerMock.mockResolvedValue("pid-1");
    getConversationByIdMock.mockReset();
    const appended = new Map<string, any>();
    let sequence = 0;
    getConversationByIdMock.mockImplementation((_installationId: string, conversationId: string) => ({
      initialize: vi.fn(async () => undefined),
      append: vi.fn(async (input: any) => {
        const existing = appended.get(input.idempotencyKey);
        if (existing) return { created: false, message: existing };
        sequence += 1;
        const message = {
          id: input.messageId,
          conversationId,
          sequence,
          author: input.author,
          text: input.text,
          media: input.media ?? [],
          origin: input.origin,
          processId: input.processId ?? null,
          runId: input.runId ?? null,
          createdAt: input.createdAt,
        };
        appended.set(input.idempotencyKey, message);
        return { created: true, message };
      }),
    }));
  });

  it("notifies root and linked users when adapter state changes", async () => {
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

    await handleAdapterStateUpdate({
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

  it("turns an autonomous authentication loss into Ship work", async () => {
    let stored = {
      adapter: "whatsapp",
      accountId: "primary",
      connected: true,
      authenticated: true,
      lifecycleId: "adapter-account:test",
      readyOwnerUid: 1000,
      ownerUid: 1000,
      updatedAt: 1,
    };
    const status = {
      get: vi.fn(() => stored),
      upsert: vi.fn((_adapter, _accountId, next) => {
        stored = {
          ...stored,
          ...next,
          adapter: "whatsapp",
          ownerUid: 1000,
          updatedAt: 2,
        };
        return stored;
      }),
    };
    const ctx = makeContext({}, status);
    vi.mocked(ctx.responsibilitySources.isEnabled).mockReturnValue(true);
    // SAFETY: the handler reads only the created flag from this responsibility outcome.
    vi.mocked(ctx.responsibilities.create).mockReturnValue({
      created: true,
    } as ReturnType<KernelContext["responsibilities"]["create"]>);

    await handleAdapterStateUpdate({
      adapter: "WhatsApp",
      accountId: "primary",
      status: {
        accountId: "primary",
        connected: false,
        authenticated: false,
      },
    }, ctx);

    expect(ctx.responsibilities.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUid: 1000,
        priority: "high",
        source: expect.objectContaining({ eventType: "adapter.auth_required" }),
      }),
    );
    expect(ctx.reconcileResponsibilityWake).toHaveBeenCalledWith(1000);
  });

  it("adapter.list discovers deployed adapter bindings and cached accounts", async () => {
    const whatsappService = {
      adapterDescribe: vi.fn(async () => ({
        version: 1 as const,
        id: "whatsapp",
        displayName: "WhatsApp",
        capabilities: {
          connect: true,
          disconnect: true,
          send: true,
          status: true,
          activity: true,
          pairing: false,
          surfaces: ["dm"] as const,
          media: { inbound: [] as const, outbound: [] as const },
        },
      })),
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
        CHANNEL_DISCORD: {
          adapterDescribe: vi.fn(async () => ({
            version: 1 as const,
            id: "discord",
            displayName: "Discord",
            capabilities: {
              connect: false,
              disconnect: false,
              send: false,
              status: true,
              activity: false,
              pairing: false,
              surfaces: ["dm"] as const,
              media: { inbound: [] as const, outbound: [] as const },
            },
          })),
        },
      },
      status,
    );

    const result = await handleAdapterList({}, ctx);

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

  it("discovers an arbitrary adapter from its trusted binding and descriptor", async () => {
    const descriptor = {
      version: 1 as const,
      id: "matrix",
      displayName: "Matrix",
      capabilities: {
        connect: true,
        disconnect: true,
        send: true,
        status: true,
        activity: false,
        pairing: false,
        surfaces: ["dm", "group"] as const,
        media: {
          inbound: ["image", "document"] as const,
          outbound: ["image", "document"] as const,
        },
      },
    };
    const ctx = makeContext({
      CHANNEL_MATRIX: { adapterDescribe: vi.fn(async () => descriptor) },
    }, {
      upsert: vi.fn(),
      listAll: vi.fn(() => []),
    });

    expect((await handleAdapterList({}, ctx)).adapters).toEqual([{
      adapter: "matrix",
      available: true,
      descriptor,
      supportsConnect: true,
      supportsDisconnect: true,
      supportsSend: true,
      supportsStatus: true,
      supportsActivity: false,
      supportsPairing: false,
      accounts: [],
    }]);
  });

  it("adapter.list filters cached accounts to non-root identity links", async () => {
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

    const result = await handleAdapterList({}, ctx);

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

  it("adapter.list uses owning human links for agent process callers", async () => {
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

    const result = await handleAdapterList({}, ctx);

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

    expect(adapterStatus).toHaveBeenCalledWith(
      { installationId: TEST_INSTALLATION_ID },
      "primary",
    );
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

  it("ignores malformed live status without persisting or exposing it", async () => {
    const privatePayload = "private-status-payload";
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cached = {
      adapter: "whatsapp",
      accountId: "primary",
      connected: false,
      authenticated: false,
      mode: "websocket",
      lastActivity: 123,
      error: null,
      extra: null,
      updatedAt: 456,
    };
    const status = {
      upsert: vi.fn(),
      list: vi.fn(() => [cached]),
      listAll: vi.fn(() => [cached]),
    };
    const ctx = makeContext({
      CHANNEL_WHATSAPP: {
        adapterStatus: vi.fn(async () => [{
          accountId: "primary",
          connected: true,
          authenticated: "yes",
          privatePayload,
        }]),
      },
    }, status, { identity: userIdentity(0) });

    const result = await handleAdapterStatus(
      { adapter: "whatsapp", accountId: "primary" },
      ctx,
    );

    expect(status.upsert).not.toHaveBeenCalled();
    expect(result.accounts).toEqual([expect.objectContaining({
      accountId: "primary",
      connected: false,
      authenticated: false,
    })]);
    expect(JSON.stringify(result)).not.toContain(privatePayload);
    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({ component: "adapter", event: "status_invalid_response" }),
    );
    errorLog.mockRestore();
  });

  it("keeps cached authentication state when the live status query fails", async () => {
    const cached = {
      adapter: "telegram",
      accountId: "primary",
      connected: true,
      authenticated: true,
      mode: "webhook",
      lastActivity: 123,
      error: null,
      extra: null,
      updatedAt: 456,
    };
    const status = {
      upsert: vi.fn(),
      list: vi.fn(() => [cached]),
      listAll: vi.fn(() => [cached]),
    };
    const ctx = makeContext({
      CHANNEL_TELEGRAM: {
        adapterStatus: vi.fn(async () => {
          throw new Error("temporary account RPC failure");
        }),
      },
    }, status, { identity: userIdentity(0) });

    const result = await handleAdapterStatus(
      { adapter: "telegram", accountId: "primary" },
      ctx,
    );

    expect(status.upsert).not.toHaveBeenCalled();
    expect(ctx.responsibilities.create).not.toHaveBeenCalled();
    expect(result.accounts).toEqual([expect.objectContaining({
      accountId: "primary",
      connected: true,
      authenticated: true,
    })]);
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
    expect(adapterStatus).toHaveBeenCalledWith(
      { installationId: TEST_INSTALLATION_ID },
      "bot",
    );
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
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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

    expect(service.adapterConnect).toHaveBeenCalledWith(
      { installationId: TEST_INSTALLATION_ID },
      "default",
      undefined,
    );
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

  it("uses one installation-scoped adapter service contract", async () => {
    const installationId = "inst_adapter_rpc";
    const installation = { installationId };
    const adapterConnect = vi.fn(async () => ({
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      ok: true as const,
      connected: true,
      authenticated: true,
    }));
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const adapterDisconnect = vi.fn(async () => ({ ok: true as const }));
    const adapterFrame = successfulAdapterFrame("whatsapp", "managed-message-1");
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const adapterSetActivity = vi.fn(async () => ({ ok: true as const }));
    const adapterStatus = vi.fn(async () => [{
      accountId: "primary",
      connected: true,
      authenticated: true,
    }]);
    const service = {
      adapterConnect,
      adapterDisconnect,
      adapterFrame,
      adapterSetActivity,
      adapterStatus,
    };
    const ctx = makeContext(
      { CHANNEL_WHATSAPP: service },
      {
        get: vi.fn(() => ({ ownerUid: 1000 })),
        upsert: vi.fn(),
      },
      {
        identity: userIdentity(0),
        installationId,
      },
    );

    await expect(handleAdapterConnect({
      adapter: "whatsapp",
      accountId: "primary",
    }, ctx)).resolves.toMatchObject({ ok: true });
    await expect(handleAdapterDisconnect({
      adapter: "whatsapp",
      accountId: "primary",
    }, ctx)).resolves.toMatchObject({ ok: true });
    await expect(handleAdapterSend({
      adapter: "whatsapp",
      accountId: "primary",
      deliveryId: "managed-delivery-1",
      surface: { kind: "dm", id: "dm-1" },
      text: "hello",
    }, ctx)).resolves.toMatchObject({ ok: true });
    await setAdapterActivityForKernel(
      ctx.env,
      installationId,
      "whatsapp",
      "primary",
      { kind: "dm", id: "dm-1" },
      { kind: "typing", active: true },
    );

    expect(adapterConnect).toHaveBeenCalledWith(installation, "primary", undefined);
    expect(adapterStatus).toHaveBeenCalledWith(installation, "primary");
    expect(adapterDisconnect).toHaveBeenCalledWith(installation, "primary");
    expect(adapterFrame).toHaveBeenCalledWith(
      installation,
      expect.objectContaining({
        accountId: "primary",
        deliveryId: "managed-delivery-1",
      }),
      expect.objectContaining({
        type: "req",
        call: "adapter.send",
        args: expect.objectContaining({ deliveryId: "managed-delivery-1" }),
      }),
    );
    expect(adapterSetActivity).toHaveBeenCalledWith(
      installation,
      "primary",
      { kind: "dm", id: "dm-1" },
      { kind: "typing", active: true },
    );
  });

  it("does not let an account-scoped status refresh mutate another account", async () => {
    const status = {
      get: vi.fn(() => ({ ownerUid: 1000 })),
      upsert: vi.fn(),
    };
    const ctx = makeContext({
      CHANNEL_WHATSAPP: {
        adapterConnect: vi.fn(async () => ({
          // SAFETY: test fixture is constructed with the asserted kernel domain shape.
          ok: true as const,
          connected: true,
          authenticated: true,
        })),
        adapterStatus: vi.fn(async () => [
          { accountId: "primary", connected: true, authenticated: true },
          { accountId: "other", connected: true, authenticated: true },
        ]),
      },
    }, status, { identity: userIdentity() });

    await expect(handleAdapterConnect(
      { adapter: "whatsapp", accountId: "primary" },
      ctx,
    )).resolves.toMatchObject({ ok: true, accountId: "primary" });

    expect(status.upsert).not.toHaveBeenCalledWith(
      "whatsapp",
      "other",
      expect.anything(),
    );
  });

  it("adapter.connect returns error when binding does not implement connect", async () => {
    const service = {
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
    ["missing result discriminator", { connected: true }],
    ["missing connection state", { ok: true, message: "Connected" }],
    ["empty failure error", { ok: false, error: "" }],
    ["malformed QR challenge", {
      ok: true,
      challenge: { type: "qr", format: "raw", data: "" },
    }],
  ])("adapter.connect rejects a %s without exposing worker data", async (_label, workerResult) => {
    const privatePayload = "private-pairing-payload-must-not-leak";
    const adapterConnect = vi.fn(async () => ({ ...workerResult, privatePayload }));
    const ctx = makeContext(
      { CHANNEL_WHATSAPP: { adapterConnect } },
      {
        get: vi.fn(() => ({ ownerUid: 1000 })),
        upsert: vi.fn(),
      },
      { identity: userIdentity() },
    );

    const result = await handleAdapterConnect(
      { adapter: "whatsapp", accountId: "default" },
      ctx,
    );

    expect(result).toEqual({
      ok: false,
      error: "Adapter returned an invalid connect response: whatsapp",
    });
    expect(JSON.stringify(result)).not.toContain(privatePayload);
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
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
            // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
          // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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

  it("retains a new ownership claim and sanitizes interrupted adapter RPCs", async () => {
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
      .resolves.toEqual({ ok: false, error: "Adapter connect failed: discord" });
    expect(setOwner).toHaveBeenCalledWith("discord", "default", 1000);
    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({ component: "adapter", event: "connect_worker_failed" }),
    );
    errorLog.mockRestore();
  });

  it("allows only the owner or root to disconnect an adapter account", async () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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

  it("cancels authentication recovery after an owned adapter disconnect", async () => {
    let stored: AdapterStatusRecord = {
      adapter: "whatsapp",
      accountId: "default",
      connected: false,
      authenticated: false,
      lifecycleId: "adapter-account:owned-disconnect",
      readyOwnerUid: 1000,
      ownerUid: 1000,
      updatedAt: 1,
    };
    const status = {
      get: vi.fn(() => stored),
      upsert: vi.fn((adapter: string, accountId: string, next) => {
        stored = {
          ...stored,
          ...next,
          adapter,
          accountId,
          updatedAt: stored.updatedAt + 1,
        };
        return stored;
      }),
      beginLifecycle: vi.fn(),
      endLifecycle: vi.fn(),
    };
    const ctx = makeContext({
      CHANNEL_WHATSAPP: {
        adapterDisconnect: vi.fn(async () => ({ ok: true as const })),
      },
    }, status, { identity: userIdentity() });
    vi.mocked(ctx.responsibilities.listActiveByDedupeKeyPrefix).mockReturnValue([
      // SAFETY: the lifecycle helper reads only the responsibility identity from this fixture.
      { id: "r12y:authentication" } as ReturnType<
        KernelContext["responsibilities"]["listActiveByDedupeKeyPrefix"]
      >[number],
    ]);
    // SAFETY: the lifecycle helper reads only the changed flag from this update result.
    vi.mocked(ctx.responsibilities.update).mockReturnValue({
      changed: true,
    } as ReturnType<KernelContext["responsibilities"]["update"]>);

    await expect(handleAdapterDisconnect({
      adapter: "whatsapp",
      accountId: "default",
    }, ctx)).resolves.toMatchObject({ ok: true });

    expect(ctx.responsibilities.update).toHaveBeenCalledWith(expect.objectContaining({
      ownerUid: 1000,
      id: "r12y:authentication",
      patch: expect.objectContaining({
        state: "cancelled",
        resolution: expect.objectContaining({ eventType: "adapter.disconnected" }),
      }),
    }));
  });

  it("rejects malformed disconnect results without exposing worker data", async () => {
    const privatePayload = "private-disconnect-payload";
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const status = {
      upsert: vi.fn(),
      get: vi.fn(() => ({ ownerUid: 1000 })),
      beginLifecycle: vi.fn(),
      endLifecycle: vi.fn(),
    };
    const ctx = makeContext({
      CHANNEL_WHATSAPP: {
        adapterDisconnect: vi.fn(async () => ({
          // SAFETY: test fixture is constructed with the asserted kernel domain shape.
          ok: true as const,
          message: 42,
          privatePayload,
        })),
      },
    }, status, { identity: userIdentity() });

    const result = await handleAdapterDisconnect(
      { adapter: "whatsapp", accountId: "default" },
      ctx,
    );

    expect(result).toEqual({
      ok: false,
      error: "Adapter returned an invalid disconnect response: whatsapp",
    });
    expect(JSON.stringify(result)).not.toContain(privatePayload);
    expect(status.upsert).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({ component: "adapter", event: "disconnect_invalid_response" }),
    );
    errorLog.mockRestore();
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
    expect(ctx.adapters.privateDestinations.recordActivity).not.toHaveBeenCalled();
    expect(ctx.runRoutes.setAdapterRoute).not.toHaveBeenCalled();
    expect(sendFrameToProcessMock).not.toHaveBeenCalled();
  });

  it("admits an addressed group and preallocates its reply route before Process delivery", async () => {
    const ctx = makeContext({
      CHANNEL_DISCORD: {
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        adapterSetActivity: vi.fn(async () => ({ ok: true as const })),
      },
    }, { upsert: vi.fn() }, {
      surfaceRoute: {
        adapter: "discord",
        accountId: "primary",
        actorId: "discord:user:42",
        surfaceKind: "group",
        surfaceId: "shared-channel",
        uid: 1000,
        pid: "pid-1",
        mode: "surface",
        updatedAt: 1,
        updatedByUid: 1000,
      },
    });
    let admittedRunId = "";
    sendFrameToProcessMock.mockImplementation(async (_installationId: string, _pid: string, frame: any) => {
      if (frame.call === "proc.history") {
        return { type: "res", id: frame.id, ok: true, data: { pendingHil: null } };
      }
      if (frame.call === "proc.adapter.deliver") {
        admittedRunId = frame.args.runId;
        expect(ctx.runRoutes.setAdapterRoute).toHaveBeenCalledWith({
          runId: admittedRunId,
          processId: "pid-1",
          uid: 1000,
          destination: {
            kind: "adapter",
            adapter: "discord",
            accountId: "primary",
            actorId: "discord:user:42",
            surface: {
              kind: "group",
              id: "shared-channel",
              threadId: undefined,
            },
          },
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const adapterSetActivity = vi.fn(async () => ({ ok: true as const }));
    const ctx = makeContext({
      CHANNEL_TELEGRAM: {
        adapterSetActivity,
      },
    }, { upsert: vi.fn() });
    const deliveredRunIds: string[] = [];
    sendFrameToProcessMock.mockImplementation(async (_installationId: string, _pid: string, frame: any) => {
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
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        surface: { kind: "dm" as const, id: "chat-42" },
        actor: { id: "telegram:user:42" },
        text: "Please remind me tomorrow.",
      },
    };

    const first = await handleAdapterInbound(inbound, ctx);
    const cancelReplayBody = vi.fn(async () => undefined);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const retry = await handleAdapterInbound({
      ...inbound,
      message: {
        ...inbound.message,
        media: [{
          // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      } as ReadableStream<Uint8Array>,
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
    expect(adapterSetActivity).not.toHaveBeenCalled();
  });

  it("upgrades an in-flight legacy Process delivery checkpoint", async () => {
    const legacyRecovery = {
      kind: "process_delivery",
      uid: 1000,
      pid: "pid-1",
      runId: "adapter-run:legacy",
      media: [],
      origin: {
        kind: "adapter",
        adapter: "telegram",
        accountId: "bot",
        actorId: "telegram:user:42",
        surface: { kind: "dm", id: "chat-42" },
      },
    };
    const checkpoint = vi.fn();
    const ctx = makeContext({}, { upsert: vi.fn() }, {
      ingressReceipts: {
        claim: vi.fn(() => ({
          state: "claimed",
          receiptId: "adapter-ingress:legacy",
          claimToken: "claim:legacy",
          recovery: legacyRecovery,
        })),
        checkpoint,
        prepare: vi.fn(),
        complete: vi.fn(),
        abandon: vi.fn(),
      },
    });
    sendFrameToProcessMock.mockImplementation(async (
      _installationId: string,
      _pid: string,
      frame: any,
    ) => ({
      type: "res",
      id: frame.id,
      ok: true,
      data: {
        ok: true,
        status: "started",
        runId: legacyRecovery.runId,
        queued: false,
      },
    }));

    const result = await handleAdapterInbound({
      adapter: "telegram",
      accountId: "bot",
      deliveryId: "legacy-provider-delivery",
      message: {
        messageId: "legacy-provider-message",
        surface: { kind: "dm", id: "chat-42" },
        actor: { id: "telegram:user:42" },
        text: "resume after deploy",
      },
    }, ctx);

    expect(result).toMatchObject({
      ok: true,
      delivered: { uid: 1000, pid: "pid-1", runId: legacyRecovery.runId },
    });
    expect(checkpoint).toHaveBeenCalledWith(
      "adapter-ingress:legacy",
      "claim:legacy",
      expect.objectContaining({
        ...legacyRecovery,
        conversationId: expect.stringMatching(/^conv:/),
        inputMessageId: expect.stringMatching(/^msg:/),
        messageCreatedAt: expect.any(Number),
      }),
    );
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      TEST_INSTALLATION_ID,
      "pid-1",
      expect.objectContaining({
        call: "proc.adapter.deliver",
        args: expect.objectContaining({
          interaction: expect.objectContaining({
            conversationId: expect.stringMatching(/^conv:/),
            messageId: expect.stringMatching(/^msg:/),
          }),
        }),
      }),
    );
  });

  it("replays completed commands across actor alias normalization", async () => {
    const ctx = makeContext({}, { upsert: vi.fn() });
    const inbound = {
      adapter: "whatsapp",
      accountId: "primary",
      message: {
        messageId: "command-once",
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        surface: { kind: "dm" as const, id: "dm-1" },
        actor: { id: "wa:lid:123" },
        text: "/help",
      },
    };

    const first = await handleAdapterInbound(inbound, ctx);
    const replay = await handleAdapterInbound({
      ...inbound,
      message: {
        ...inbound.message,
        actor: { id: "wa:+123" },
      },
    }, ctx);

    expect(first.reply?.deliveryId).toMatch(/^adapter-ingress:[0-9a-f]{64}:reply$/);
    expect(replay).toEqual({ ...first, replayed: "completed" });
    expect(ctx.adapters.surfaceRoutes.setRoute).not.toHaveBeenCalled();
    expect(sendFrameToProcessMock).not.toHaveBeenCalled();
  });

  it("keeps equal WhatsApp stanza ids distinct across group participants", async () => {
    const ctx = makeContext({}, { upsert: vi.fn() }, {
      surfaceRoute: {
        adapter: "whatsapp",
        accountId: "primary",
        actorId: "wa:lid:a",
        surfaceKind: "group",
        surfaceId: "group@g.us",
        uid: 1000,
        pid: "pid-1",
        mode: "surface",
        updatedAt: 1,
        updatedByUid: 1000,
      },
    });
    sendFrameToProcessMock.mockImplementation(async (
      _installationId: string,
      _pid: string,
      frame: any,
    ) => {
      if (frame.call === "proc.history") {
        return { type: "res", id: frame.id, ok: true, data: { pendingHil: null } };
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
            queued: false,
          },
        };
      }
      throw new Error(`Unexpected call: ${frame.call}`);
    });
    const base = {
      adapter: "whatsapp",
      accountId: "primary",
      message: {
        messageId: "client-stanza",
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        surface: { kind: "group" as const, id: "group@g.us" },
        text: "/use personal",
        wasMentioned: true,
      },
    };

    const first = await handleAdapterInbound({
      ...base,
      deliveryId: "group@g.us:participant-a:client-stanza",
      message: { ...base.message, actor: { id: "wa:lid:a" } },
    }, ctx);
    const second = await handleAdapterInbound({
      ...base,
      deliveryId: "group@g.us:participant-b:client-stanza",
      message: { ...base.message, actor: { id: "wa:lid:b" } },
    }, ctx);

    expect(first.delivered?.runId).not.toBe(second.delivered?.runId);
    expect(sendFrameToProcessMock.mock.calls.filter(([, , frame]) =>
      frame.call === "proc.adapter.deliver"
    )).toHaveLength(2);
  });

  it("reclaims a prepared command reply after completion is interrupted", async () => {
    const ctx = makeContext({}, { upsert: vi.fn() });
    const receipts = ctx.adapters.ingressReceipts;
    const completePrepared = receipts.complete.bind(receipts);
    let completionAttempts = 0;
    receipts.complete = vi.fn((receiptId, claimToken) => {
      completionAttempts++;
      if (completionAttempts === 1) {
        throw new Error("completion interrupted");
      }
      completePrepared(receiptId, claimToken);
    });
    const inbound = {
      adapter: "whatsapp",
      accountId: "primary",
      message: {
        messageId: "command-outbox-retry",
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        surface: { kind: "dm" as const, id: "dm-1" },
        actor: { id: "wa:+123" },
        text: "/help",
      },
    };

    await expect(handleAdapterInbound(inbound, ctx)).rejects.toThrow("completion interrupted");
    const replay = await handleAdapterInbound(inbound, ctx);

    expect(replay).toMatchObject({
      ok: true,
      replayed: "completed",
      reply: { text: expect.stringContaining("/ship - leave the work session") },
    });
    expect(replay.reply?.text).not.toContain("/work");
    expect(replay.reply?.text).toContain("/list - list Ship and work processes");
    expect(ctx.adapters.surfaceRoutes.setRoute).not.toHaveBeenCalled();
    expect(receipts.complete).toHaveBeenCalledTimes(2);
  });

  it("drops an in-progress replay before identity, routing, media, or Process effects", async () => {
    const claim = vi.fn(() => ({
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      state: "in_progress" as const,
      receiptId: "adapter-ingress:claimed",
    }));
    const ctx = makeContext({}, { upsert: vi.fn() }, {
      ingressReceipts: { claim },
    });
    const cancel = vi.fn(async () => undefined);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const body = {
      length: 1,
      stream: {
        locked: false,
        cancel,
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      } as ReadableStream<Uint8Array>,
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

  it("removes the route without re-entering the adapter for an already-recorded run", async () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const adapterSetActivity = vi.fn(async () => ({ ok: true as const }));
    const ctx = makeContext({
      CHANNEL_TELEGRAM: { adapterSetActivity },
    }, { upsert: vi.fn() });
    sendFrameToProcessMock.mockImplementation(async (_installationId: string, _pid: string, frame: any) => {
      if (frame.call === "proc.history") {
        return { type: "res", id: frame.id, ok: true, data: { pendingHil: null } };
      }
      if (frame.call === "proc.resource.write") {
        await bodyToBytes(frame.body);
        return retainedAdapterResource(frame.id);
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    expect(adapterSetActivity).not.toHaveBeenCalled();
  });

  it("stores adapter media before delivering proc.send", async () => {
    let uploadedBytes: number[] = [];
    let receivedByteStream = false;
    sendFrameToProcessMock.mockImplementation(async (_installationId: string, _pid: string, frame: any) => {
      if (frame.call === "proc.history") {
        return { type: "res", id: frame.id, ok: true, data: { pendingHil: null } };
      }
      if (frame.call === "proc.resource.write") {
        const reader = frame.body.stream.getReader({ mode: "byob" });
        receivedByteStream = true;
        const chunk = await reader.read(new Uint8Array(3));
        uploadedBytes = [...(chunk.value ?? [])];
        const end = await reader.read(new Uint8Array(1));
        expect(end.done).toBe(true);
        reader.releaseLock();
        return retainedAdapterResource(frame.id, { size: 3 });
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
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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

    const upload = sendFrameToProcessMock.mock.calls[0]?.[2];
    expect(upload).toMatchObject({
      call: "proc.resource.write",
      args: { mediaType: "image", contentType: "image/png" },
    });
    expect(upload?.args).not.toHaveProperty("size");
    expect(receivedByteStream).toBe(true);
    expect(uploadedBytes).toEqual([1, 2, 3]);
    expect(sendFrameToProcessMock.mock.calls[1]?.[2]).toMatchObject({
      call: "proc.adapter.deliver",
      args: {
        media: [{
          type: "resource",
          ref: expect.objectContaining({
            type: "file",
            contentType: "image/png",
            size: 3,
          }),
          mediaType: "image",
        }],
      },
    });
  });

  it("stops adapter delivery when a later resource upload fails", async () => {
    sendFrameToProcessMock.mockImplementation(async (_installationId: string, _pid: string, frame: any) => {
      if (frame.call === "proc.history") {
        return { type: "res", id: frame.id, ok: true, data: { pendingHil: null } };
      }
      if (frame.call === "proc.resource.write" && frame.args.filename === "good.png") {
        await bodyToBytes(frame.body);
        return retainedAdapterResource(frame.id, { filename: "good.png" });
      }
      if (frame.call === "proc.resource.write") {
        await bodyToBytes(frame.body);
        return { type: "res", id: frame.id, ok: false, error: { code: 500, message: "upload failed" } };
      }
      throw new Error(`Unexpected call: ${frame.call}`);
    });
    const ctx = makeContext({
      CHANNEL_WHATSAPP: {
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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

    expect(sendFrameToProcessMock.mock.calls.some(([, , frame]) => frame.call === "proc.adapter.deliver")).toBe(false);
  });

  it("preserves adapter uploads when a Process error response leaves admission ambiguous", async () => {
    sendFrameToProcessMock.mockImplementation(async (_installationId: string, _pid: string, frame: any) => {
      if (frame.call === "proc.history") {
        return { type: "res", id: frame.id, ok: true, data: { pendingHil: null } };
      }
      if (frame.call === "proc.resource.write") {
        await bodyToBytes(frame.body);
        return retainedAdapterResource(frame.id);
      }
      if (frame.call === "proc.adapter.deliver") {
        return { type: "res", id: frame.id, ok: false, error: { code: 500, message: "delivery failed" } };
      }
      throw new Error(`Unexpected call: ${frame.call}`);
    });
    const ctx = makeContext({
      CHANNEL_WHATSAPP: {
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        adapterSetActivity: vi.fn(async () => ({ ok: true as const })),
      },
    }, { upsert: vi.fn() });

    await expect(handleAdapterInbound({
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
    }, ctx, bodyFromBytes(new Uint8Array([1])))).rejects.toThrow("delivery failed");

    const preallocatedRunId = vi.mocked(ctx.runRoutes.setAdapterRoute).mock.calls[0]?.[0]?.runId;
    expect(preallocatedRunId).toEqual(expect.any(String));
    expect(ctx.runRoutes.delete).not.toHaveBeenCalled();
  });

  it("reclaims and reconciles an ambiguous Process admission without re-uploading media", async () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const adapterSetActivity = vi.fn(async () => ({ ok: true as const }));
    let deliveryAttempts = 0;
    sendFrameToProcessMock.mockImplementation(async (_installationId: string, _pid: string, frame: any) => {
      if (frame.call === "proc.history") {
        return { type: "res", id: frame.id, ok: true, data: { pendingHil: null } };
      }
      if (frame.call === "proc.resource.write") {
        await bodyToBytes(frame.body);
        return retainedAdapterResource(frame.id);
      }
      if (frame.call === "proc.adapter.deliver") {
        deliveryAttempts++;
        if (deliveryAttempts === 1) {
          throw new Error("Process RPC transport lost");
        }
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: {
            ok: true,
            status: "started",
            runId: frame.args.runId,
            queued: false,
            replayed: "active",
          },
        };
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
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        surface: { kind: "dm" as const, id: "dm-1" },
        actor: { id: "wa:+123" },
        text: "photo",
        media: [{
          // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
    expect(replay).toMatchObject({
      ok: true,
      delivered: { pid: "pid-1", queued: false },
    });

    const preallocatedRunId = vi.mocked(ctx.runRoutes.setAdapterRoute).mock.calls[0]?.[0]?.runId;
    expect(preallocatedRunId).toEqual(expect.any(String));
    expect(ctx.runRoutes.delete).not.toHaveBeenCalled();
    expect(sendFrameToProcessMock.mock.calls.filter(([, , frame]) => (
      frame.call === "proc.adapter.deliver"
    ))).toHaveLength(2);
    expect(sendFrameToProcessMock.mock.calls.filter(([, , frame]) => (
      frame.call === "proc.resource.write"
    ))).toHaveLength(1);
    expect(ctx.adapters.surfaceRoutes.setRoute).not.toHaveBeenCalled();
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    expect(adapterSetActivity).not.toHaveBeenCalled();
  });

  it("delivers approval-looking text as ordinary adapter input", async () => {
    const text = "approve hil[not-a-capability]";
    const ctx = makeContext({}, { upsert: vi.fn() }, { processState: "waiting_hil" });
    sendFrameToProcessMock.mockImplementation(async (_installationId, _pid, frame: any) => {
      if (frame.call !== "proc.adapter.deliver") {
        throw new Error(`Unexpected call: ${frame.call}`);
      }
      expect(frame.args.message).toBe(text);
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
    });

    const result = await handleAdapterInbound({
      adapter: "telegram",
      accountId: "bot",
      message: {
        messageId: "approval-looking-message",
        surface: { kind: "dm", id: "chat-1" },
        actor: { id: "telegram:user:1" },
        text,
      },
    }, ctx);

    expect(result).toMatchObject({ ok: true, delivered: { pid: "pid-1" } });
    expect(sendFrameToProcessMock).toHaveBeenCalledTimes(1);
    expect(sendFrameToProcessMock.mock.calls.some(([, , frame]) => (
      frame.call === "proc.hil"
    ))).toBe(false);
  });

  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  it("does not expose the removed /work command", async () => {
    const status = { upsert: vi.fn() };
    const ctx = makeContext({}, status, { routePid: null });
    const text = "/work helper";

    const result = await handleAdapterInbound(
      {
        adapter: "whatsapp",
        accountId: "primary",
        message: {
          messageId: "msg-9",
          surface: { kind: "dm", id: "dm-1" },
          actor: { id: "wa:+123" },
          text,
        },
      },
      ctx,
    );

    expect(result.reply?.text).toContain(`Unknown command: ${text.split(" ")[0]}`);
    expect(result.reply?.text).not.toContain("/work -");
    expect(result.reply?.text).toContain("/list -");
    expect(ctx.procs.spawn).not.toHaveBeenCalled();
    expect(ctx.adapters.surfaceRoutes.setRoute).not.toHaveBeenCalled();
  });

  it("runs /list through a delegated linked-user peer", async () => {
    const request = vi.fn(async (frame, delegated: KernelContext) => ({
      type: "res" as const,
      id: frame.id,
      ok: true as const,
      data: {
        processes: [{
          pid: "pid-1",
          uid: 1000,
          username: "sam-agent",
          interactive: true,
          personal: true,
          parentPid: null,
          state: "idle" as const,
          activeRunId: null,
          queuedCount: 0,
          lastActiveAt: null,
          label: "Sam",
          createdAt: 1,
          cwd: "/home/sam-agent",
        }],
      },
      delegated,
    }));
    const ctx = makeContext({}, { upsert: vi.fn() }, { request });

    const result = await handleAdapterInbound({
      adapter: "whatsapp",
      accountId: "primary",
      message: {
        messageId: "msg-list",
        surface: { kind: "dm", id: "dm-1" },
        actor: { id: "wa:+123" },
        text: "/list",
      },
    }, ctx);

    expect(result.reply?.text).toContain("[SHIP] Sam [idle] (pid-1)");
    expect(request).toHaveBeenCalledOnce();
    const delegated = request.mock.calls[0][1];
    expect(delegated.peer).toMatchObject({
      peer: {
        principal: { kind: "human", account: { uid: 1000 } },
        grant: { calls: ["proc.list"], signals: [], implements: [] },
      },
      provenance: {
        kind: "adapter-link",
        serviceId: "whatsapp",
        accountId: "primary",
        actorId: "wa:+123",
      },
    });
    expect(delegated.identity).toMatchObject({
      role: "user",
      process: { uid: 1000 },
      capabilities: ["proc.list"],
    });
  });

  it("returns to Ship immediately while a selected work process is still running", async () => {
    const ctx = makeContext({}, { upsert: vi.fn() }, {
      surfaceRoute: {
        adapter: "whatsapp",
        accountId: "primary",
        actorId: "wa:+123",
        surfaceKind: "dm",
        surfaceId: "dm-1",
        uid: 1000,
        pid: "proc:running-work",
        mode: "work",
        updatedAt: 1,
        updatedByUid: 1000,
      },
    });
    const personal = ctx.procs.get("pid-1")!;
    const work = {
      ...personal,
      processId: "proc:running-work",
      isPersonalController: false,
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      state: "running" as const,
      activeRunId: "run-work",
    };
    vi.mocked(ctx.procs.get).mockImplementation((pid: string) => (
      pid === personal.processId ? personal : pid === work.processId ? work : null
    ));
    vi.mocked(ctx.procs.list).mockReturnValue([personal, work]);
    sendFrameToProcessMock.mockImplementation(async (
      _installationId: string,
      _pid: string,
      frame: any,
    ) => ({
      type: "res",
      id: frame.id,
      ok: true,
      data: {
        eventId: frame.args.eventId,
        runId: frame.args.eventId,
        queued: false,
      },
    }));

    const result = await handleAdapterInbound({
      adapter: "whatsapp",
      accountId: "primary",
      message: {
        messageId: "leave-running-work",
        surface: { kind: "dm", id: "dm-1" },
        actor: { id: "wa:+123" },
        text: "/ship",
      },
    }, ctx);

    expect(result.reply?.text).toContain("[SHIP]");
    expect(ctx.adapters.ingressReceipts.checkpoint).toHaveBeenCalledWith(
      expect.stringMatching(/^adapter-ingress:/),
      expect.stringMatching(/^claim:adapter-ingress:/),
      expect.objectContaining({
        kind: "work_return",
        uid: 1000,
        workPid: work.processId,
        route: expect.objectContaining({
          adapter: "whatsapp",
          accountId: "primary",
          actorId: "wa:+123",
          surfaceKind: "dm",
          surfaceId: "dm-1",
          mode: "work",
        }),
      }),
    );
    expect(ctx.adapters.surfaceRoutes.clearRouteIfMatches).toHaveBeenCalledWith(
      expect.objectContaining({
        pid: work.processId,
        mode: "work",
      }),
    );
    expect(ctx.adapters.surfaceRoutes.resolveRoute(expect.anything())).toBeNull();
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      TEST_INSTALLATION_ID,
      personal.processId,
      expect.objectContaining({
        call: "proc.runtime.event.deliver",
        args: {
          eventId: expect.stringMatching(/^adapter-home:adapter-ingress:/),
          event: {
            type: "adapter.work.returned",
            workPid: work.processId,
          },
        },
      }),
    );
    expect(vi.mocked(ctx.adapters.ingressReceipts.checkpoint).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(ctx.adapters.surfaceRoutes.clearRouteIfMatches).mock.invocationCallOrder[0]!);
    expect(ctx.defer).not.toHaveBeenCalled();
  });

  it("retries a failed work-return event against the current personal controller", async () => {
    const ctx = makeContext({}, { upsert: vi.fn() }, {
      surfaceRoute: {
        adapter: "whatsapp",
        accountId: "primary",
        actorId: "wa:+123",
        surfaceKind: "dm",
        surfaceId: "dm-1",
        uid: 1000,
        pid: "proc:unreachable-work",
        mode: "work",
        updatedAt: 1,
        updatedByUid: 1000,
      },
    });
    const originalPersonal = ctx.procs.get("pid-1")!;
    const replacementPersonal = {
      ...originalPersonal,
      processId: "pid-2",
      createdAt: 2,
    };
    vi.mocked(ctx.procs.get).mockImplementation((pid: string) => (
      pid === originalPersonal.processId
        ? originalPersonal
        : pid === replacementPersonal.processId
          ? replacementPersonal
          : null
    ));
    ensurePersonalControllerMock
      .mockResolvedValueOnce(originalPersonal.processId)
      .mockResolvedValueOnce(replacementPersonal.processId);
    // SAFETY: The mocked response is the exact process frame contract consumed by this test.
    sendFrameToProcessMock
      .mockRejectedValueOnce(new Error("process unavailable"))
      .mockImplementationOnce(async (
        _installationId: string,
        _pid: string,
        frame: any,
      ) => ({
        type: "res",
        id: frame.id,
        ok: true,
        data: {
          eventId: frame.args.eventId,
          runId: frame.args.eventId,
          queued: false,
        },
      }));

    const inbound = {
      adapter: "whatsapp",
      accountId: "primary",
      deliveryId: "leave-unreachable-work",
      message: {
        messageId: "leave-unreachable-work",
        surface: { kind: "dm", id: "dm-1" },
        actor: { id: "wa:+123" },
        text: "/ship",
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as const;

    await expect(handleAdapterInbound(inbound, ctx)).rejects.toThrow("process unavailable");
    expect(ctx.adapters.surfaceRoutes.resolveRoute(expect.anything())).toBeNull();

    const recovered = await handleAdapterInbound(inbound, ctx);
    expect(recovered.reply?.text).toContain("[SHIP]");
    expect(recovered.reply?.text).toContain(replacementPersonal.processId.slice(0, 13));
    expect(ctx.adapters.ingressReceipts.checkpoint).toHaveBeenCalledTimes(1);
    expect(ctx.adapters.surfaceRoutes.clearRouteIfMatches).toHaveBeenCalledTimes(2);
    expect(sendFrameToProcessMock).toHaveBeenNthCalledWith(
      1,
      TEST_INSTALLATION_ID,
      originalPersonal.processId,
      expect.objectContaining({
        call: "proc.runtime.event.deliver",
        args: expect.objectContaining({
          eventId: expect.stringMatching(/^adapter-home:adapter-ingress:/),
        }),
      }),
    );
    expect(sendFrameToProcessMock).toHaveBeenNthCalledWith(
      2,
      TEST_INSTALLATION_ID,
      replacementPersonal.processId,
      expect.objectContaining({
        call: "proc.runtime.event.deliver",
        args: expect.objectContaining({
          eventId: expect.stringMatching(/^adapter-home:adapter-ingress:/),
        }),
      }),
    );
    expect(sendFrameToProcessMock.mock.calls[1]?.[2].args.eventId)
      .toBe(sendFrameToProcessMock.mock.calls[0]?.[2].args.eventId);

    expect(await handleAdapterInbound(inbound, ctx)).toEqual({
      ...recovered,
      replayed: "completed",
    });
    expect(sendFrameToProcessMock).toHaveBeenCalledTimes(2);
  });

  it("does not let a recovered home command clear a newer direct line to the same work", async () => {
    const ctx = makeContext({}, { upsert: vi.fn() }, {
      surfaceRoute: {
        adapter: "whatsapp",
        accountId: "primary",
        actorId: "wa:+123",
        surfaceKind: "dm",
        surfaceId: "dm-1",
        uid: 1000,
        pid: "proc:work",
        mode: "work",
        updatedAt: 1,
        updatedByUid: 1000,
      },
    });
    const personal = ctx.procs.get("pid-1")!;
    const work = {
      ...personal,
      processId: "proc:work",
      isPersonalController: false,
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      state: "running" as const,
      activeRunId: "run-work",
    };
    vi.mocked(ctx.procs.get).mockImplementation((pid: string) => (
      pid === personal.processId ? personal : pid === work.processId ? work : null
    ));
    vi.mocked(ctx.procs.list).mockReturnValue([personal, work]);
    sendFrameToProcessMock.mockRejectedValueOnce(new Error("personal process unavailable"));

    const home = {
      adapter: "whatsapp",
      accountId: "primary",
      deliveryId: "home-before-reopen",
      message: {
        messageId: "home-before-reopen",
        surface: { kind: "dm", id: "dm-1" },
        actor: { id: "wa:+123" },
        text: "/ship",
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as const;

    await expect(handleAdapterInbound(home, ctx)).rejects.toThrow(
      "personal process unavailable",
    );
    await handleAdapterInbound({
      adapter: "whatsapp",
      accountId: "primary",
      deliveryId: "newer-private-message",
      message: {
        messageId: "newer-private-message",
        surface: { kind: "dm", id: "dm-1" },
        actor: { id: "wa:+123" },
        text: "/help",
      },
    }, ctx);
    ctx.adapters.surfaceRoutes.setRoute({
      adapter: "whatsapp",
      accountId: "primary",
      actorId: "wa:+123",
      surfaceKind: "dm",
      surfaceId: "dm-1",
      uid: 1000,
      pid: work.processId,
      mode: "work",
      updatedByUid: 1000,
    });

    await expect(handleAdapterInbound(home, ctx)).resolves.toMatchObject({
      ok: true,
      droppedReason: "superseded_work_return",
    });
    expect(ctx.adapters.surfaceRoutes.resolveRoute({ uid: 1000 })).toMatchObject({
      pid: work.processId,
      mode: "work",
    });
    expect(sendFrameToProcessMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "equal timestamps", timestamp: 100, initialNow: 1_000, newerNow: 1_000, retryNow: 1_000 },
    { label: "missing timestamps", timestamp: undefined, initialNow: 1_000, newerNow: 2_000, retryNow: 3_000 },
  ])("does not let recovered /ship activity replace a newer private DM with $label", async ({
    timestamp,
    initialNow,
    newerNow,
    retryNow,
  }) => {
    await runWithRealKernelSql(async (sql) => {
      const links = {
        whatsapp: {
          adapter: "whatsapp",
          accountId: "primary",
          actorId: "wa:+123",
          uid: 1000,
          createdAt: 1,
          linkedByUid: 1000,
          metadata: { surfaceKind: "dm", surfaceId: "dm-a" },
        },
        telegram: {
          adapter: "telegram",
          accountId: "bot",
          actorId: "telegram:user:1",
          uid: 1000,
          createdAt: 1,
          linkedByUid: 1000,
          metadata: { surfaceKind: "dm", surfaceId: "dm-b" },
        },
      };
      const ctx = makeContext({}, { upsert: vi.fn() }, {
        surfaceRoute: {
          adapter: "whatsapp",
          accountId: "primary",
          actorId: "wa:+123",
          surfaceKind: "dm",
          surfaceId: "dm-a",
          uid: 1000,
          pid: "proc:work",
          mode: "work",
          updatedAt: 1,
          updatedByUid: 1000,
        },
        identityLinks: {
          get: vi.fn((adapter: "whatsapp" | "telegram") => links[adapter]),
        },
      });
      const privateDestinations = new PrivateAdapterDestinationStore(sql);
      ctx.adapters.privateDestinations = privateDestinations;
      const personal = ctx.procs.get("pid-1")!;
      const work = {
        ...personal,
        processId: "proc:work",
        isPersonalController: false,
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        state: "running" as const,
        activeRunId: "run-work",
      };
      vi.mocked(ctx.procs.get).mockImplementation((pid: string) => (
        pid === personal.processId ? personal : pid === work.processId ? work : null
      ));
      vi.mocked(ctx.procs.list).mockReturnValue([personal, work]);
      let now = initialNow;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
      sendFrameToProcessMock
        .mockRejectedValueOnce(new Error("personal process unavailable"))
        .mockImplementationOnce(async (
          _installationId: string,
          _pid: string,
          frame: any,
        ) => ({
          type: "res",
          id: frame.id,
          ok: true,
          data: {
            eventId: frame.args.eventId,
            runId: frame.args.eventId,
            queued: false,
          },
        }));

      const home = {
        adapter: "whatsapp",
        accountId: "primary",
        deliveryId: "failed-home-a",
        message: {
          messageId: "failed-home-a",
          surface: { kind: "dm", id: "dm-a" },
          actor: { id: "wa:+123" },
          text: "/ship",
          ...(timestamp === undefined ? undefined : { timestamp }),
        },
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      } as const;

      try {
        await expect(handleAdapterInbound(home, ctx)).rejects.toThrow(
          "personal process unavailable",
        );
        now = newerNow;
        await handleAdapterInbound({
          adapter: "telegram",
          accountId: "bot",
          deliveryId: "newer-dm-b",
          message: {
            messageId: "newer-dm-b",
            surface: { kind: "dm", id: "dm-b" },
            actor: { id: "telegram:user:1" },
            text: "/help",
            ...(timestamp === undefined ? undefined : { timestamp }),
          },
        }, ctx);
        now = retryNow;
        await expect(handleAdapterInbound(home, ctx)).resolves.toMatchObject({
          ok: true,
          reply: { text: expect.stringContaining("[SHIP]") },
        });
      } finally {
        nowSpy.mockRestore();
      }

      expect(privateDestinations.get(1000)).toMatchObject({
        messageId: "newer-dm-b",
        destination: {
          adapter: "telegram",
          accountId: "bot",
          actorId: "telegram:user:1",
          surface: { kind: "dm", id: "dm-b" },
        },
      });
    });
  });

  it("drains an active legacy DM route but clears it once idle", async () => {
    const route = {
      adapter: "telegram",
      accountId: "bot",
      actorId: "telegram:user:1",
      surfaceKind: "dm",
      surfaceId: "chat-1",
      uid: 1000,
      pid: "proc:legacy",
      mode: "legacy",
      updatedAt: 1,
      updatedByUid: 1000,
    };
    const ctx = makeContext({}, { upsert: vi.fn() }, { surfaceRoute: route });
    const personal = ctx.procs.get("pid-1")!;
    let legacy = {
      ...personal,
      processId: route.pid,
      isPersonalController: false,
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      state: "running" as const,
      activeRunId: "run-legacy",
    };
    vi.mocked(ctx.procs.get).mockImplementation((pid: string) => (
      pid === personal.processId ? personal : pid === legacy.processId ? legacy : null
    ));
    vi.mocked(ctx.procs.list).mockImplementation(() => [personal, legacy]);
    sendFrameToProcessMock.mockImplementation(async (
      _installationId: string,
      _pid: string,
      frame: any,
    ) => {
      if (frame.call === "proc.history") {
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: { ok: true, pendingHil: null },
        };
      }
      if (frame.call === "proc.adapter.deliver") {
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: { ok: true, runId: frame.args.runId, queued: false },
        };
      }
      throw new Error(`Unexpected call: ${frame.call}`);
    });

    const first = await handleAdapterInbound({
      adapter: "telegram",
      accountId: "bot",
      message: {
        messageId: "legacy-active",
        surface: { kind: "dm", id: "chat-1" },
        actor: { id: "telegram:user:1" },
        text: "continue old work",
      },
    }, ctx);
    expect(first.delivered?.pid).toBe(legacy.processId);
    expect(ctx.adapters.surfaceRoutes.clearRouteIfMatches).not.toHaveBeenCalled();

    legacy = { ...legacy, state: "idle", activeRunId: null };
    const second = await handleAdapterInbound({
      adapter: "telegram",
      accountId: "bot",
      message: {
        messageId: "legacy-idle",
        surface: { kind: "dm", id: "chat-1" },
        actor: { id: "telegram:user:1" },
        text: "back home",
      },
    }, ctx);
    expect(second.delivered?.pid).toBe(personal.processId);
    expect(ctx.adapters.surfaceRoutes.clearRouteIfMatches).toHaveBeenCalledWith(
      expect.objectContaining({ pid: legacy.processId, mode: "legacy" }),
    );
    expect(ctx.adapters.surfaceRoutes.setRoute).not.toHaveBeenCalled();
  });

  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  it("records only authenticated linked private-DM activity as the owner fallback", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const link = {
      adapter: "telegram",
      accountId: "bot",
      actorId: "telegram:user:1",
      uid: 1000,
      createdAt: 1,
      linkedByUid: 1000,
      metadata: { surfaceKind: "dm", surfaceId: "chat-1" },
    };
    const ctx = makeContext({}, { upsert: vi.fn() }, {
      identityLinks: { get: vi.fn(() => link) },
    });

    await handleAdapterInbound({
      adapter: "telegram",
      accountId: "bot",
      message: {
        messageId: "linked-private-activity",
        surface: { kind: "dm", id: "chat-1" },
        actor: { id: "telegram:user:1" },
        text: "/help",
        timestamp: Number.MAX_SAFE_INTEGER,
      },
    }, ctx);

    expect(ctx.adapters.privateDestinations.recordActivity).toHaveBeenCalledWith(1000, {
      kind: "adapter",
      adapter: "telegram",
      accountId: "bot",
      actorId: "telegram:user:1",
      surface: { kind: "dm", id: "chat-1", threadId: undefined },
    }, "linked-private-activity", 1_800_000_000_000);
    now.mockRestore();
  });

  it("binds a metadata-less manual link to its first authenticated private DM", async () => {
    const manualLink = {
      adapter: "telegram",
      accountId: "bot",
      actorId: "telegram:user:1",
      uid: 1000,
      createdAt: 1,
      linkedByUid: 0,
      metadata: null,
    };
    const boundLink = {
      ...manualLink,
      metadata: { surfaceKind: "dm", surfaceId: "chat-1" },
    };
    const bindSurfaceIfMissing = vi.fn(() => boundLink);
    const ctx = makeContext({}, { upsert: vi.fn() }, {
      identityLinks: {
        get: vi.fn(() => manualLink),
        bindSurfaceIfMissing,
      },
    });
    sendFrameToProcessMock.mockImplementation(async (
      _installationId: string,
      _pid: string,
      frame: any,
    ) => {
      if (frame.call === "proc.history") {
        return { type: "res", id: frame.id, ok: true, data: { pendingHil: null } };
      }
      if (frame.call === "proc.adapter.deliver") {
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: { ok: true, runId: frame.args.runId, queued: false },
        };
      }
      throw new Error(`Unexpected call: ${frame.call}`);
    });

    const result = await handleAdapterInbound({
      adapter: "telegram",
      accountId: "bot",
      message: {
        messageId: "manual-link-first-dm",
        surface: { kind: "dm", id: "chat-1" },
        actor: { id: "telegram:user:1" },
        text: "Hello",
      },
    }, ctx);

    expect(result).toMatchObject({ ok: true, delivered: { pid: "pid-1" } });
    expect(bindSurfaceIfMissing).toHaveBeenCalledWith(
      "telegram",
      "bot",
      "telegram:user:1",
      { kind: "dm", id: "chat-1", threadId: undefined },
    );
    expect(ctx.adapters.privateDestinations.recordActivity).toHaveBeenCalledWith(
      1000,
      expect.objectContaining({
        adapter: "telegram",
        accountId: "bot",
        actorId: "telegram:user:1",
        surface: { kind: "dm", id: "chat-1", threadId: undefined },
      }),
      "manual-link-first-dm",
      expect.any(Number),
    );
  });

  it("converges unrouted private surfaces on the personal controller without persisting routes", async () => {
    sendFrameToProcessMock.mockImplementation(async (
      _installationId: string,
      _pid: string,
      frame: any,
    ) => {
      if (frame.call === "proc.history") {
        return { type: "res", id: frame.id, ok: true, data: { pendingHil: null } };
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
            queued: false,
          },
        };
      }
      throw new Error(`Unexpected call: ${frame.call}`);
    });
    const ctx = makeContext({}, { upsert: vi.fn() }, { routePid: null });

    const first = await handleAdapterInbound({
      adapter: "whatsapp",
      accountId: "primary",
      message: {
        messageId: "mc-1",
        surface: { kind: "dm", id: "dm-1" },
        actor: { id: "wa:+123" },
        text: "Please investigate this.",
      },
    }, ctx);
    const second = await handleAdapterInbound({
      adapter: "telegram",
      accountId: "bot",
      message: {
        messageId: "mc-2",
        surface: { kind: "dm", id: "chat-2" },
        actor: { id: "telegram:user:123" },
        text: "Any updates?",
      },
    }, ctx);

    expect(first).toMatchObject({ ok: true, delivered: { pid: "pid-1" } });
    expect(second).toMatchObject({ ok: true, delivered: { pid: "pid-1" } });
    expect(ctx.procs.spawn).not.toHaveBeenCalled();
    expect(ctx.adapters.surfaceRoutes.setRoute).not.toHaveBeenCalled();
    expect(ensurePersonalControllerMock).toHaveBeenCalledTimes(2);
    expect(sendFrameToProcessMock.mock.calls.filter(([, , frame]) => (
      frame.call === "proc.adapter.deliver"
    ))).toHaveLength(2);
  });

  it("binds managed ingress to its exact peer-route generation", async () => {
    const link = {
      adapter: "telegram",
      accountId: "managed",
      actorId: "12345",
      uid: 1000,
      createdAt: 1,
      linkedByUid: 1000,
      metadata: {
        managed: true,
        surfaceKind: "dm",
        surfaceId: "12345",
        routeGeneration: "generation-current",
      },
    };
    const ctx = makeContext({}, { upsert: vi.fn() }, {
      routePid: null,
      identityLinks: { get: vi.fn(() => link) },
    });
    sendFrameToProcessMock.mockImplementation(async (
      _installationId: string,
      _pid: string,
      frame: any,
    ) => {
      if (frame.call === "proc.history") {
        return { type: "res", id: frame.id, ok: true, data: { pendingHil: null } };
      }
      if (frame.call === "proc.adapter.deliver") {
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: { ok: true, runId: frame.args.runId, queued: false },
        };
      }
      throw new Error(`Unexpected call: ${frame.call}`);
    });

    await expect(handleAdapterInbound({
      adapter: "telegram",
      accountId: "managed",
      routeGeneration: "generation-current",
      message: {
        messageId: "managed-current",
        surface: { kind: "dm", id: "12345" },
        actor: { id: "12345" },
        text: "Hello",
      },
    }, ctx)).resolves.toMatchObject({ ok: true, delivered: { pid: "pid-1" } });
    expect(ctx.runRoutes.setAdapterRoute).toHaveBeenCalledWith(expect.objectContaining({
      routeGeneration: "generation-current",
    }));

    sendFrameToProcessMock.mockClear();
    vi.mocked(ctx.runRoutes.setAdapterRoute).mockClear();
    await expect(handleAdapterInbound({
      adapter: "telegram",
      accountId: "managed",
      routeGeneration: "generation-stale",
      message: {
        messageId: "managed-stale",
        surface: { kind: "dm", id: "12345" },
        actor: { id: "12345" },
        text: "Old delivery",
      },
    }, ctx)).resolves.toEqual({ ok: true, droppedReason: "stale_route_generation" });
    expect(ctx.runRoutes.setAdapterRoute).not.toHaveBeenCalled();
    expect(sendFrameToProcessMock).not.toHaveBeenCalled();
  });

  it("admits an addressed shared surface through an actor-scoped managed route", async () => {
    const link = {
      adapter: "slack",
      accountId: "workspace-1",
      actorId: "U12345",
      uid: 1000,
      createdAt: 1,
      linkedByUid: 1000,
      metadata: {
        managed: true,
        surfaceKind: "dm",
        surfaceId: "D12345",
        routeScope: "actor",
        routeGeneration: "generation-current",
      },
    };
    const ctx = makeContext({}, { upsert: vi.fn() }, {
      identityLinks: { get: vi.fn(() => link) },
      surfaceRoute: {
        adapter: "slack",
        accountId: "workspace-1",
        actorId: "U12345",
        surfaceKind: "channel",
        surfaceId: "C12345",
        threadId: "1724785200.000100",
        uid: 1000,
        pid: "pid-1",
        mode: "surface",
        updatedAt: 1,
        updatedByUid: 1000,
      },
    });
    sendFrameToProcessMock.mockImplementation(async (
      _installationId: string,
      _pid: string,
      frame: any,
    ) => {
      if (frame.call === "proc.history") {
        return { type: "res", id: frame.id, ok: true, data: { pendingHil: null } };
      }
      if (frame.call === "proc.adapter.deliver") {
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: { ok: true, runId: frame.args.runId, queued: false },
        };
      }
      throw new Error(`Unexpected call: ${frame.call}`);
    });

    const current = {
      adapter: "slack",
      accountId: "workspace-1",
      routeGeneration: "generation-current",
      message: {
        messageId: "Ev12345",
        surface: {
          kind: "channel" as const,
          id: "C12345",
          threadId: "1724785200.000100",
        },
        actor: { id: "U12345" },
        text: "please help",
        wasMentioned: true,
      },
    };
    await expect(handleAdapterInbound(current, ctx)).resolves.toMatchObject({
      ok: true,
      delivered: { pid: "pid-1" },
    });
    expect(ctx.runRoutes.setAdapterRoute).toHaveBeenCalledWith(expect.objectContaining({
      routeGeneration: "generation-current",
      destination: expect.objectContaining({
        adapter: "slack",
        actorId: "U12345",
        surface: {
          kind: "channel",
          id: "C12345",
          threadId: "1724785200.000100",
        },
      }),
    }));

    sendFrameToProcessMock.mockClear();
    vi.mocked(ctx.runRoutes.setAdapterRoute).mockClear();
    await expect(handleAdapterInbound({
      ...current,
      routeGeneration: "generation-stale",
      message: { ...current.message, messageId: "Ev12346" },
    }, ctx)).resolves.toEqual({ ok: true, droppedReason: "stale_route_generation" });
    expect(ctx.runRoutes.setAdapterRoute).not.toHaveBeenCalled();
    expect(sendFrameToProcessMock).not.toHaveBeenCalled();
  });

  it("forwards the original outbound body without reading it and cancels after delivery", async () => {
    const getReader = vi.fn();
    const cancel = vi.fn(async () => undefined);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const body = {
      length: 3,
      stream: {
        locked: false,
        getReader,
        cancel,
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      } as ReadableStream<Uint8Array>,
    };
    const adapterFrame: NonNullable<AdapterService["adapterFrame"]> = vi.fn(async (
      _installation,
      context,
      frame,
    ) => {
      if (frame.type !== "req" || frame.call !== "adapter.send") {
        throw new Error("Expected an adapter.send request frame");
      }
      expect(frame.body).toBe(body);
      expect(getReader).not.toHaveBeenCalled();
      return {
        type: "res",
        id: frame.id,
        ok: true,
        data: {
          ok: true,
          adapter: "whatsapp",
          accountId: context.accountId,
          surfaceId: context.surface.id,
          deliveryId: context.deliveryId,
          messageId: "outbound-1",
          deliveryState: "sent",
        },
      };
    });
    const ctx = makeContext({
      CHANNEL_WHATSAPP: { adapterFrame },
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
    expect(adapterFrame).toHaveBeenCalledWith(
      { installationId: TEST_INSTALLATION_ID },
      expect.objectContaining({
        accountId: "primary",
        deliveryId: "outbound-body-1",
        surface: { kind: "dm", id: "dm-1" },
      }),
      expect.objectContaining({
        type: "req",
        call: "adapter.send",
        body,
        args: expect.objectContaining({
          media: [expect.objectContaining({ body: { offset: 0, length: 3 } })],
        }),
      }),
    );
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels an unconsumed body on a mismatched adapter frame response", async () => {
    const cancel = vi.fn();
    const responseBody: BinaryBody = {
      length: 3,
      stream: new ReadableStream<Uint8Array>({ cancel }),
    };
    const descriptor: AdapterServiceDescriptor = {
      version: 1,
      id: "telegram",
      displayName: "Telegram",
      capabilities: {
        connect: true,
        disconnect: true,
        send: true,
        status: true,
        activity: true,
        pairing: false,
        surfaces: ["dm"],
        media: { inbound: [], outbound: [] },
      },
    };
    const adapterFrame: NonNullable<AdapterService["adapterFrame"]> = vi.fn(async (
      _installation,
      _context,
      frame,
    ) => ({
      type: "res",
      id: `${frame.id}:mismatched`,
      ok: true,
      data: { ok: true },
      body: responseBody,
    }));
    const ctx = makeContext({
      CHANNEL_TELEGRAM: {
        adapterDescribe: vi.fn(async () => descriptor),
        adapterFrame,
      },
    }, { upsert: vi.fn() });

    await expect(handleAdapterSend({
      adapter: "telegram",
      accountId: "bot",
      deliveryId: "frame-response-body-1",
      surface: { kind: "dm", id: "chat-42" },
      text: "hello",
    }, ctx)).resolves.toEqual({
      ok: false,
      error: "Telegram delivery is temporarily unavailable",
      deliveryId: "frame-response-body-1",
      retryable: true,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  it("rejects malformed send results without treating string flags as outcomes", async () => {
    const privatePayload = "private-send-payload";
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const adapterFrame: NonNullable<AdapterService["adapterFrame"]> = vi.fn(async (
      _installation,
      _context,
      frame,
    ) => {
      if (frame.type !== "req") throw new Error("Expected a request frame");
      return {
        type: "res",
        id: frame.id,
        ok: true,
        data: {
          ok: false,
          error: "provider failure",
          ambiguous: "yes",
          privatePayload,
        },
      };
    });
    const ctx = makeContext({
      CHANNEL_WHATSAPP: { adapterFrame },
    }, { upsert: vi.fn() });

    const result = await handleAdapterSend({
      adapter: "whatsapp",
      accountId: "primary",
      deliveryId: "invalid-worker-result",
      surface: { kind: "dm", id: "dm-1" },
      text: "hello",
    }, ctx);

    expect(result).toEqual({
      ok: false,
      error: "Adapter returned an invalid adapter.send response: whatsapp",
      deliveryId: "invalid-worker-result",
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain(privatePayload);
    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({ component: "adapter", event: "send_frame_invalid_response" }),
    );
    errorLog.mockRestore();
  });

  it("sanitizes malformed activity results at the gateway boundary", async () => {
    const privatePayload = "private-activity-payload";
    const warningLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ctx = makeContext({
      CHANNEL_WHATSAPP: {
        adapterSetActivity: vi.fn(async () => ({
          // SAFETY: test fixture is constructed with the asserted kernel domain shape.
          ok: false as const,
          error: 42,
          privatePayload,
        })),
      },
    }, { upsert: vi.fn() });

    await setAdapterActivityForKernel(
      ctx.env,
      TEST_INSTALLATION_ID,
      "whatsapp",
      "primary",
      { kind: "dm", id: "dm-1" },
      { kind: "typing", active: true },
    );

    expect(warningLog).toHaveBeenCalledWith(
      JSON.stringify({ component: "adapter", event: "activity_invalid_response" }),
    );
    expect(JSON.stringify(warningLog.mock.calls)).not.toContain(privatePayload);
    warningLog.mockRestore();
  });

  it("accepts twenty outbound attachments and rejects a twenty-first", async () => {
    const adapterFrame = successfulAdapterFrame("telegram", "outbound-20");
    const ctx = makeContext({
      CHANNEL_TELEGRAM: { adapterFrame },
    }, { upsert: vi.fn() });
    const media = Array.from({ length: 20 }, (_, index) => ({
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      type: "document" as const,
      mimeType: "application/pdf",
      filename: `${index + 1}.pdf`,
      url: `https://example.com/${index + 1}.pdf`,
    }));

    await expect(handleAdapterSend({
      adapter: "telegram",
      accountId: "bot",
      surface: { kind: "dm", id: "chat-42" },
      text: "twenty files",
      media,
    }, ctx)).resolves.toMatchObject({ ok: true, messageId: "outbound-20" });

    await expect(handleAdapterSend({
      adapter: "telegram",
      accountId: "bot",
      surface: { kind: "dm", id: "chat-42" },
      text: "twenty-one files",
      media: [...media, {
        type: "document",
        mimeType: "application/pdf",
        filename: "21.pdf",
        url: "https://example.com/21.pdf",
      }],
    }, ctx)).resolves.toMatchObject({
      ok: false,
      error: "Adapter media exceeds item limit (20)",
      retryable: false,
    });
    expect(adapterFrame).toHaveBeenCalledTimes(1);
  });

  it("allows one body-backed attachment to use the complete media byte budget", async () => {
    const maxBytes = 48 * 1024 * 1024;
    const adapterFrame = successfulAdapterFrame("telegram", "outbound-48mib");
    const cancel = vi.fn(async () => undefined);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const body = {
      length: maxBytes,
      stream: {
        locked: false,
        cancel,
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      } as ReadableStream<Uint8Array>,
    };
    const ctx = makeContext({
      CHANNEL_TELEGRAM: { adapterFrame },
    }, { upsert: vi.fn() });

    await expect(handleAdapterSend({
      adapter: "telegram",
      accountId: "bot",
      surface: { kind: "dm", id: "chat-42" },
      text: "large file",
      media: [{
        type: "document",
        mimeType: "application/pdf",
        size: maxBytes,
        body: { offset: 0, length: maxBytes },
      }],
    }, ctx, body)).resolves.toMatchObject({ ok: true, messageId: "outbound-48mib" });
    expect(adapterFrame).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects an attachment larger than the complete media byte budget", async () => {
    const oversizedBytes = 48 * 1024 * 1024 + 1;
    const adapterFrame = successfulAdapterFrame("telegram", "unexpected");
    const cancel = vi.fn(async () => undefined);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const body = {
      length: oversizedBytes,
      stream: {
        locked: false,
        cancel,
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      } as ReadableStream<Uint8Array>,
    };
    const ctx = makeContext({
      CHANNEL_TELEGRAM: { adapterFrame },
    }, { upsert: vi.fn() });

    await expect(handleAdapterSend({
      adapter: "telegram",
      accountId: "bot",
      surface: { kind: "dm", id: "chat-42" },
      text: "oversized file",
      media: [{
        type: "document",
        mimeType: "application/pdf",
        size: oversizedBytes,
        body: { offset: 0, length: oversizedBytes },
      }],
    }, ctx, body)).resolves.toMatchObject({
      ok: false,
      error: `Adapter media body exceeds per-item limit (${oversizedBytes} bytes)`,
      retryable: false,
    });
    expect(adapterFrame).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  it("classifies adapter service RPC throws as retryable transport failures", async () => {
    const adapterFrame = vi.fn(async () => {
      throw new Error("service binding disconnected");
    });
    const ctx = makeContext({
      CHANNEL_TELEGRAM: { adapterFrame },
    }, { upsert: vi.fn() });

    const result = await handleAdapterSend({
      adapter: "telegram",
      accountId: "bot",
      deliveryId: "retryable-delivery-1",
      surface: { kind: "dm", id: "chat-42" },
      text: "retry safely",
    }, ctx);

    expect(adapterFrame).toHaveBeenCalledWith(
      { installationId: TEST_INSTALLATION_ID },
      expect.objectContaining({
        accountId: "bot",
        deliveryId: "retryable-delivery-1",
      }),
      expect.objectContaining({ type: "req", call: "adapter.send" }),
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
    const adapterFrame = successfulAdapterFrame("telegram", "msg-1");
    const cancel = vi.fn(async () => undefined);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const body = {
      length: 0,
      stream: {
        locked: false,
        cancel,
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      } as ReadableStream<Uint8Array>,
    };
    const ctx = makeContext({ CHANNEL_TELEGRAM: { adapterFrame } }, { upsert: vi.fn() });
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const args = {
      adapter: "telegram",
      accountId: "bot",
      surface: { kind: "dm", id: "chat-42" },
      text: "hello",
      ...patch,
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as Parameters<typeof handleAdapterSend>[0];

    await expect(handleAdapterSend(args, ctx, body)).resolves.toEqual({
      ok: false,
      error: expectedError,
      retryable: false,
    });
    expect(adapterFrame).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("denies adapter.send for non-root users without a linked account", async () => {
    const adapterFrame = successfulAdapterFrame("whatsapp", "msg-1");
    const status = {
      upsert: vi.fn(),
      list: vi.fn(() => []),
    };
    const ctx = makeContext({ CHANNEL_WHATSAPP: { adapterFrame } }, status, {
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
    expect(adapterFrame).not.toHaveBeenCalled();
  });

  it("allows adapter.send for non-root users with a linked account", async () => {
    const adapterFrame = successfulAdapterFrame("whatsapp", "msg-1");
    const status = {
      upsert: vi.fn(),
      list: vi.fn(() => []),
    };
    const ctx = makeContext({ CHANNEL_WHATSAPP: { adapterFrame } }, status, {
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
    expect(adapterFrame).toHaveBeenCalledWith(
      { installationId: TEST_INSTALLATION_ID },
      expect.objectContaining({
        accountId: "primary",
        deliveryId: "explicit-linked-1",
        surface: { kind: "dm", id: "wa:+123" },
      }),
      expect.objectContaining({
        type: "req",
        call: "adapter.send",
        args: expect.objectContaining({ text: "hello" }),
      }),
    );
  });

  it("denies adapter.send to an unlinked surface on the same account", async () => {
    const adapterFrame = successfulAdapterFrame("whatsapp", "msg-1");
    const status = {
      upsert: vi.fn(),
      list: vi.fn(() => []),
    };
    const ctx = makeContext({ CHANNEL_WHATSAPP: { adapterFrame } }, status, {
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
    expect(adapterFrame).not.toHaveBeenCalled();
  });

  it("allows adapter.send to the linked challenge surface", async () => {
    const adapterFrame = successfulAdapterFrame("discord", "msg-1");
    const status = {
      upsert: vi.fn(),
      list: vi.fn(() => []),
    };
    const ctx = makeContext({ CHANNEL_DISCORD: { adapterFrame } }, status, {
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
    expect(adapterFrame).toHaveBeenCalled();
  });

  it("allows adapter.send to a routed surface owned by the caller", async () => {
    const adapterFrame = successfulAdapterFrame("discord", "msg-1");
    const status = {
      upsert: vi.fn(),
      list: vi.fn(() => []),
    };
    const ctx = makeContext({ CHANNEL_DISCORD: { adapterFrame } }, status, {
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
    expect(adapterFrame).toHaveBeenCalled();
  });

  it("uses the caller owner uid when adapter.send runs from an agent process", async () => {
    const adapterFrame = successfulAdapterFrame("whatsapp", "msg-1");
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
    const ctx = makeContext({ CHANNEL_WHATSAPP: { adapterFrame } }, status, {
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
    expect(adapterFrame).toHaveBeenCalled();
  });

  it("requires an explicit --also acknowledgement for the active reply destination", async () => {
    const adapterFrame = successfulAdapterFrame("telegram", "msg-2");
    const link = {
      adapter: "telegram",
      accountId: "bot",
      actorId: "user-42",
      uid: 1000,
      linkedByUid: 1000,
      createdAt: 1,
      metadata: { surfaceKind: "dm", surfaceId: "chat-42" },
    };
    const ctx = makeContext({ CHANNEL_TELEGRAM: { adapterFrame } }, {
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
        destination: {
          kind: "adapter",
          adapter: "telegram",
          accountId: "bot",
          actorId: "user-42",
          surface: { kind: "dm", id: "chat-42" },
        },
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
      error: expect.stringContaining("directed endpoint"),
      retryable: false,
    });
    expect(adapterFrame).not.toHaveBeenCalled();

    await expect(handleAdapterSend({
      adapter: "telegram",
      accountId: "bot",
      surface: { kind: "dm", id: "chat-42" },
      text: "intentional extra",
      also: true,
    }, ctx)).resolves.toEqual(expect.objectContaining({ ok: true, messageId: "msg-2" }));
    expect(adapterFrame).toHaveBeenCalledTimes(1);
  });

  it("forwards reply threading and sanitizes directed message delivery failures", async () => {
    const adapterFrame: NonNullable<AdapterService["adapterFrame"]> = vi.fn(async (
      _installation,
      context,
      frame,
    ) => {
      if (frame.type !== "req") throw new Error("Expected a request frame");
      return {
        type: "res",
        id: frame.id,
        ok: true,
        data: {
          ok: false,
          error: "Telegram API 400 chat_id=chat-42: raw provider response",
          deliveryId: context.deliveryId,
          retryable: true,
        },
      };
    });
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
      CHANNEL_TELEGRAM: { adapterFrame },
    }, { upsert: vi.fn() }, {
      identityLinks: { get: vi.fn(() => link) },
    });
    const destination = {
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      kind: "adapter" as const,
      adapter: "telegram",
      accountId: "bot",
      actorId: "user-42",
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      surface: { kind: "dm" as const, id: "chat-42" },
    };

    const result = await deliverAdapterDestination(
      destination,
      1000,
      {
        deliveryId: "run-1:finished",
        text: "automatic reply",
        replyToId: "incoming-7",
      },
      ctx,
    );

    expect(adapterFrame).toHaveBeenCalledWith(
      { installationId: TEST_INSTALLATION_ID },
      expect.objectContaining({
        accountId: "bot",
        actorId: "user-42",
        deliveryId: "run-1:finished",
        surface: { kind: "dm", id: "chat-42" },
      }),
      expect.objectContaining({
        type: "req",
        call: "adapter.send",
        args: expect.objectContaining({
          text: "automatic reply",
          replyToId: "incoming-7",
        }),
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: "Telegram delivery is temporarily unavailable",
      deliveryId: "run-1:finished",
      retryable: true,
    });
  });

  it("rechecks the linked actor before delivering a directed message", async () => {
    const adapterFrame = successfulAdapterFrame("telegram", "msg-3");
    const getLink = vi.fn(() => null);
    const ctx = makeContext({ CHANNEL_TELEGRAM: { adapterFrame } }, {
      upsert: vi.fn(),
      list: vi.fn(() => []),
    }, {
      processId: "pid-1",
      identity: userIdentity(),
      identityLinks: { get: getLink },
    });
    const destination = {
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      kind: "adapter" as const,
      adapter: "telegram",
      accountId: "bot",
      actorId: "user-42",
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      surface: { kind: "dm" as const, id: "chat-42" },
    };

    await expect(deliverAdapterDestination(destination, 1000, { text: "hello" }, ctx)).resolves.toEqual({
      ok: false,
      error: "Adapter destination is not authorized",
    });
    expect(adapterFrame).not.toHaveBeenCalled();
  });
});

describe("managed adapter pairing", () => {
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  const installationId = "installation_test" as KernelContext["installationId"];
  const canonicalOrigin = "https://test.gsv.space";
  const candidate = {
    accountId: "managed",
    actorId: "12345",
    surfaceId: "12345",
    actorName: "Hank",
    actorHandle: "@hank",
    expiresAt: Date.now() + 60_000,
    linked: false,
  };
  const route = {
    installationId,
    localUid: 1000,
    generation: "generation-new",
  };

  function directUserOptions(overrides: MakeContextOptions = {}): MakeContextOptions {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    return {
      installationId,
      installationIdentity: {
        installationId,
        handle: "test",
        canonicalOrigin,
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      } as KernelContext["installationIdentity"],
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      connection: {} as KernelContext["connection"],
      identity: userIdentity(),
      ...overrides,
    };
  }

  function pairingService(
    pairingCandidate = candidate,
    pairingRoute = route,
  ) {
    return {
      adapterPairingInfo: vi.fn(async () => ({
        accountId: "managed",
        configured: true,
        botUsername: "official_gsv_bot",
      })),
      adapterPairingInspect: vi.fn(async () => pairingCandidate),
      adapterPairingPrepare: vi.fn(async () => ({
        candidate: pairingCandidate,
        route: pairingRoute,
      })),
      adapterPairingActivate: vi.fn(async () => ({
        candidate: pairingCandidate,
        route: pairingRoute,
      })),
      adapterPairingFinalize: vi.fn(async () => ({
        candidate: pairingCandidate,
        route: pairingRoute,
      })),
      adapterPairingDisconnect: vi.fn(async () => ({ disconnected: true })),
    };
  }

  it("invokes pairing methods through their RPC receiver", async () => {
    const service = pairingService();
    Object.defineProperty(service.adapterPairingInfo, "bind", {
      get() {
        throw new Error("RPC methods cannot be rebound");
      },
    });
    const ctx = makeContext(
      { CHANNEL_TELEGRAM: service },
      { upsert: vi.fn(), list: vi.fn(() => []) },
      directUserOptions(),
    );

    await expect(handleAdapterPairInfo({ adapter: "telegram" }, ctx)).resolves.toEqual({
      adapter: "telegram",
      accountId: "managed",
      configured: true,
      botUsername: "official_gsv_bot",
    });
  });

  it("discovers the platform bot and confirms the displayed Telegram identity", async () => {
    const service = pairingService();
    let currentLink: IdentityLinkRecord | null = null;
    const link = vi.fn((
      adapter: string,
      accountId: string,
      actorId: string,
      uid: number,
      linkedByUid: number,
      metadata: IdentityLinkRecord["metadata"],
    ) => {
      currentLink = {
        adapter,
        accountId,
        actorId,
        uid,
        linkedByUid,
        metadata,
        createdAt: 1,
      };
      return currentLink;
    });
    const identityLinks = {
      get: vi.fn(() => currentLink),
      link,
      unlink: vi.fn(() => {
        currentLink = null;
        return true;
      }),
      listByAccount: vi.fn(() => currentLink ? [currentLink] : []),
      list: vi.fn(() => currentLink ? [currentLink] : []),
    };
    const status = {
      upsert: vi.fn(),
      setOwner: vi.fn(),
      list: vi.fn(() => []),
      listByOwner: vi.fn(() => []),
    };
    const ctx = makeContext(
      { CHANNEL_TELEGRAM: service },
      status,
      directUserOptions({ identityLinks }),
    );

    await expect(handleAdapterPairInfo({ adapter: "telegram" }, ctx)).resolves.toEqual({
      adapter: "telegram",
      accountId: "managed",
      configured: true,
      botUsername: "official_gsv_bot",
    });
    await expect(handleAdapterPairInspect({
      adapter: "telegram",
      code: "ABCD-EFGH-JKLM",
    }, ctx)).resolves.toEqual({ adapter: "telegram", ...candidate });
    await expect(handleAdapterPairConfirm({
      adapter: "telegram",
      code: "ABCD-EFGH-JKLM",
    }, ctx)).resolves.toEqual({
      paired: true,
      adapter: "telegram",
      accountId: "managed",
      actorId: "12345",
      surfaceId: "12345",
      uid: 1000,
    });

    expect(service.adapterPairingPrepare).toHaveBeenCalledWith(
      { installationId },
      expect.objectContaining({
        code: "ABCDEFGHJKLM",
        installationId,
        localUid: 1000,
        canonicalOrigin,
      }),
    );
    expect(service.adapterPairingActivate).toHaveBeenCalledWith(
      { installationId },
      expect.objectContaining({ route, canonicalOrigin }),
    );
    expect(link).toHaveBeenCalledWith(
      "telegram",
      "managed",
      "12345",
      1000,
      1000,
      expect.objectContaining({
        managed: true,
        surfaceKind: "dm",
        surfaceId: "12345",
        routeScope: "surface",
        routeGeneration: "generation-new",
      }),
    );
    expect(link).toHaveBeenCalledBefore(service.adapterPairingActivate);
    expect(service.adapterPairingFinalize).toHaveBeenCalledAfter(
      service.adapterPairingActivate,
    );
    expect(ctx.broadcastToUserUid).toHaveBeenCalledWith(1000, "adapter.status", {
      adapter: "telegram",
      accountId: "managed",
    });

    await expect(handleAdapterPairDisconnect({
      adapter: "telegram",
      accountId: "managed",
      actorId: "12345",
    }, ctx)).resolves.toMatchObject({ disconnected: true });
    expect(service.adapterPairingDisconnect).toHaveBeenCalledWith(
      { installationId },
      expect.objectContaining({
        installationId,
        accountId: "managed",
        actorId: "12345",
        surfaceId: "12345",
        localUid: 1000,
        generation: "generation-new",
      }),
    );
    expect(identityLinks.unlink).toHaveBeenCalledWith("telegram", "managed", "12345");
  });

  it("cancels authentication recovery when the last managed link disconnects", async () => {
    const service = pairingService();
    const link: IdentityLinkRecord = {
      adapter: "telegram",
      accountId: "managed",
      actorId: "12345",
      uid: 1000,
      linkedByUid: 1000,
      metadata: {
        managed: true,
        surfaceKind: "dm",
        surfaceId: "12345",
        routeGeneration: "generation-new",
      },
      createdAt: 1,
    };
    let currentLink: IdentityLinkRecord | null = link;
    const identityLinks = {
      get: vi.fn(() => currentLink),
      unlink: vi.fn(() => {
        currentLink = null;
        return true;
      }),
      listByAccount: vi.fn(() => currentLink ? [currentLink] : []),
    };
    let stored: AdapterStatusRecord = {
      adapter: "telegram",
      accountId: "managed",
      connected: false,
      authenticated: false,
      lifecycleId: "adapter-account:managed-disconnect",
      readyOwnerUid: 1000,
      ownerUid: 1000,
      updatedAt: 1,
    };
    const status = {
      get: vi.fn(() => stored),
      upsert: vi.fn((adapter: string, accountId: string, next) => {
        stored = {
          ...stored,
          ...next,
          adapter,
          accountId,
          updatedAt: stored.updatedAt + 1,
        };
        return stored;
      }),
      beginLifecycle: vi.fn(),
      endLifecycle: vi.fn(),
    };
    const ctx = makeContext(
      { CHANNEL_TELEGRAM: service },
      status,
      directUserOptions({ identityLinks }),
    );
    vi.mocked(ctx.responsibilities.listActiveByDedupeKeyPrefix).mockReturnValue([
      // SAFETY: the lifecycle helper reads only the responsibility identity from this fixture.
      { id: "r12y:managed-authentication" } as ReturnType<
        KernelContext["responsibilities"]["listActiveByDedupeKeyPrefix"]
      >[number],
    ]);
    // SAFETY: the lifecycle helper reads only the changed flag from this update result.
    vi.mocked(ctx.responsibilities.update).mockReturnValue({
      changed: true,
    } as ReturnType<KernelContext["responsibilities"]["update"]>);

    await expect(handleAdapterPairDisconnect({
      adapter: "telegram",
      accountId: "managed",
      actorId: "12345",
    }, ctx)).resolves.toMatchObject({ disconnected: true });

    expect(ctx.responsibilities.update).toHaveBeenCalledWith(expect.objectContaining({
      ownerUid: 1000,
      id: "r12y:managed-authentication",
      patch: expect.objectContaining({
        state: "cancelled",
        resolution: expect.objectContaining({ eventType: "adapter.disconnected" }),
      }),
    }));
  });

  it("confirms an actor-scoped identity whose DM and actor IDs differ", async () => {
    const slackCandidate = {
      accountId: "workspace-1",
      actorId: "U12345",
      surfaceId: "D67890",
      routeScope: "actor" as const,
      actorName: "Alice",
      expiresAt: Date.now() + 60_000,
      linked: false,
    };
    const service = pairingService(slackCandidate);
    const link = vi.fn();
    const ctx = makeContext(
      { CHANNEL_SLACK: service },
      {
        upsert: vi.fn(),
        setOwner: vi.fn(),
        list: vi.fn(() => []),
        listByOwner: vi.fn(() => []),
      },
      directUserOptions({
        identityLinks: {
          get: vi.fn(() => null),
          link,
          list: vi.fn(() => []),
          listByAccount: vi.fn(() => []),
        },
      }),
    );

    await expect(handleAdapterPairConfirm({
      adapter: "slack",
      code: "ABCD-EFGH-JKLM",
    }, ctx)).resolves.toMatchObject({
      adapter: "slack",
      accountId: "workspace-1",
      actorId: "U12345",
      surfaceId: "D67890",
    });
    expect(link).toHaveBeenCalledWith(
      "slack",
      "workspace-1",
      "U12345",
      1000,
      1000,
      expect.objectContaining({
        surfaceKind: "dm",
        surfaceId: "D67890",
        routeScope: "actor",
      }),
    );
  });

  it("never exposes pairing to agents, background processes, root, or standalone", async () => {
    const service = pairingService();
    const status = { upsert: vi.fn(), list: vi.fn(() => []) };
    const direct = makeContext(
      { CHANNEL_TELEGRAM: service },
      status,
      directUserOptions(),
    );
    const process = makeContext(
      { CHANNEL_TELEGRAM: service },
      status,
      directUserOptions({ processId: "pid-1" }),
    );
    const root = makeContext(
      { CHANNEL_TELEGRAM: service },
      status,
      directUserOptions({ identity: userIdentity(0) }),
    );
    const standalone = makeContext(
      { CHANNEL_TELEGRAM: service },
      status,
      {
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        connection: {} as KernelContext["connection"],
        identity: userIdentity(),
      },
    );

    await expect(handleAdapterPairInfo({ adapter: "telegram" }, direct)).resolves.toMatchObject({
      configured: true,
    });
    await expect(handleAdapterPairInfo({ adapter: "telegram" }, process)).rejects.toThrow(
      "direct signed-in user",
    );
    await expect(handleAdapterPairInfo({ adapter: "telegram" }, root)).rejects.toThrow(
      "active human account",
    );
    await expect(handleAdapterPairInfo({ adapter: "telegram" }, standalone)).rejects.toThrow(
      "not available in standalone",
    );
  });

  it("advertises pairing from the adapter descriptor", async () => {
    const describedService = (id: string, pairing: boolean) => ({
      adapterDescribe: vi.fn(async (): Promise<AdapterServiceDescriptor> => ({
        version: 1,
        id,
        displayName: id,
        capabilities: {
          connect: false,
          disconnect: false,
          send: true,
          status: false,
          activity: false,
          pairing,
          surfaces: ["dm"],
          media: { inbound: [], outbound: [] },
        },
      })),
    });
    const ctx = makeContext({
      CHANNEL_TELEGRAM: describedService("telegram", true),
      CHANNEL_DISCORD: describedService("discord", false),
    }, {
      upsert: vi.fn(),
      listAll: vi.fn(() => []),
    });

    expect((await handleAdapterList({}, ctx)).adapters).toEqual([
      expect.objectContaining({ adapter: "discord", supportsPairing: false }),
      expect.objectContaining({ adapter: "telegram", supportsPairing: true }),
    ]);
  });

  it("keeps local managed authentication true when live platform status refreshes", async () => {
    const adapterStatus = vi.fn(async () => [{
      accountId: "managed",
      connected: true,
      authenticated: false,
      mode: "managed-shared",
    }]);
    const upsert = vi.fn();
    const linkRecord = {
      adapter: "telegram",
      accountId: "managed",
      actorId: "12345",
      uid: 1000,
      linkedByUid: 1000,
      createdAt: 1,
      metadata: { managed: true },
    };
    const ctx = makeContext(
      { CHANNEL_TELEGRAM: { adapterStatus } },
      {
        upsert,
        list: vi.fn(() => []),
        listByOwner: vi.fn(() => []),
      },
      directUserOptions({
        identityLinks: {
          list: vi.fn(() => [linkRecord]),
          listByAccount: vi.fn(() => [linkRecord]),
        },
      }),
    );

    await handleAdapterStatus({ adapter: "telegram", accountId: "managed" }, ctx);
    expect(upsert).toHaveBeenCalledWith("telegram", "managed", expect.objectContaining({
      authenticated: true,
      mode: "managed-shared",
    }));
  });
});
