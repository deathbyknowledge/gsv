import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { Bash } from "just-bash";
import {
  DEFAULT_NATIVE_SHELL_TIMEOUT_MS,
  handleShellExec,
  NATIVE_SHELL_NETWORK_CONFIG,
} from "./shell";
import {
  handleFsCopy,
  handleFsRead,
  handleFsTransferReceive,
  handleFsTransferSend,
  handleFsTransferStat,
  handleFsWrite,
} from "./fs";
import * as inferenceService from "../../inference/service";
import * as sharedUtils from "../../shared/utils";
import type { KernelContext } from "../../kernel/context";
import type { DeviceRecord } from "../../kernel/devices";
import type { ProcessRecord } from "../../kernel/processes";
import type { FederationContactRecord } from "../../kernel/federation-store";
import type { SurfaceRouteRecord } from "../../kernel/surface-routes";
import type { AdapterService } from "../../adapter-interface";
import {
  bodyFromText,
  bodyToBytes,
  bodyToText,
  jsonObjectSchema,
  type JsonObject,
  type ProcessIdentity,
  type ResponsibilityRecord,
} from "@humansandmachines/gsv/protocol";
import type { ResponsibilityUpdateInput } from "../../kernel/responsibility-store";
import type { RequestFrame, ResponseFrame } from "../../protocol/frames";
import type { InstallationIdentity } from "../../installation/identity";
import { stableOpaqueId } from "../../shared/stable-id";
import * as z from "zod/mini";

const generateMock = vi.fn();
const createGenerationServiceMock = vi.spyOn(inferenceService, "createGenerationService");
const sendFrameToProcessMock = vi.spyOn(sharedUtils, "sendFrameToProcess");
const getConversationByIdMock = vi.spyOn(sharedUtils, "getConversationById");
const TEST_INSTALLATION_ID: KernelContext["installationId"] = "inst_shell_test";
const TEST_INSTALLATION_CONTEXT = { installationId: TEST_INSTALLATION_ID };

beforeEach(() => {
  createGenerationServiceMock.mockReturnValue({
    generate: generateMock,
    stream: vi.fn(),
    generateText: vi.fn(),
  });
  sendFrameToProcessMock.mockReset();
  getConversationByIdMock.mockReset();
  sendFrameToProcessMock.mockImplementation(async (_installationId, _pid, frame) => (
    frame.type === "req" && frame.call === "proc.setidentity"
      ? { type: "res", id: frame.id, ok: true, data: { ok: true } }
      : null
  ));
  generateMock.mockReset();
});

const IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000, 100],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
};

type ShellAiInput = {
  task?: string;
  audio?: string;
  text?: string;
  prompt?: string;
};
type ShellAiResult =
  | { caption: string }
  | { text: string }
  | { image: string }
  | ReadableStream<Uint8Array>
  | null;

function focusedFixture<T extends object>(value: Partial<T>): T {
  // SAFETY: Shell tests use focused doubles whose supplied members are checked
  // against the owning interface; unimplemented members are never exercised.
  return value as T;
}

function responseFixture(frame: ResponseFrame): ResponseFrame {
  return frame;
}

const currentDestinationOutputSchema = z.object({
  destinationId: z.string(),
});
const destinationListOutputSchema = z.object({
  destinations: z.array(z.object({ id: z.string() })),
});
const wikiApplyBodySchema = z.object({
  message: z.optional(z.string()),
  ops: z.optional(z.array(z.object({
    type: z.optional(z.string()),
    path: z.optional(z.string()),
    contentBytes: z.optional(z.array(z.number())),
  }))),
});

function makeDevice(partial: Partial<DeviceRecord> & { device_id: string }): DeviceRecord {
  const now = 1_800_000_000_000;
  return {
    device_id: partial.device_id,
    owner_uid: partial.owner_uid ?? IDENTITY.uid,
    label: partial.label ?? partial.device_id,
    description: partial.description ?? "",
    implements: partial.implements ?? ["shell.exec"],
    platform: partial.platform ?? "linux",
    version: partial.version ?? "1.0.0",
    online: partial.online ?? true,
    first_seen_at: partial.first_seen_at ?? now,
    last_seen_at: partial.last_seen_at ?? now,
    connected_at: partial.connected_at ?? now,
    disconnected_at: partial.disconnected_at ?? null,
  };
}

function makeProcess(
  partial: Partial<ProcessRecord> & { processId: string },
): ProcessRecord {
  return {
    processId: partial.processId,
    parentPid: partial.parentPid ?? null,
    uid: partial.uid ?? IDENTITY.uid,
    ownerUid: partial.ownerUid ?? IDENTITY.uid,
    interactive: partial.interactive ?? true,
    isPersonalController: partial.isPersonalController ?? false,
    gid: partial.gid ?? IDENTITY.gid,
    gids: partial.gids ?? [...IDENTITY.gids],
    username: partial.username ?? IDENTITY.username,
    home: partial.home ?? IDENTITY.home,
    cwd: partial.cwd ?? IDENTITY.cwd,
    state: partial.state ?? "idle",
    activeRunId: partial.activeRunId ?? null,
    queuedCount: partial.queuedCount ?? 0,
    lastActiveAt: partial.lastActiveAt ?? null,
    label: partial.label ?? null,
    createdAt: partial.createdAt ?? 1,
  };
}

function makeContact(): FederationContactRecord {
  return {
    id: "contact:friend",
    ownerUid: IDENTITY.uid,
    state: "active",
    generation: "generation:friend",
    remoteShipId: "ship:friend",
    remoteSubject: { id: "subject:friend", displayName: "Flynn" },
    remoteOrigin: "https://flynn.example",
    remotePublicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    sharedSecret: "secret",
    conversationId: "conversation:friend",
    threadId: "thread:friend",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function applyResponsibilityTestUpdate(
  current: ResponsibilityRecord,
  input: ResponsibilityUpdateInput,
): ResponsibilityRecord {
  const next: ResponsibilityRecord = {
    ...current,
    revision: current.revision + 1,
    updatedAtMs: input.now,
  };
  if (input.patch.assignee) next.assignee = input.patch.assignee;
  if (input.patch.state) next.state = input.patch.state;
  for (const field of ["blocker", "nextCheckAtMs", "leaseExpiresAtMs"] as const) {
    const value = input.patch[field];
    if (value === null) {
      delete next[field];
    } else if (value !== undefined) {
      next[field] = value;
    }
  }
  return next;
}

function makeContext(options?: {
  capabilities?: string[];
  config?: Record<string, string>;
  procs?: Partial<KernelContext["procs"]>;
  devices?: Partial<KernelContext["devices"]>;
  auth?: Partial<KernelContext["auth"]>;
  caps?: Partial<KernelContext["caps"]>;
  schedules?: Partial<KernelContext["schedules"]>;
  ipcCalls?: Partial<KernelContext["ipcCalls"]>;
  responsibilities?: Partial<KernelContext["responsibilities"]>;
  responsibilitySources?: Partial<KernelContext["responsibilitySources"]>;
  federation?: Partial<KernelContext["federation"]>;
  conversations?: Partial<KernelContext["conversations"]>;
  oauth?: Partial<KernelContext["oauth"]>;
  scheduleIpcCallTimeout?: KernelContext["scheduleIpcCallTimeout"];
  scheduleScheduleWake?: KernelContext["scheduleScheduleWake"];
  reconcileResponsibilityWake?: KernelContext["reconcileResponsibilityWake"];
  processRunId?: string;
  processId?: string | null;
  identity?: ProcessIdentity;
  aiRun?: (model: string, input: ShellAiInput) => Promise<ShellAiResult>;
  ripgit?: Fetcher;
  requestSignal?: AbortSignal;
}): KernelContext {
  const identity = options?.identity ?? IDENTITY;
  const installationIdentity: InstallationIdentity = {
    installationId: "inst_shell_test",
    handle: "shell-test",
    canonicalOrigin: "https://shell-test.gsv.space",
  };
  const configValues = new Map<string, string>(Object.entries(options?.config ?? {}));
  const defaultAuth = {
    getPasswdByUid: vi.fn((uid: number) => uid === identity.uid
      ? {
        username: identity.username,
        uid: identity.uid,
        gid: identity.gid,
        gecos: identity.username,
        home: identity.home,
        shell: "/bin/init",
      }
      : null),
    getPasswdByUsername: vi.fn((username: string) => username === identity.username
      ? {
        username: identity.username,
        uid: identity.uid,
        gid: identity.gid,
        gecos: identity.username,
        home: identity.home,
        shell: "/bin/init",
      }
      : null),
    getPersonalAgentUid: vi.fn(() => null),
    resolveGids: vi.fn(() => [...identity.gids]),
  };
  const testEnv = focusedFixture<Env>({
    STORAGE: env.STORAGE,
    RIPGIT: options?.ripgit ?? focusedFixture<Fetcher>({}),
    LOADER: { get() { throw new Error("LOADER should not be used in shell tests"); } },
  });
  if (options?.aiRun) {
    testEnv.AI = { run: vi.fn(options.aiRun) };
  }
  return focusedFixture<KernelContext>({
    env: testEnv,
    installationId: installationIdentity.installationId,
    installationIdentity,
    auth: focusedFixture<KernelContext["auth"]>({
      ...defaultAuth,
      ...options?.auth,
    }),
    caps: focusedFixture<KernelContext["caps"]>({
      resolve: vi.fn(() => []),
      ...options?.caps,
    }),
    config: focusedFixture<KernelContext["config"]>({
      get(key: string) {
        if (key === "config/server/name") return "gsv";
        if (key === "config/server/version") return "0.4.1";
        return configValues.get(key) ?? null;
      },
      getExplicit(key: string) {
        return configValues.get(key) ?? null;
      },
      set(key: string, value: string) {
        configValues.set(key, value);
      },
      delete(key: string) {
        return configValues.delete(key);
      },
      list(prefix: string) {
        const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
        return [...configValues.entries()]
          .filter(([key]) => key.startsWith(normalized))
          .map(([key, value]) => ({ key, value }))
          .sort((left, right) => left.key.localeCompare(right.key));
      },
    }),
    devices: focusedFixture<KernelContext["devices"]>(options?.devices ?? {}),
    procs: focusedFixture<KernelContext["procs"]>({
      get() {
        return {
          profile: "task",
          uid: identity.uid,
        };
      },
      getOwnerUid() {
        return identity.uid;
      },
      ...options?.procs,
    }),
    oauth: focusedFixture<KernelContext["oauth"]>({
      listAccounts: vi.fn(() => []),
      listFlows: vi.fn(() => []),
      deleteAccount: vi.fn(() => false),
      ...options?.oauth,
    }),
    adapters: focusedFixture<KernelContext["adapters"]>({
      identityLinks: { list: vi.fn(() => []) },
      status: {
        list: vi.fn(() => []),
        listAll: vi.fn(() => []),
        listByOwner: vi.fn(() => []),
      },
    }),
    runRoutes: focusedFixture<KernelContext["runRoutes"]>({
      inheritProcessApprovalRoute: vi.fn(),
    }),
    schedules: options?.schedules
      ? focusedFixture<KernelContext["schedules"]>(options.schedules)
      : undefined,
    ipcCalls: focusedFixture<KernelContext["ipcCalls"]>({
      findPendingByTargetRun: vi.fn(() => null),
      ...options?.ipcCalls,
    }),
    responsibilities: focusedFixture<KernelContext["responsibilities"]>(
      options?.responsibilities ?? {},
    ),
    responsibilitySources: focusedFixture<KernelContext["responsibilitySources"]>(
      options?.responsibilitySources ?? {},
    ),
    federation: focusedFixture<KernelContext["federation"]>({
      list: vi.fn(() => []),
      ...options?.federation,
    }),
    conversations: focusedFixture<KernelContext["conversations"]>(
      options?.conversations ?? {},
    ),
    connection: null,
    identity: {
      role: "user",
      process: identity,
      capabilities: options?.capabilities ?? ["repo.refs", "repo.log"],
    },
    processId: options?.processId === null ? undefined : options?.processId ?? "task:shell",
    processRunId: options?.processRunId,
    requestSignal: options?.requestSignal,
    serverVersion: "0.4.1",
    scheduleIpcCallTimeout: options?.scheduleIpcCallTimeout,
    scheduleScheduleWake: options?.scheduleScheduleWake,
    reconcileResponsibilityWake: options?.reconcileResponsibilityWake,
  });
}

function makeSkillFetcher(
  files: Record<string, string>,
  readPaths: string[] = [],
): Fetcher {
  const encoder = new TextEncoder();
  const names = Object.keys(files).sort();
  return focusedFixture<Fetcher>({
    async fetch(input: RequestInfo | URL) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname !== "/hyperspace/repos/sam/home/read") {
        return new Response("missing", { status: 404 });
      }
      const path = url.searchParams.get("path") ?? "";
      readPaths.push(path);
      if (path === "skills.d") {
        return Response.json(names.map((name) => ({
          name,
          mode: "100644",
          hash: `hash-${name}`,
          type: "blob",
        })));
      }
      const content = files[path.replace(/^skills\.d\//, "")];
      if (content === undefined) {
        return new Response("missing", { status: 404 });
      }
      return new Response(content, {
        headers: { "X-Blob-Size": String(encoder.encode(content).byteLength) },
      });
    },
  });
}

function enableTelegramMessaging(ctx: KernelContext) {
  const link = {
    adapter: "telegram",
    accountId: "bot",
    actorId: "chat-42",
    uid: IDENTITY.uid,
    createdAt: 1,
    linkedByUid: IDENTITY.uid,
    metadata: { surfaceKind: "dm", surfaceId: "chat-42" },
  };
  const status = {
    adapter: "telegram",
    accountId: "bot",
    ownerUid: IDENTITY.uid,
    connected: true,
    authenticated: true,
    mode: "webhook",
    lastActivity: 2,
    error: null,
    extra: null,
    updatedAt: 3,
  };
  const adapterFrame: NonNullable<AdapterService["adapterFrame"]> = vi.fn(async (
    _installation,
    context,
    frame,
  ) => {
    if (frame.type !== "req" || frame.call !== "adapter.send") {
      throw new Error("Expected an adapter.send request frame");
    }
    const bytes = frame.body ? await bodyToBytes(frame.body) : undefined;
    return {
      type: "res",
      id: frame.id,
      ok: true,
      data: {
        ok: true,
        adapter: "telegram",
        accountId: context.accountId,
        surfaceId: context.surface.id,
        deliveryId: context.deliveryId,
        messageId: bytes ? `bytes-${bytes.byteLength}` : "msg-1",
        deliveryState: "sent",
      },
    };
  });
  Object.assign(ctx.env, {
    CHANNEL_TELEGRAM: { adapterFrame },
  });
  ctx.adapters = focusedFixture<KernelContext["adapters"]>({
    identityLinks: {
      list: vi.fn(() => [link]),
      get: vi.fn((adapter: string, accountId: string, actorId: string) =>
        adapter === link.adapter && accountId === link.accountId && actorId === link.actorId
          ? link
          : null),
    },
    surfaceRoutes: {
      get: vi.fn(() => null),
      list: vi.fn(() => []),
    },
    privateDestinations: {
      get: vi.fn(() => null),
    },
    ingressReceipts: {
      isLatestPrivateMessage: vi.fn(() => true),
    },
    status: {
      get: vi.fn((adapter: string, accountId: string) =>
        adapter === status.adapter && accountId === status.accountId ? status : null),
      list: vi.fn(() => [status]),
      listAll: vi.fn(() => [status]),
      listByOwner: vi.fn(() => [status]),
    },
  });
  ctx.runRoutes = focusedFixture<KernelContext["runRoutes"]>({
    get: vi.fn((runId: string) => runId === ctx.processRunId
      ? {
          kind: "adapter",
          runId,
          processId: ctx.processId!,
          uid: IDENTITY.uid,
          destination: {
            kind: "adapter",
            adapter: "telegram",
            accountId: "bot",
            actorId: "chat-42",
            surface: { kind: "dm", id: "chat-42" },
          },
          replyToId: "msg-1",
          createdAt: 1,
          expiresAt: Date.now() + 60_000,
        }
      : null),
  });
  return { adapterFrame, link, status };
}

function enableMessageRouteStore(
  ctx: KernelContext,
  processes: ProcessRecord[],
) {
  let route: SurfaceRouteRecord | null = null;
  const setRoute = vi.fn((input: Parameters<KernelContext["adapters"]["surfaceRoutes"]["setRoute"]>[0]) => {
    route = { ...input, updatedAt: 1_800_000_000_000 };
    return route;
  });
  const clearRoute = vi.fn(() => {
    const cleared = route !== null;
    route = null;
    return cleared;
  });
  Object.assign(ctx.adapters.surfaceRoutes, {
    get: vi.fn(() => route),
    list: vi.fn(() => route ? [route] : []),
    setRoute,
    clearRoute,
  });
  ctx.procs = focusedFixture<KernelContext["procs"]>({
    getOwnerUid: vi.fn(() => IDENTITY.uid),
    getPersonalController: vi.fn((ownerUid: number) => (
      ownerUid === IDENTITY.uid
        ? processes.find((process) => process.isPersonalController) ?? null
        : null
    )),
    list: vi.fn(() => processes),
    get: vi.fn((pid: string) => processes.find((process) => process.processId === pid) ?? null),
  });
  return { setRoute, clearRoute };
}

function enablePrivateDmHandoff(
  ctx: KernelContext,
  latestMessageId = "msg-1",
) {
  const controller = makeProcess({
    processId: ctx.processId!,
    isPersonalController: true,
    activeRunId: ctx.processRunId ?? null,
    label: "personal",
  });
  const target = makeProcess({
    processId: "proc:groceries",
    label: "groceries",
    username: "helper",
    uid: 1001,
  });
  const destination = {
    kind: "adapter",
    adapter: "telegram",
    accountId: "bot",
    actorId: "chat-42",
    surface: { kind: "dm", id: "chat-42" },
  };
  ctx.adapters.privateDestinations = focusedFixture<
    KernelContext["adapters"]["privateDestinations"]
  >({
    get: vi.fn(() => ({
      uid: IDENTITY.uid,
      destination,
      messageId: latestMessageId,
      updatedAt: 1,
    })),
  });
  const routeStore = enableMessageRouteStore(ctx, [controller, target]);
  return { controller, target, destination, ...routeStore };
}

describe("native shell execution", () => {
  it("uses a two-minute default runtime", () => {
    expect(DEFAULT_NATIVE_SHELL_TIMEOUT_MS).toBe(120_000);
  });

  it("reports the configured command timeout under just-bash cancellation", async () => {
    const result = await handleShellExec(
      { input: "sleep 1", timeout: 10 },
      makeContext(),
    );

    expect(result).toMatchObject({
      status: "failed",
      error: "Command timed out after 10ms",
    });
  });

  it("preserves the request cancellation reason under just-bash cancellation", async () => {
    const controller = new AbortController();
    const resultPromise = handleShellExec(
      { input: "sleep 1" },
      makeContext({ requestSignal: controller.signal }),
    );
    controller.abort(new Error("User interrupted"));

    await expect(resultPromise).resolves.toMatchObject({
      status: "failed",
      error: "User interrupted",
    });
  });

  it("fences native custom command completion after timeout", async () => {
    let generationSignal: AbortSignal | undefined;
    let finishGeneration: () => void = () => {};
    generateMock.mockImplementationOnce(async (request: { signal?: AbortSignal }) => await new Promise((resolve) => {
      generationSignal = request.signal;
      finishGeneration = () => resolve({
        role: "assistant",
        content: [{ type: "text", text: "late response" }],
        api: "test",
        provider: "workers-ai",
        model: "@cf/test/model",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      });
    }));

    const resultPromise = handleShellExec(
      { input: "llm wait", timeout: 10 },
      makeContext({ capabilities: ["ai.text.generate"] }),
    );
    await vi.waitFor(() => expect(generateMock).toHaveBeenCalledOnce());

    const earlyOutcome = await Promise.race([
      resultPromise.then(() => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 150)),
    ]);
    expect(earlyOutcome).toBe("pending");
    expect(generationSignal?.aborted).toBe(true);

    finishGeneration();
    await expect(resultPromise).resolves.toMatchObject({
      status: "failed",
      error: "Command timed out after 10ms",
    });
  });

  it("supports process substitution through the native filesystem", async () => {
    const result = await handleShellExec(
      { input: "cat <(printf 'substitution works')" },
      makeContext(),
    );

    expect(result).toMatchObject({
      status: "completed",
      stdout: "substitution works",
    });
  });

  it("keeps command stderr visible on non-zero exits", async () => {
    const result = await handleShellExec(
      { input: "printf 'real failure\\n' >&2; exit 7" },
      makeContext(),
    );

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("real failure");
    expect(result.error).toContain("real failure");
  });

  it("shares files with fs syscalls and reports UTF-8 byte sizes", async () => {
    const ctx = makeContext();
    const path = "/tmp/fs-cross-surface.txt";
    await env.STORAGE.delete("tmp/fs-cross-surface.txt");

    await expect(handleFsWrite({ path, content: "é" }, ctx)).resolves.toMatchObject({
      ok: true,
      size: 2,
    });
    await expect(handleShellExec({ input: `cat ${path}` }, ctx)).resolves.toMatchObject({
      status: "completed",
      stdout: "é",
    });

    await handleShellExec({ input: `printf 'from shell' > ${path}` }, ctx);
    const read = await handleFsRead({ path }, ctx);
    expect(read.data).toMatchObject({ ok: true, kind: "text" });
    expect(read.body && await bodyToText(read.body)).toContain("from shell");
  });

  it("preserves filesystem errors from fs.read", async () => {
    const result = await handleFsRead({ path: "/tmp/does-not-exist" }, makeContext());

    expect(result.data).toMatchObject({ ok: false, error: expect.stringContaining("ENOENT") });
  });

  it("returns exact text ranges in frame bodies", async () => {
    const ctx = makeContext();
    const path = "/tmp/fs-read-range.txt";
    await handleFsWrite({ path, content: "zero\né\nlast\n" }, ctx);

    const read = await handleFsRead({ path, offset: 1, limit: 3 }, ctx);

    expect(read.data).toMatchObject({
      ok: true,
      kind: "text",
      contentType: "text/plain",
      lines: 3,
      size: 13,
    });
    expect(read.body && await bodyToText(read.body)).toBe("é\nlast\n");
  });

  it("bounds text reads by UTF-8 bytes and reports a continuation offset", async () => {
    const ctx = makeContext();
    const path = "/tmp/fs-read-bounded.txt";
    await handleFsWrite({ path, content: "zero\néé\nthird\nfourth" }, ctx);

    const read = await handleFsRead({ path, limit: 3, maxBytes: 9 }, ctx);

    expect(read.data).toMatchObject({
      ok: true,
      kind: "text",
      lines: 2,
      truncated: true,
      nextOffset: 2,
    });
    expect(read.body && await bodyToText(read.body)).toBe("zero\néé");
  });

  it("returns a safe prefix when one line exceeds the text byte limit", async () => {
    const ctx = makeContext();
    const path = "/tmp/fs-read-long-line.txt";
    await handleFsWrite({ path, content: "ééé" }, ctx);

    const read = await handleFsRead({ path, maxBytes: 3 }, ctx);

    expect(read.data).toMatchObject({
      ok: true,
      kind: "text",
      lines: 1,
      truncated: true,
    });
    expect(read.data).not.toHaveProperty("nextOffset");
    expect(read.body && await bodyToText(read.body)).toBe("é");
  });

  it("uses stored MIME types for reads and transfer metadata", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await env.STORAGE.put("tmp/fs-read-image", bytes, {
      httpMetadata: { contentType: "image/png" },
    });

    const ctx = makeContext();
    const read = await handleFsRead({ path: "/tmp/fs-read-image" }, ctx);
    const referenced = await handleFsRead({
      path: "/tmp/fs-read-image",
      representation: "resource",
    }, ctx);
    const stat = await handleFsTransferStat({ path: "/tmp/fs-read-image" }, ctx);

    expect(read.data).toMatchObject({
      ok: true,
      kind: "image",
      contentType: "image/png",
      size: bytes.byteLength,
    });
    expect(read.body && await bodyToBytes(read.body)).toEqual(bytes);
    expect(referenced.body).toBeUndefined();
    expect(referenced.data).toMatchObject({
      ok: true,
      kind: "image",
      resource: {
        type: "file",
        target: "gsv",
        path: "/tmp/fs-read-image",
        contentType: "image/png",
        size: bytes.byteLength,
        revision: expect.any(String),
      },
    });
    expect(stat).toMatchObject({
      ok: true,
      contentType: "image/png",
      size: bytes.byteLength,
      revision: expect.any(String),
    });
  });

  it("refuses to transfer a different file revision", async () => {
    const path = "/tmp/fs-transfer-revision.png";
    await env.STORAGE.put(path.slice(1), new Uint8Array([1]), {
      httpMetadata: { contentType: "image/png" },
    });
    const ctx = makeContext();
    const stat = await handleFsTransferStat({ path }, ctx);
    expect(stat).toMatchObject({ ok: true, revision: expect.any(String) });
    if (!stat.ok || !stat.revision) throw new Error("fixture did not produce a revision");
    await env.STORAGE.put(path.slice(1), new Uint8Array([2, 3]), {
      httpMetadata: { contentType: "image/png" },
    });

    const response = await handleFsTransferSend({ path, revision: stat.revision }, ctx, "send-1");

    expect(response.data).toEqual({
      ok: false,
      error: `Source revision is no longer available: ${path}`,
    });
    expect(response.body).toBeUndefined();
  });

  it("reads SVG images as text", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>';
    await env.STORAGE.put("tmp/fs-read-vector", svg, {
      httpMetadata: { contentType: "image/svg+xml" },
    });

    const read = await handleFsRead({ path: "/tmp/fs-read-vector" }, makeContext());

    expect(read.data).toMatchObject({
      ok: true,
      kind: "text",
      contentType: "image/svg+xml",
    });
    expect(read.body && await bodyToText(read.body)).toBe(svg);
  });

  it("rejects invalid UTF-8 in text-classified files", async () => {
    await env.STORAGE.put("tmp/fs-read-invalid", new Uint8Array([0xff]));

    const read = await handleFsRead({ path: "/tmp/fs-read-invalid" }, makeContext());

    expect(read.data).toMatchObject({ ok: false, error: expect.stringContaining("Binary file") });
    expect(read.body).toBeUndefined();
  });

  it("writes network output files as raw bytes", async () => {
    const bytes = new Uint8Array([0, 0xff, 1]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes)));
    const ctx = makeContext();
    try {
      const result = await handleShellExec({
        input: "gsv-fetch -o /tmp/fetched.bin https://example.test/file",
      }, ctx);
      const stored = await handleFsTransferSend({ path: "/tmp/fetched.bin" }, ctx);

      expect(result).toMatchObject({ status: "completed", exitCode: 0 });
      expect(stored.body && await bodyToBytes(stored.body)).toEqual(bytes);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("routes curl through Worker fetch without the unsupported DNS guard", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("worker network ok"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await handleShellExec({
        input: "curl -s https://example.test/data",
      }, makeContext());

      expect(NATIVE_SHELL_NETWORK_CONFIG.denyPrivateRanges).toBe(false);
      expect(result).toMatchObject({
        status: "completed",
        exitCode: 0,
        stdout: "worker network ok",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://example.test/data");
    } finally {
      vi.unstubAllGlobals();
    }
  });

});

describe("native shell capability discovery", () => {
  it("renders the registered command descriptors as the top-level manual", async () => {
    const result = await handleShellExec(
      { input: "man" },
      makeContext({ capabilities: ["shell.exec"] }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("GSV live capability manual");
    expect(result.stdout).toContain("contact      Manage trusted contacts with other GSV Ships");
    expect(result.stdout).toContain("message      Send messages, attach files, and route conversations");
    expect(result.stdout).toContain("yield        Finish the active agent run");
    expect(result.stdout).toContain("skills       Inspect and maintain reusable agent workflows");
    expect(result.stdout).not.toContain("GSV manual pages");
  });

  it.each([
    ["put the image from this chat on my connected machine", "cp"],
    ["create a picture from words", "txt2img"],
    ["describe this screenshot", "img2txt"],
    ["listen to this voice note", "stt"],
    ["make spoken audio from text", "tts"],
    ["run this every weekday morning", "crontab"],
    ["save this workflow for next time", "skills"],
    ["send this file to the chat", "message"],
    ["send an email to this person", "mail"],
    ["start a new chat in this conversation", "message"],
  ])("maps a plain-language task '%s' to %s", async (query, expectedCommand) => {
    const result = await handleShellExec(
      { input: `man --search -- '${query}'` },
      makeContext({ capabilities: ["shell.exec"] }),
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.split("\n")[2]).toContain(`command\t${expectedCommand}\t`);
    expect(result.stdout).toContain(`command\t${expectedCommand}\t`);
    expect(result.stdout).toContain(`man '${expectedCommand}'`);
  });

  it("supports the standard man -k search alias", async () => {
    const result = await handleShellExec(
      { input: "man -k 'generate an image'" },
      makeContext({ capabilities: ["shell.exec"] }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("command\ttxt2img\t");
  });

  it("renders the managed mail manual", async () => {
    const result = await handleShellExec(
      { input: "man mail" },
      makeContext({ capabilities: ["shell.exec", "mail.send", "mail.status"] }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("MAIL(1)");
    expect(result.stdout).toContain("mail send --to ADDRESS");
    expect(result.stdout).toContain("mail reply MESSAGE_ID");
    expect(result.stdout).toContain("mail status DELIVERY_ID");
    expect(result.stdout).toContain("queued");
  });

  it("reports the caller's current media capability availability", async () => {
    const unavailable = await handleShellExec(
      { input: "man --search -- 'generate an image'" },
      makeContext({ capabilities: ["shell.exec"] }),
    );
    const available = await handleShellExec(
      { input: "man --search -- 'generate an image'" },
      makeContext({ capabilities: ["shell.exec", "ai.image.generate"] }),
    );

    expect(unavailable.stdout).toContain("command\ttxt2img\tno (ai.image.generate)");
    expect(available.stdout).toContain("command\ttxt2img\tyes");
  });

  it("renders fallback manuals for every registered native command", async () => {
    const result = await handleShellExec(
      { input: "man img2txt" },
      makeContext({ capabilities: ["shell.exec"] }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("IMG2TXT(1)");
    expect(result.stdout).toContain("WHEN TO USE");
    expect(result.stdout).toContain("img2txt [caption] [OPTIONS] IMAGE");
    expect(result.stdout).toContain("img2txt detect --target TEXT [OPTIONS] IMAGE");
  });

  it("documents the generic outbound file bridge", async () => {
    const result = await handleShellExec(
      { input: "man message" },
      makeContext({ capabilities: ["shell.exec", "adapter.send"] }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("MESSAGE(1)");
    expect(result.stdout).toContain("message current [--json]");
    expect(result.stdout).toContain("[--delivery-id ID] [--also]");
    expect(result.stdout).toContain("message send [--message TEXT]");
    expect(result.stdout).toContain("append `&& yield`");
    expect(result.stdout).toContain("message send --to DESTINATION");
    expect(result.stdout).toContain("message route set --process PID_OR_LABEL");
    expect(result.stdout).toContain("personal intelligence");
    expect(result.stdout).toContain("temporary work direct line");
    expect(result.stdout).toContain("Use /ship inside that DM");
    expect(result.stdout).toContain("--attach PATH");
  });

  it("keeps transport-only messaging adapters out of the current target inventory", async () => {
    const targets = await handleShellExec(
      { input: "man targets" },
      makeContext({ capabilities: ["shell.exec"] }),
    );
    const sched = await handleShellExec(
      { input: "man sched" },
      makeContext({ capabilities: ["shell.exec"] }),
    );

    expect(targets.ok).toBe(true);
    expect(targets.stdout).toContain("device   Registered targets backed by machines or browser profiles");
    expect(targets.stdout).not.toContain("adapter  External messaging surfaces");
    expect(targets.stdout).not.toContain("targets search whatsapp");
    expect(sched.stdout).toContain("creates a direct scheduled delivery");
    expect(sched.stdout).not.toContain("adapter.send target");
  });

  it("prints exact next actions and structured JSON results", async () => {
    const result = await handleShellExec(
      { input: "man --search --json -- 'find a connected browser'" },
      makeContext({ capabilities: ["shell.exec"] }),
    );

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.query).toBe("find a connected browser");
    expect(parsed.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "command", name: "targets", next: "man 'targets'" }),
    ]));
  });

  it("discovers live filesystem skills when prompt enumeration is off", async () => {
    const readPaths: string[] = [];
    const ripgit = makeSkillFetcher({
      "instagram.md": [
        "---",
        "name: instagram-browser",
        "description: Automate Instagram browsing in a connected browser.",
        "---",
        "",
        "Open the connected browser and inspect the requested Instagram feed.",
      ].join("\n"),
    }, readPaths);
    const ctx = makeContext({
      capabilities: ["shell.exec"],
      config: { "config/ai/skills/index_mode": "off" },
      ripgit,
    });
    const result = await handleShellExec(
      { input: "man --search -- 'browse my instagram feed'" },
      ctx,
    );
    const json = await handleShellExec(
      { input: "man --search --json -- 'browse instagram'" },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(readPaths).toContain("skills.d");
    expect(readPaths).toContain("skills.d/instagram.md");
    expect(result.stdout.split("\n")[2]).toContain("workflow\tinstagram-browser\t");
    expect(result.stdout).toContain("workflow\tinstagram-browser\t");
    expect(result.stdout).toContain("skills show 'instagram-browser'");
    expect(json.stdout).not.toContain("Open the connected browser");
  });

  it("discovers only caller-visible connected targets", async () => {
    const devices = {
      listForUser: vi.fn(() => [makeDevice({
        device_id: "studio-mac",
        label: "Studio MacBook",
        description: "Laptop used for design work.",
        platform: "darwin",
        implements: ["shell.exec", "fs.*"],
      })]),
    };
    const visible = await handleShellExec(
      { input: "man --search -- 'work on studio macbook'" },
      makeContext({ capabilities: ["shell.exec", "sys.device.list"], devices }),
    );
    const hidden = await handleShellExec(
      { input: "man --search -- 'work on studio macbook'" },
      makeContext({ capabilities: ["shell.exec"], devices }),
    );

    expect(visible.ok).toBe(true);
    expect(visible.stdout).toContain("target\tstudio-mac\t");
    expect(visible.stdout).toContain("targets show 'studio-mac'");
    expect(hidden.stdout).not.toContain("target\tstudio-mac\t");
  });
});

describe("oauth native command", () => {
  function oauthAccount(metadata: JsonObject = {}) {
    return {
      accountId: "acct-codex",
      uid: 1000,
      kind: "ai-provider",
      provider: "openai-codex",
      accountKey: "default",
      label: "OpenAI Codex",
      scope: "openid profile email offline_access",
      resource: null,
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      tokenType: "Bearer",
      expiresAt: 1_800_000_000_000,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      lastUsedAt: null,
      metadata,
    };
  }

  it("lists OAuth accounts with Codex readiness", async () => {
    const oauth = {
      listAccounts: vi.fn(() => [oauthAccount({ chatgptAccountId: "chatgpt-account-1" })]),
      listFlows: vi.fn(() => []),
      deleteAccount: vi.fn(),
    };

    const result = await handleShellExec(
      { input: "oauth list" },
      makeContext({ capabilities: ["sys.oauth.list"], oauth }),
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("acct-codex");
    expect(result.stdout).toContain("openai-codex");
    expect(result.stdout).toContain("ready");
  });

  it("reports Codex OAuth status as not ready without account metadata", async () => {
    const oauth = {
      listAccounts: vi.fn(() => [oauthAccount()]),
      listFlows: vi.fn(() => []),
      deleteAccount: vi.fn(),
    };

    const result = await handleShellExec(
      { input: "oauth codex status" },
      makeContext({ capabilities: ["sys.oauth.list"], oauth }),
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("connected=yes");
    expect(result.stdout).toContain("ready=no");
  });

  it("forgets OAuth accounts", async () => {
    const deleteAccount = vi.fn(() => true);
    const oauth = {
      listAccounts: vi.fn(() => []),
      listFlows: vi.fn(() => []),
      deleteAccount,
    };

    const result = await handleShellExec(
      { input: "oauth forget acct-codex" },
      makeContext({ capabilities: ["sys.oauth.forget"], oauth }),
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("forgot acct-codex");
    expect(deleteAccount).toHaveBeenCalledWith("acct-codex", 1000);
  });
});

describe("media native commands", () => {
  it("registers the llm command and enforces text generation capability", async () => {
    const help = await handleShellExec(
      { input: "llm --help" },
      makeContext({ capabilities: [] }),
    );
    expect(help.ok).toBe(true);
    expect(help.stdout).toContain("llm [OPTIONS] PROMPT...");

    const manual = await handleShellExec(
      { input: "man llm" },
      makeContext({ capabilities: [] }),
    );
    expect(manual.ok).toBe(true);
    expect(manual.stdout).toContain("LLM(1)");
    expect(manual.stdout).toContain("ai.text.generate");

    const denied = await handleShellExec(
      { input: "llm hello" },
      makeContext({ capabilities: [] }),
    );
    expect(denied.exitCode).toBe(1);
    expect(denied.stderr).toContain("Permission denied: ai.text.generate");
  });

  it("decodes UTF-8 stdin before invoking llm", async () => {
    generateMock.mockImplementationOnce(async (request: any) => {
      expect(request.context.messages[0].content).toBe("café ☕");
      return {
        role: "assistant",
        content: [{ type: "text", text: "received" }],
        api: "test",
        provider: "workers-ai",
        model: "@cf/test/model",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      };
    });

    const result = await handleShellExec(
      { input: "printf 'café ☕' | llm" },
      makeContext({ capabilities: ["ai.text.generate"] }),
    );

    expect(result.status, result.stderr).toBe("completed");
    expect(result.stdout).toBe("received\n");
  });

  it("fails llm when text generation returns an error message", async () => {
    generateMock.mockResolvedValueOnce({
      role: "assistant",
      content: [],
      api: "test",
      provider: "workers-ai",
      model: "@cf/test/model",
      usage: {
        input: 1,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: "billing required",
    });

    const result = await handleShellExec(
      { input: "llm hello" },
      makeContext({ capabilities: ["ai.text.generate"] }),
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("llm: billing required");
  });

  it("uses the native net.fetch transport for llm presets with an origin machine", async () => {
    generateMock.mockImplementationOnce(async (request: any) => {
      expect(request.config).toMatchObject({
        provider: "custom",
        model: "local-model",
        baseUrl: "http://127.0.0.1:18081/v1",
        providerStyle: "openai-chat-completions",
        transportTarget: "linux-machine",
      });
      return {
        role: "assistant",
        content: [{ type: "text", text: "pong" }],
        api: "test",
        provider: "custom",
        model: "local-model",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      };
    });

    const device = makeDevice({
      device_id: "linux-machine",
      implements: ["net.fetch"],
    });
    const devices = {
      canAccess: vi.fn(() => true),
      get: vi.fn(() => device),
      listForUser: vi.fn(() => [device]),
    };
    const requestDevice = vi.fn();

    const result = await handleShellExec(
      { input: "llm --preset local hello" },
      makeContext({
        capabilities: ["ai.text.generate"],
        devices,
        config: {
          "users/1000/ai/model_profiles": JSON.stringify({
            profiles: [{
              id: "local",
              name: "Local",
              values: {
                "config/ai/provider": "custom",
                "config/ai/model": "local-model",
                "config/ai/base_url": "http://127.0.0.1:18081/v1",
                "config/ai/provider_style": "openai-chat-completions",
                "config/ai/transport_target": "linux-machine",
                "config/ai/api_key": "redacted",
              },
              createdAt: 1,
              updatedAt: 1,
            }],
          }),
          "users/1000/ai/model_profiles/local/api_key": "local-key",
        },
      }),
      {
        netFetchTransport: {
          requestDevice,
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("pong\n");
    expect(result.stderr).toBe("");
    expect(generateMock).toHaveBeenCalledOnce();
    expect(devices.canAccess).toHaveBeenCalledWith("linux-machine", 1000, [1000, 100]);
  });

  it("runs standalone media commands through the configured AI media paths", async () => {
    const result = await handleShellExec(
      {
        input: [
          "printf 'image-bytes' > media.png",
          "printf 'audio-bytes' > sample.mp3",
          "img2txt media.png",
          "stt sample.mp3",
          "printf 'green square' | txt2img -o out.png",
          "printf 'hello voice' | tts -o speech.mp3",
          "ls out.png speech.mp3",
        ].join("; "),
      },
      makeContext({
        capabilities: [
          "ai.image.read",
          "ai.image.generate",
          "ai.transcription.create",
          "ai.speech.create",
        ],
        aiRun: vi.fn(async (_model, input) => {
          if (input.task === "caption") {
            return { caption: "terminal screenshot" };
          }
          if (input.audio !== undefined) {
            return { text: "hello audio" };
          }
          if (input.text !== undefined) {
            return new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([4, 5, 6]));
                controller.close();
              },
            });
          }
          if (input.prompt !== undefined) {
            return { image: "AQID" };
          }
          return null;
        }),
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("terminal screenshot");
    expect(result.stdout).toContain("hello audio");
    expect(result.stdout).toContain("/home/sam/out.png");
    expect(result.stdout).toContain("/home/sam/speech.mp3");
    expect(result.stdout).toContain("out.png");
    expect(result.stdout).toContain("speech.mp3");
  });

  it("preserves generated image MIME when the output extension differs", async () => {
    const key = "home/sam/generated-jpeg.png";
    let imageReadInput: ShellAiInput | undefined;
    await env.STORAGE.delete(key);

    const result = await handleShellExec(
      {
        input: "txt2img -o generated-jpeg.png green-square; img2txt generated-jpeg.png",
      },
      makeContext({
        capabilities: ["ai.image.read", "ai.image.generate"],
        aiRun: vi.fn(async (_model, input) => {
          if (input.task === "caption") {
            imageReadInput = input;
            return { caption: "a green square" };
          }
          if (input.prompt !== undefined) {
            return { image: "/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==" };
          }
          return null;
        }),
      }),
    );

    const stored = await env.STORAGE.get(key);
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect(result.stdout).toContain("a green square");
    expect(stored?.httpMetadata?.contentType).toBe("image/jpeg");
    expect([...new Uint8Array(await stored!.arrayBuffer()).subarray(0, 4)])
      .toEqual([0xff, 0xd8, 0xff, 0xe0]);
    expect(JSON.stringify(imageReadInput)).toContain("data:image/jpeg;base64,");
  });
});

describe("targets native command", () => {
  it("lists targets with pagination and keeps devices as an alias", async () => {
    const records = [
      makeDevice({
        device_id: "macbook",
        label: "Work MacBook",
        description: "Laptop",
        platform: "darwin",
        implements: ["shell.exec", "fs.read"],
      }),
      makeDevice({
        device_id: "rearden:brave",
        label: "Browser",
        platform: "browser-extension",
        implements: ["shell.exec", "fs.*"],
      }),
    ];
    const devices = {
      listForUser: vi.fn(() => records),
    };

    const result = await handleShellExec(
      { input: "targets list --limit 2" },
      makeContext({ capabilities: ["sys.device.list"], devices }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("TARGET\tPROVIDER\tSTATE\tPLATFORM\tCAPS\tLABEL");
    expect(result.stdout).toContain("gsv\tkernel\tonline\tcloudflare-worker");
    expect(result.stdout).toContain("Showing 1-2 of 3");

    const browserSearch = await handleShellExec(
      { input: "targets search browser-extension" },
      makeContext({ capabilities: ["sys.device.list"], devices }),
    );
    expect(browserSearch.ok).toBe(true);
    expect(browserSearch.stdout).toContain("rearden:brave\tdevice\tonline\tbrowser-extension");

    const alias = await handleShellExec(
      { input: "devices search macbook" },
      makeContext({ capabilities: ["sys.device.list"], devices }),
    );
    expect(alias.ok).toBe(true);
    expect(alias.stdout).toContain("macbook\tdevice\tonline\tdarwin");
  });

  it("keeps registered offline targets visible by default", async () => {
    const devices = {
      listForUser: vi.fn(() => [
        makeDevice({
          device_id: "macbook",
          label: "Work MacBook",
          platform: "darwin",
          online: false,
          connected_at: null,
          disconnected_at: 1_800_000_000_000,
        }),
      ]),
    };
    const ctx = makeContext({ capabilities: ["sys.device.list"], devices });

    const result = await handleShellExec({ input: "targets list" }, ctx);

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("macbook\tdevice\toffline\tdarwin");

    const onlineOnly = await handleShellExec({ input: "targets list --online" }, ctx);
    expect(onlineOnly.ok).toBe(true);
    expect(onlineOnly.stdout).not.toContain("macbook");
  });

  it("shows target details", async () => {
    const record = makeDevice({
      device_id: "macbook",
      label: "Work MacBook",
      description: "Laptop",
      platform: "darwin",
      implements: ["shell.exec", "fs.read"],
    });
    const devices = {
      canAccess: vi.fn(() => true),
      get: vi.fn(() => record),
    };
    const auth = {
      getPasswdByUid: vi.fn(() => ({ username: "sam" })),
    };

    const result = await handleShellExec(
      { input: "targets show macbook" },
      makeContext({ capabilities: ["sys.device.get"], devices, auth }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("target: macbook");
    expect(result.stdout).toContain("provider: device");
    expect(result.stdout).toContain("owner: sam (uid 1000)");
    expect(result.stdout).toContain("- shell.exec");
    expect(result.stdout).toContain("- fs.read");

    const native = await handleShellExec(
      { input: "targets show gsv" },
      makeContext({ capabilities: ["sys.device.get"] }),
    );
    expect(native.stdout).toContain("description: Native GSV capability environment.");
    expect(native.stdout).toContain("- net.fetch");
    expect(native.stdout).not.toContain("- codemode.exec");
  });
});

describe("proc native command", () => {
  function makeLifecycleContext(capability: "proc.reset" | "proc.kill") {
    const process = {
      processId: "proc:child",
      uid: IDENTITY.uid,
      ownerUid: IDENTITY.uid,
      activeRunId: "run-child",
    };
    const kill = vi.fn();
    const cancelBySourcePid = vi.fn();
    const failIpcCallsByTarget = vi.fn();
    const clearProcessRoutes = vi.fn();
    const ctx = makeContext({
      capabilities: [capability],
      procs: {
        get: vi.fn((pid: string) => pid === process.processId ? process : null),
        getOwnerUid: vi.fn(() => IDENTITY.uid),
        kill,
      },
      ipcCalls: {
        cancelBySourcePid,
      },
      responsibilities: {
        reclaimProcessAssignments: vi.fn(() => []),
      },
      reconcileResponsibilityWake: vi.fn(async () => undefined),
    });
    Object.assign(ctx, {
      failIpcCallsByTarget,
      runRoutes: {
        clearForProcess: clearProcessRoutes,
        inheritProcessApprovalRoute: vi.fn(),
      },
      defer: vi.fn(),
    });
    return {
      ctx,
      kill,
      cancelBySourcePid,
      failIpcCallsByTarget,
      clearProcessRoutes,
    };
  }

  it("lists runnable accounts", async () => {
    const passwd = [
      { username: "sam", uid: 1000, gid: 1000, gecos: "Sam", home: "/home/sam", shell: "/bin/init" },
      { username: "sam-agent", uid: 1001, gid: 1001, gecos: "Sam's agent", home: "/home/sam-agent", shell: "/bin/init" },
    ];
    const auth = {
      getPasswdByUid: vi.fn((uid: number) => passwd.find((u) => u.uid === uid) ?? null),
      getPasswdEntries: vi.fn(() => passwd.map((u) => ({ ...u }))),
      getPersonalAgentUid: vi.fn(() => 1001),
      getGroupByGid: vi.fn((gid: number) => ({ name: passwd.find((u) => u.uid === gid)?.username ?? "g", gid, members: [] })),
      getGroupByName: vi.fn(() => null),
      getShadowByUsername: vi.fn((username: string) => ({ username, hash: username === "sam-agent" ? "!" : "x" })),
    };

    const result = await handleShellExec(
      { input: "proc agents" },
      makeContext({
        capabilities: ["account.list"],
        auth,
        procs: { getOwnerUid: () => 1000 },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("1000\tsam\tself\tSam");
    expect(result.stdout).toContain("1001\tsam-agent\tpersonal-agent\tSam's agent");
  });

  it("routes spawn through the native proc command surface", async () => {
    const spawn = vi.fn();
    const result = await handleShellExec(
      { input: "proc spawn --non-interactive --cwd ~/src --label build" },
      makeContext({
        capabilities: ["proc.spawn"],
        procs: {
          get() {
            return {
              processId: "init:1000",
              uid: IDENTITY.uid,
              ownerUid: IDENTITY.uid,
              gid: IDENTITY.gid,
              gids: IDENTITY.gids,
              username: IDENTITY.username,
              home: IDENTITY.home,
              cwd: IDENTITY.cwd,
              profile: "init",
              state: "running",
              createdAt: 1,
            };
          },
          spawn,
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("label=\"build\"");
    expect(result.stdout).toContain("cwd=\"/home/sam/src\"");
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: "/home/sam/src" }),
      expect.objectContaining({
        interactive: false,
        label: "build",
        cwd: "/home/sam/src",
      }),
    );
  });

  it("spawns a process from a top-level native shell", async () => {
    const spawn = vi.fn();
    const rootIdentity: ProcessIdentity = {
      uid: 0,
      gid: 0,
      gids: [0],
      username: "root",
      home: "/root",
      cwd: "/root",
    };
    const ctx = makeContext({
      identity: rootIdentity,
      capabilities: ["proc.spawn"],
      procs: { spawn },
    });
    ctx.processId = undefined;

    const result = await handleShellExec(
      { input: 'proc spawn --label manual-child --prompt "do work"' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('label="manual-child"');
    expect(spawn).toHaveBeenCalledWith(
      expect.stringMatching(/^proc:/),
      expect.objectContaining({ username: "root" }),
      expect.objectContaining({
        interactive: true,
        label: "manual-child",
      }),
    );
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      TEST_INSTALLATION_ID,
      expect.stringMatching(/^proc:/),
      expect.objectContaining({ call: "proc.send", args: expect.objectContaining({ message: "do work" }) }),
    );

    const jsonResult = await handleShellExec(
      { input: `proc spawn --json '{"label":"json-child"}'` },
      ctx,
    );
    expect(jsonResult.ok).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenLastCalledWith(
      expect.stringMatching(/^proc:/),
      expect.anything(),
      expect.objectContaining({ label: "json-child" }),
    );
  });

  it("rejects unknown proc spawn options instead of appending them to the prompt", async () => {
    const spawn = vi.fn();
    const result = await handleShellExec(
      { input: 'proc spawn --label facts "Generate a fact" --timeout 1m' },
      makeContext({
        capabilities: ["proc.spawn"],
        procs: { spawn },
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.stderr).toContain("unexpected option: --timeout");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("accepts dash-prefixed proc spawn prompts after the option delimiter", async () => {
    const parent = {
      processId: "task:shell",
      uid: IDENTITY.uid,
      ownerUid: IDENTITY.uid,
      gid: IDENTITY.gid,
      gids: IDENTITY.gids,
      username: IDENTITY.username,
      home: IDENTITY.home,
      cwd: IDENTITY.cwd,
      state: "running",
      activeRunId: null,
      queuedCount: 0,
      lastActiveAt: null,
      interactive: true,
      parentPid: null,
      label: null,
      createdAt: 1,
    };
    const spawn = vi.fn();
    const result = await handleShellExec(
      { input: "proc spawn -- --timeout 1m" },
      makeContext({
        capabilities: ["proc.spawn"],
        procs: {
          get: vi.fn((pid: string) => pid === parent.processId ? parent : null),
          getOwnerUid: vi.fn(() => IDENTITY.uid),
          spawn,
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      TEST_INSTALLATION_ID,
      expect.stringMatching(/^proc:/),
      expect.objectContaining({
        call: "proc.send",
        args: expect.objectContaining({ message: "--timeout 1m" }),
      }),
    );
  });

  it("resets a process through the kernel lifecycle path", async () => {
    const { ctx, cancelBySourcePid, failIpcCallsByTarget } = makeLifecycleContext("proc.reset");
    sendFrameToProcessMock.mockResolvedValueOnce({
      type: "res",
      id: "reset-child",
      ok: true,
      data: {
        ok: true,
        pid: "proc:child",
        archivedMessages: 3,
        archivedTo: "/home/sam/archive.jsonl.gz",
        archives: [],
      },
    });

    const result = await handleShellExec(
      { input: "proc reset --pid proc:child" },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('pid=proc:child archived=3 archive="/home/sam/archive.jsonl.gz"\n');
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      TEST_INSTALLATION_ID,
      "proc:child",
      expect.objectContaining({ call: "proc.reset", args: { pid: "proc:child" } }),
    );
    expect(cancelBySourcePid).toHaveBeenCalledWith({ uid: IDENTITY.uid, sourcePid: "proc:child" });
    expect(failIpcCallsByTarget).toHaveBeenCalledWith(
      IDENTITY.uid,
      "proc:child",
      "Target process was reset",
    );
  });

  it("kills a process without archiving through the kernel lifecycle path", async () => {
    const {
      ctx,
      kill,
      cancelBySourcePid,
      failIpcCallsByTarget,
      clearProcessRoutes,
    } = makeLifecycleContext("proc.kill");
    sendFrameToProcessMock.mockResolvedValueOnce({
      type: "res",
      id: "kill-child",
      ok: true,
      data: {
        ok: true,
        pid: "proc:child",
        archivedMessages: 0,
        archives: [],
      },
    });

    const result = await handleShellExec(
      { input: "proc kill proc:child --no-archive" },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("pid=proc:child archived=0\n");
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      TEST_INSTALLATION_ID,
      "proc:child",
      expect.objectContaining({ call: "proc.kill", args: { pid: "proc:child", archive: false } }),
    );
    expect(cancelBySourcePid).toHaveBeenCalledWith({ uid: IDENTITY.uid, sourcePid: "proc:child" });
    expect(failIpcCallsByTarget).toHaveBeenCalledWith(
      IDENTITY.uid,
      "proc:child",
      "Target process was killed",
    );
    expect(clearProcessRoutes).toHaveBeenCalledWith("proc:child");
    expect(kill).toHaveBeenCalledWith("proc:child");
  });

  it("delegates supervised work through a new child process", async () => {
    const spawnedPids: string[] = [];
    const parent = {
      processId: "task:shell",
      uid: IDENTITY.uid,
      ownerUid: IDENTITY.uid,
      gid: IDENTITY.gid,
      gids: IDENTITY.gids,
      username: IDENTITY.username,
      home: IDENTITY.home,
      cwd: IDENTITY.cwd,
      profile: "task",
      state: "running",
      activeRunId: "parent-run",
      createdAt: 1,
    };
    const spawn = vi.fn((pid: string) => {
      spawnedPids.push(pid);
    });
    const ipcCalls = {
      create: vi.fn(),
      get: vi.fn(() => ({ status: "pending", error: null })),
      remove: vi.fn(),
    };
    const scheduleIpcCallTimeout = vi.fn(async () => "timeout-schedule");

    sendFrameToProcessMock.mockImplementation(async (_installationId, pid, frame) => {
      if (frame.type !== "req") throw new Error("expected process request frame");
      const req = frame;
      if (req.call === "proc.setidentity") {
        return { type: "res", id: req.id, ok: true, data: { ok: true } };
      }
      if (req.call === "proc.ipc.deliver") {
        expect(pid).toBe(spawnedPids[0]);
        expect(req.args.message).toBe("write a migration plan");
        expect(req.args.metadata).toBeUndefined();
        expect(req.args.call).toEqual(expect.objectContaining({
          callId: expect.any(String),
          deadlineAt: expect.any(Number),
          supervised: true,
        }));
        return {
          type: "res",
          id: req.id,
          ok: true,
          data: {
            ok: true,
            status: "started",
            pid,
            sourcePid: "task:shell",
            runId: req.args.runId,
          },
        };
      }
      throw new Error(`unexpected process frame: ${req.call}`);
    });

    const result = await handleShellExec(
      { input: "proc delegate --label planning --timeout 10m write a migration plan" },
      makeContext({
        capabilities: ["proc.spawn", "proc.ipc.call"],
        procs: {
          get(pid: string) {
            if (pid === "task:shell") return parent;
            if (pid === spawnedPids[0]) {
              return {
                ...parent,
                processId: pid,
                parentPid: "task:shell",
                interactive: false,
                label: "planning",
              };
            }
            return null;
          },
          getOwnerUid: vi.fn(() => IDENTITY.uid),
          spawn,
        },
        ipcCalls,
        scheduleIpcCallTimeout,
        processRunId: "parent-run",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("status=in_progress");
    const createdCall = ipcCalls.create.mock.calls[0]?.[0];
    expect(result.stdout).toContain(`run_id=${createdCall.targetRunId}`);
    expect(result.stdout).toContain("queued=false");
    expect(result.stdout).toContain("check_in=");
    expect(result.stdout).toContain('label="planning"');
    expect(spawn).toHaveBeenCalledWith(
      spawnedPids[0],
      expect.objectContaining({ username: "sam" }),
      expect.objectContaining({
        parentPid: "task:shell",
        interactive: false,
        label: "planning",
      }),
    );
    expect(ipcCalls.create).toHaveBeenCalledWith(expect.objectContaining({
      sourcePid: "task:shell",
      sourceRunId: "parent-run",
      targetPid: spawnedPids[0],
      targetRunId: expect.any(String),
      uid: IDENTITY.uid,
    }));
    const callId = createdCall.callId;
    expect(scheduleIpcCallTimeout).toHaveBeenCalledWith(
      callId,
      createdCall.deadlineAt,
      {
        mode: "supervise",
        intervalMs: 600_000,
        checkInCount: 0,
      },
    );
  });

  it("schedules supervision before assigning and admitting delegated work", async () => {
    const responsibilityId = "r12y:11111111-1111-4111-8111-111111111111";
    const parent = makeProcess({
      processId: "task:shell",
      isPersonalController: true,
      state: "running",
      activeRunId: "parent-run",
    });
    const children: string[] = [];
    const order: string[] = [];
    let responsibility: ResponsibilityRecord = {
      id: responsibilityId,
      ownerUid: IDENTITY.uid,
      title: "write a migration plan",
      source: { kind: "process", processId: parent.processId, runId: "parent-run" },
      assignee: { kind: "ship" },
      state: "open",
      priority: "normal",
      revision: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const update = vi.fn((input: ResponsibilityUpdateInput) => {
      expect(input.expectedRevision).toBe(responsibility.revision);
      responsibility = applyResponsibilityTestUpdate(responsibility, input);
      order.push("assigned");
      return { record: responsibility, revision: responsibility.revision, changed: true };
    });
    const ipcCalls = {
      create: vi.fn(),
      get: vi.fn(() => ({ status: "pending", error: null })),
      remove: vi.fn(),
    };
    const ctx = makeContext({
      capabilities: ["proc.spawn", "proc.ipc.call", "r12y.get", "r12y.update"],
      procs: {
        get(pid: string) {
          if (pid === parent.processId) return parent;
          if (pid === children[0]) {
            return makeProcess({
              processId: pid,
              parentPid: parent.processId,
              interactive: false,
              label: "planning",
            });
          }
          return null;
        },
        getOwnerUid: vi.fn(() => IDENTITY.uid),
        spawn: vi.fn((pid: string) => children.push(pid)),
      },
      responsibilities: {
        get: vi.fn(() => responsibility),
        revision: vi.fn(() => responsibility.revision),
        update,
        reclaimProcessAssignments: vi.fn(() => []),
      },
      reconcileResponsibilityWake: vi.fn(async () => {
        order.push("responsibility wake scheduled");
      }),
      ipcCalls,
      scheduleIpcCallTimeout: vi.fn(async () => {
        order.push("supervision scheduled");
        return "timeout-schedule";
      }),
      processRunId: "parent-run",
    });
    sendFrameToProcessMock.mockImplementation(async (_installationId, pid, frame) => {
      if (frame.type !== "req") throw new Error("expected process request frame");
      if (frame.call === "proc.setidentity") {
        return { type: "res", id: frame.id, ok: true, data: { ok: true } };
      }
      if (frame.call === "proc.ipc.deliver") {
        order.push("delivered");
        expect(pid).toBe(children[0]);
        expect(frame.args.metadata).toEqual({ responsibilityId });
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: {
            ok: true,
            status: "started",
            pid,
            sourcePid: parent.processId,
            runId: frame.args.runId,
          },
        };
      }
      throw new Error(`unexpected process frame: ${frame.call}`);
    });

    const result = await handleShellExec({
      input: `proc delegate --responsibility ${responsibilityId} --label planning analyze schema`,
    }, ctx);

    expect(result.ok).toBe(true);
    expect(order).toEqual([
      "supervision scheduled",
      "assigned",
      "responsibility wake scheduled",
      "delivered",
    ]);
    expect(responsibility.assignee).toEqual({ kind: "process", processId: children[0] });
    expect(responsibility.state).toBe("active");
    expect(responsibility.leaseExpiresAtMs).toEqual(expect.any(Number));
    expect(ipcCalls.create).toHaveBeenCalledWith(expect.objectContaining({
      responsibilityId,
    }));
    expect(responsibility.leaseExpiresAtMs).toBe(
      ipcCalls.create.mock.calls[0]?.[0].deadlineAt,
    );
    expect(result.stdout).toContain(`responsibility=${responsibilityId}`);
  });

  it("returns a responsibility to Ship when delegated admission fails", async () => {
    const responsibilityId = "r12y:22222222-2222-4222-8222-222222222222";
    const parent = makeProcess({
      processId: "task:shell",
      isPersonalController: true,
      state: "running",
      activeRunId: "parent-run",
    });
    const children: string[] = [];
    let responsibility: ResponsibilityRecord = {
      id: responsibilityId,
      ownerUid: IDENTITY.uid,
      title: "inspect deployment",
      source: { kind: "process", processId: parent.processId, runId: "parent-run" },
      assignee: { kind: "ship" },
      state: "waiting",
      priority: "normal",
      nextCheckAtMs: 99_000,
      blocker: "waiting for a worker",
      revision: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const update = vi.fn((input: ResponsibilityUpdateInput) => {
      responsibility = applyResponsibilityTestUpdate(responsibility, input);
      return { record: responsibility, revision: responsibility.revision, changed: true };
    });
    const kill = vi.fn();
    const ctx = makeContext({
      capabilities: [
        "proc.spawn",
        "proc.ipc.call",
        "proc.kill",
        "r12y.get",
        "r12y.update",
      ],
      procs: {
        get(pid: string) {
          if (pid === parent.processId) return parent;
          if (pid === children[0]) {
            return makeProcess({
              processId: pid,
              parentPid: parent.processId,
              interactive: false,
            });
          }
          return null;
        },
        getOwnerUid: vi.fn(() => IDENTITY.uid),
        spawn: vi.fn((pid: string) => children.push(pid)),
        kill,
      },
      responsibilities: {
        get: vi.fn(() => responsibility),
        revision: vi.fn(() => responsibility.revision),
        update,
        reclaimProcessAssignments: vi.fn(() => []),
      },
      reconcileResponsibilityWake: vi.fn(async () => undefined),
      ipcCalls: {
        create: vi.fn(),
        remove: vi.fn(),
        cancelBySourcePid: vi.fn(),
      },
      scheduleIpcCallTimeout: vi.fn(async () => "timeout-schedule"),
      processRunId: "parent-run",
    });
    Object.assign(ctx, {
      failIpcCallsByTarget: vi.fn(),
      runRoutes: {
        clearForProcess: vi.fn(),
        inheritProcessApprovalRoute: vi.fn(),
      },
      defer: vi.fn(),
    });
    sendFrameToProcessMock.mockImplementation(async (_installationId, _pid, frame) => {
      if (frame.type !== "req") throw new Error("expected process request frame");
      if (frame.call === "proc.setidentity") {
        return { type: "res", id: frame.id, ok: true, data: { ok: true } };
      }
      if (frame.call === "proc.ipc.deliver") {
        return {
          type: "res",
          id: frame.id,
          ok: false,
          error: { code: "DELIVERY_FAILED", message: "delivery failed" },
        };
      }
      if (frame.call === "proc.kill") {
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: {
            ok: true,
            pid: children[0],
            archivedMessages: 0,
            archives: [],
          },
        };
      }
      throw new Error(`unexpected process frame: ${frame.call}`);
    });

    const result = await handleShellExec({
      input: `proc delegate --responsibility ${responsibilityId} inspect deployment`,
    }, ctx);

    expect(result.status).toBe("failed");
    expect(result.stderr).toContain("delivery failed");
    expect(responsibility.assignee).toEqual({ kind: "ship" });
    expect(responsibility.state).toBe("waiting");
    expect(responsibility.blocker).toBe("waiting for a worker");
    expect(responsibility.nextCheckAtMs).toBe(99_000);
    expect(responsibility.leaseExpiresAtMs).toBeUndefined();
    expect(update).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledWith(children[0]);
  });

  it("rejects delegation from a top-level shell before spawning", async () => {
    const spawn = vi.fn();
    const ctx = makeContext({
      capabilities: ["proc.spawn", "proc.ipc.call"],
      procs: { spawn },
    });
    ctx.processId = undefined;

    const result = await handleShellExec(
      { input: "proc delegate investigate the schedule" },
      ctx,
    );

    expect(result.status).toBe("failed");
    expect(result.stderr).toContain("proc.ipc.call requires a process caller");
    expect(spawn).not.toHaveBeenCalled();
    expect(sendFrameToProcessMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "IPC delivery returns an error",
      throws: false,
      error: "delivery failed",
    },
    {
      label: "IPC setup throws",
      throws: true,
      error: "IPC store unavailable",
    },
  ])("rolls back a delegated child when $label", async ({
    throws,
    error,
  }) => {
    const children: string[] = [];
    const parent = {
      processId: "task:shell",
      uid: IDENTITY.uid,
      ownerUid: IDENTITY.uid,
      gid: IDENTITY.gid,
      gids: IDENTITY.gids,
      username: IDENTITY.username,
      home: IDENTITY.home,
      cwd: IDENTITY.cwd,
      state: "running",
      activeRunId: "parent-run",
      queuedCount: 0,
      lastActiveAt: 1,
      interactive: true,
      parentPid: null,
      label: "parent",
      createdAt: 1,
    };
    const spawn = vi.fn((pid: string) => children.push(pid));
    const kill = vi.fn();
    const ipcCalls = {
      create: throws
        ? vi.fn(() => { throw new Error(error); })
        : vi.fn(),
      remove: vi.fn(),
      cancelBySourcePid: vi.fn(),
    };
    const ctx = makeContext({
      capabilities: ["proc.spawn", "proc.ipc.call"],
      procs: {
        get: vi.fn((pid: string) => {
          if (pid === parent.processId) return parent;
          if (pid === children[0]) {
            return {
              ...parent,
              processId: pid,
              parentPid: parent.processId,
              activeRunId: null,
              interactive: false,
              label: "investigate the schedule",
            };
          }
          return null;
        }),
        getOwnerUid: vi.fn(() => IDENTITY.uid),
        spawn,
        kill,
      },
      ipcCalls,
      responsibilities: {
        reclaimProcessAssignments: vi.fn(() => []),
      },
      reconcileResponsibilityWake: vi.fn(async () => undefined),
      scheduleIpcCallTimeout: vi.fn(async () => "timeout-schedule"),
      processRunId: "parent-run",
    });
    Object.assign(ctx, {
      failIpcCallsByTarget: vi.fn(),
      runRoutes: {
        clearForProcess: vi.fn(),
        inheritProcessApprovalRoute: vi.fn(),
      },
      defer: vi.fn(),
    });
    sendFrameToProcessMock.mockImplementation(async (_installationId, _pid, frame) => {
      if (frame.type !== "req") throw new Error("expected process request frame");
      const req = frame;
      if (req.call === "proc.setidentity") {
        return { type: "res", id: req.id, ok: true, data: { ok: true } };
      }
      if (req.call === "proc.ipc.deliver" && !throws) {
        return {
          type: "res",
          id: req.id,
          ok: false,
          error: { code: "DELIVERY_FAILED", message: "delivery failed" },
        };
      }
      if (req.call === "proc.kill") {
        return {
          type: "res",
          id: req.id,
          ok: true,
          data: {
            ok: true,
            pid: children[0],
            archivedMessages: 0,
            archives: [],
          },
        };
      }
      throw new Error(`unexpected process frame: ${req.call}`);
    });

    const result = await handleShellExec(
      { input: "proc delegate investigate the schedule" },
      ctx,
    );

    expect(result.status).toBe("failed");
    expect(result.stderr).toContain(`proc delegate: ${error}`);
    expect(result.stderr).not.toContain("rollback failed");
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      TEST_INSTALLATION_ID,
      children[0],
      expect.objectContaining({
        call: "proc.kill",
        args: { pid: children[0], archive: false },
      }),
    );
    expect(kill).toHaveBeenCalledWith(children[0]);
  });

  it("rejects legacy profile selection in proc spawn", async () => {
    const result = await handleShellExec(
      { input: 'proc spawn --profile cron "Daily brief"' },
      makeContext({ capabilities: ["proc.spawn"] }),
    );

    expect(result.status).toBe("failed");
    expect(result.stderr).toContain("--profile is no longer supported");
  });

  it("denies history commands for same run-as processes owned by another user", async () => {
    const result = await handleShellExec(
      { input: "proc segments --pid foreign-pid" },
      makeContext({
        capabilities: ["proc.history.segments"],
        procs: {
          getOwnerUid: vi.fn(() => IDENTITY.uid),
          get: vi.fn((pid: string) => {
            if (pid === "foreign-pid") {
              return {
                processId: "foreign-pid",
                uid: 1001,
                ownerUid: 1002,
                gid: 1001,
                gids: [1001],
                username: "shared-agent",
                home: "/home/shared-agent",
                cwd: "/home/shared-agent",
                state: "idle",
                createdAt: 1,
              };
            }
            return null;
          }),
        },
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.stderr).toContain("Permission denied: cannot access process foreign-pid");
  });

  it("sets pressure-based automatic compaction policy", async () => {
    sendFrameToProcessMock.mockResolvedValueOnce({
      type: "res",
      id: "policy-1",
      ok: true,
      data: {
        ok: true,
        pid: "task:shell",
        policy: {
          overflow: "auto-compact",
          compactAtPressure: 0.9,
          compactToPressure: 0.4,
          updatedAt: 1,
        },
      },
    });

    const result = await handleShellExec(
      { input: "proc policy --compact-at 0.9 --compact-to 0.4" },
      makeContext({
        capabilities: ["proc.history.policy.set"],
        procs: {
          get: vi.fn((pid: string) => makeProcess({ processId: pid })),
          getOwnerUid: vi.fn(() => IDENTITY.uid),
        },
      }),
    );

    expect(result.status).toBe("completed");
    expect(result.stdout).toBe(
      "overflow=auto-compact compact_at=0.9 compact_to=0.4\n",
    );
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      TEST_INSTALLATION_ID,
      "task:shell",
      expect.objectContaining({
        call: "proc.history.policy.set",
        args: {
          pid: "task:shell",
          compactAtPressure: 0.9,
          compactToPressure: 0.4,
        },
      }),
    );
  });

  it("reads live process history from the native proc command surface", async () => {
    sendFrameToProcessMock.mockResolvedValueOnce({
      type: "res",
      id: "history-1",
      ok: true,
      data: {
        ok: true,
        pid: "proc:child",
        messages: [
          {
            id: 1,
            role: "user",
            content: "please investigate",
            timestamp: 1_800_000_000_000,
          },
          {
            id: 2,
            role: "toolResult",
            content: {
              toolName: "Shell",
              isError: false,
              output: "x".repeat(40),
            },
            timestamp: 1_800_000_001_000,
            runId: "run-child",
          },
        ],
        messageCount: 2,
        truncated: false,
        hasMoreBefore: false,
        hasMoreAfter: false,
        activeRunId: null,
        pendingHil: null,
        context: {
          level: "ok",
          pressure: 0.2,
        },
      },
    });

    const result = await handleShellExec(
      { input: "proc history --pid proc:child --tail --limit 2 --max-content-chars 12" },
      makeContext({
        capabilities: ["proc.history"],
        procs: {
          getOwnerUid: vi.fn(() => IDENTITY.uid),
          get: vi.fn((pid: string) => {
            if (pid === "proc:child" || pid === "task:shell") {
              return {
                processId: pid,
                uid: IDENTITY.uid,
                ownerUid: IDENTITY.uid,
                gid: IDENTITY.gid,
                gids: IDENTITY.gids,
                username: IDENTITY.username,
                home: IDENTITY.home,
                cwd: IDENTITY.cwd,
                state: "idle",
                createdAt: 1,
              };
            }
            return null;
          }),
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("History proc:child");
    expect(result.stdout).toContain("Messages: 2/2");
    expect(result.stdout).toContain("please inves");
    expect(result.stdout).toContain("[truncated 6 chars; use --full or --json to inspect all content]");
    expect(result.stdout).toContain("xxxxxxxxxxxx");
    expect(result.stdout).toContain("[truncated 28 chars; use --full or --json to inspect all content]");
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      TEST_INSTALLATION_ID,
      "proc:child",
      expect.objectContaining({
        call: "proc.history",
        args: {
          pid: "proc:child",
          limit: 2,
          tail: true,
        },
      }),
    );
  });
});

describe("fs copy", () => {
  it("sends native transfer streams", async () => {
    const sourceKey = "home/sam/copy-test/stream-source.txt";
    await env.STORAGE.delete(sourceKey);
    await env.STORAGE.put(sourceKey, "stream source", {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { uid: "1000", gid: "1000", mode: "644" },
    });

    const ctx = makeContext();

    const response = await handleFsTransferSend({
      path: "/home/sam/copy-test/stream-source.txt",
    }, ctx, "transfer-1");

    expect(response.data).toMatchObject({
      ok: true,
      path: "/home/sam/copy-test/stream-source.txt",
      size: "stream source".length,
    });
    expect(response.body?.length).toBe("stream source".length);
    expect(await new Response(response.body?.stream).text()).toBe("stream source");
  });

  it("receives native transfer streams", async () => {
    const destinationKey = "home/sam/copy-test/native-transfer-receive.txt";
    await env.STORAGE.delete(destinationKey);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello "));
        controller.enqueue(new TextEncoder().encode("world"));
        controller.close();
      },
    });

    const result = await handleFsTransferReceive({
      path: "/home/sam/copy-test/native-transfer-receive.txt",
    }, makeContext(), { stream, length: 11 });

    expect(result).toMatchObject({
      ok: true,
      path: "/home/sam/copy-test/native-transfer-receive.txt",
      bytesWritten: 11,
    });
    expect(await (await env.STORAGE.get(destinationKey))?.text()).toBe("hello world");
  });

  it("copies gsv files through the fs.copy syscall", async () => {
    const sourceKey = "home/sam/copy-test/source.txt";
    const destinationKey = "home/sam/copy-test/destination.txt";
    await env.STORAGE.delete(sourceKey);
    await env.STORAGE.delete(destinationKey);
    await env.STORAGE.put(sourceKey, "copied data", {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { uid: "1000", gid: "1000", mode: "644" },
    });

    const result = await handleFsCopy({
      source: { target: "gsv", path: "/home/sam/copy-test/source.txt" },
      destination: { target: "gsv", path: "/home/sam/copy-test/destination.txt" },
    }, makeContext());

    expect(result).toMatchObject({
      ok: true,
      size: "copied data".length,
      contentType: "text/plain; charset=utf-8",
    });
    expect(await (await env.STORAGE.get(destinationKey))?.text()).toBe("copied data");
  });

  it("copies gsv files through the native cp shell command", async () => {
    const sourceKey = "home/sam/copy-test/shell-source.txt";
    const destinationKey = "home/sam/copy-test/shell-destination.txt";
    await env.STORAGE.delete(sourceKey);
    await env.STORAGE.delete(destinationKey);
    await env.STORAGE.put(sourceKey, "shell copied", {
      customMetadata: { uid: "1000", gid: "1000", mode: "644" },
    });

    const result = await handleShellExec(
      { input: "cp /home/sam/copy-test/shell-source.txt /home/sam/copy-test/shell-destination.txt" },
      makeContext({ capabilities: ["shell.exec"] }),
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(await (await env.STORAGE.get(destinationKey))?.text()).toBe("shell copied");
  });

  it("copies a Contact resource through its authorized source stream", async () => {
    const contact = makeContact();
    const destinationKey = "home/sam/copy-test/contact-source.txt";
    await env.STORAGE.delete(destinationKey);
    const openContactSource = vi.fn(async () => ({
      size: 12,
      contentType: "text/plain",
      body: {
        length: 12,
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("from contact"));
            controller.close();
          },
        }),
      },
    }));
    const ctx = makeContext({
      capabilities: ["shell.exec", "fs.copy"],
      federation: { list: vi.fn(() => [contact]) },
    });

    const result = await handleShellExec({
      input: `cp ${contact.id}:/resources/resource:shared /home/sam/copy-test/contact-source.txt`,
    }, ctx, {
      fsTransport: {
        requestDevice: vi.fn(),
        openContactSource,
      },
    });

    expect(result).toMatchObject({ status: "completed", exitCode: 0 });
    expect(openContactSource).toHaveBeenCalledWith({
      target: contact.id,
      path: "/resources/resource:shared",
    }, expect.any(AbortSignal));
    expect(await (await env.STORAGE.get(destinationKey))?.text()).toBe("from contact");
  });

  it("streams gsv files to a device target", async () => {
    const sourceKey = "home/sam/copy-test/device-source.txt";
    await env.STORAGE.delete(sourceKey);
    await env.STORAGE.put(sourceKey, "to device", {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { uid: "1000", gid: "1000", mode: "644" },
    });
    const ctx = makeContext();
    ctx.devices = focusedFixture<KernelContext["devices"]>({
      canAccess: vi.fn(() => true),
      canHandle: vi.fn(() => true),
    });
    let received = "";

    const result = await handleFsCopy({
      source: { target: "gsv", path: "/home/sam/copy-test/device-source.txt" },
      destination: { target: "rearden", path: "/tmp/device-destination.txt" },
    }, ctx, {
      async requestDevice(deviceId, call, args, options) {
        expect(deviceId).toBe("rearden");
        if (call === "fs.transfer.stat") {
          throw new Error("No such file or directory: /tmp/device-destination.txt");
        }
        if (call === "fs.transfer.receive") {
          expect(args).toMatchObject({ path: "/tmp/device-destination.txt" });
          expect(options?.body?.length).toBe("to device".length);
          received = await new Response(options?.body?.stream).text();
          return {
            type: "res",
            id: "receive-1",
            ok: true,
            data: {
              ok: true,
              path: "/tmp/device-destination.txt",
              bytesWritten: received.length,
            },
          };
        }
        throw new Error(`unexpected call ${call}`);
      },
    });

    expect(result).toMatchObject({
      ok: true,
      size: "to device".length,
      destination: { target: "rearden", path: "/tmp/device-destination.txt" },
    });
    expect(received).toBe("to device");
  });

  it("cancels a device copy request", async () => {
    const controller = new AbortController();
    const ctx = makeContext();
    ctx.requestSignal = controller.signal;
    ctx.devices = focusedFixture<KernelContext["devices"]>({
      canAccess: vi.fn(() => true),
      canHandle: vi.fn(() => true),
    });
    let requestSignal: AbortSignal | undefined;
    const request = handleFsCopy({
      source: { target: "gsv", path: "/tmp/source.txt" },
      destination: { target: "rearden", path: "/tmp/destination.txt" },
    }, ctx, {
      async requestDevice(_deviceId, _call, _args, options) {
        requestSignal = options?.signal;
        return await new Promise((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(requestSignal?.reason),
            { once: true },
          );
        });
      },
    });
    await vi.waitFor(() => expect(requestSignal).toBe(controller.signal));
    const reason = new Error("copy cancelled");

    controller.abort(reason);

    await expect(request).resolves.toEqual({ ok: false, error: "copy cancelled" });
  });

  it("returns device receive failures when copying from gsv", async () => {
    const sourceKey = "home/sam/copy-test/device-send-fail.txt";
    await env.STORAGE.delete(sourceKey);
    await env.STORAGE.put(sourceKey, "to failing device", {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { uid: "1000", gid: "1000", mode: "644" },
    });
    const ctx = makeContext();
    ctx.devices = focusedFixture<KernelContext["devices"]>({
      canAccess: vi.fn(() => true),
      canHandle: vi.fn(() => true),
    });
    const result = await handleFsCopy({
      source: { target: "gsv", path: "/home/sam/copy-test/device-send-fail.txt" },
      destination: { target: "rearden", path: "/tmp/device-destination.txt" },
    }, ctx, {
      async requestDevice(deviceId, call) {
        expect(deviceId).toBe("rearden");
        if (call === "fs.transfer.stat") {
          return {
            type: "res",
            id: "stat-1",
            ok: true,
            data: { ok: false, error: "not found" },
          };
        }
        if (call === "fs.transfer.receive") {
          throw new Error("destination disconnected");
        }
        throw new Error(`unexpected call ${call}`);
      },
    });

    expect(result).toMatchObject({ ok: false, error: "destination disconnected" });
  });

  it("streams device files to gsv", async () => {
    const destinationKey = "home/sam/copy-test/from-device.txt";
    await env.STORAGE.delete(destinationKey);
    const ctx = makeContext();
    ctx.devices = focusedFixture<KernelContext["devices"]>({
      canAccess: vi.fn(() => true),
      canHandle: vi.fn(() => true),
    });

    const result = await handleFsCopy({
      source: { target: "rearden", path: "/tmp/source.txt" },
      destination: { target: "gsv", path: "/home/sam/copy-test/from-device.txt" },
    }, ctx, {
      async requestDevice(deviceId, call, args) {
        expect(deviceId).toBe("rearden");
        if (call === "fs.transfer.stat") {
          return {
            type: "res",
            id: "stat-1",
            ok: true,
            data: { ok: true, path: "/tmp/source.txt", size: 11, isFile: true, isDirectory: false, contentType: "text/plain" },
          };
        }
        if (call === "fs.transfer.send") {
          expect(args).toMatchObject({ path: "/tmp/source.txt" });
          return {
            type: "res",
            id: "send-1",
            ok: true,
            data: { ok: true, path: "/tmp/source.txt", size: 11 },
            body: {
              length: 11,
              stream: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("hello world"));
                  controller.close();
                },
              }),
            },
          };
        }
        throw new Error(`unexpected call ${call}`);
      },
    });

    expect(result).toMatchObject({
      ok: true,
      size: 11,
      source: { target: "rearden", path: "/tmp/source.txt" },
    });
    expect(await (await env.STORAGE.get(destinationKey))?.text()).toBe("hello world");
  });

  it("returns device send failures when copying to gsv", async () => {
    const ctx = makeContext();
    ctx.devices = focusedFixture<KernelContext["devices"]>({
      canAccess: vi.fn(() => true),
      canHandle: vi.fn(() => true),
    });
    const result = await handleFsCopy({
      source: { target: "rearden", path: "/tmp/source.txt" },
      destination: { target: "gsv", path: "/home/sam/copy-test/from-device-fail.txt" },
    }, ctx, {
      async requestDevice(deviceId, call) {
        expect(deviceId).toBe("rearden");
        if (call === "fs.transfer.stat") {
          return {
            type: "res",
            id: "stat-1",
            ok: true,
            data: { ok: true, path: "/tmp/source.txt", size: 11, isFile: true, isDirectory: false, contentType: "text/plain" },
          };
        }
        if (call === "fs.transfer.send") {
          throw new Error("source disconnected");
        }
        throw new Error(`unexpected call ${call}`);
      },
    });

    expect(result).toMatchObject({ ok: false, error: "source disconnected" });
  });

  it("streams device files directly to another device", async () => {
    const ctx = makeContext();
    ctx.devices = focusedFixture<KernelContext["devices"]>({
      canAccess: vi.fn(() => true),
      canHandle: vi.fn(() => true),
    });
    let received = "";

    const result = await handleFsCopy({
      source: { target: "rearden", path: "/tmp/source.txt" },
      destination: { target: "browser", path: "/tmp/destination.txt" },
    }, ctx, {
      async requestDevice(deviceId, call, _args, options) {
        if (call === "fs.transfer.stat" && deviceId === "browser") {
          return {
            type: "res",
            id: "destination-stat",
            ok: true,
            data: { ok: false, error: "not found" },
          };
        }
        if (call === "fs.transfer.stat" && deviceId === "rearden") {
          return {
            type: "res",
            id: "source-stat",
            ok: true,
            data: { ok: true, path: "/tmp/source.txt", size: 11, isFile: true, isDirectory: false, contentType: "text/plain" },
          };
        }
        if (call === "fs.transfer.send" && deviceId === "rearden") {
          return {
            type: "res",
            id: "source-send",
            ok: true,
            data: { ok: true, path: "/tmp/source.txt", size: 11 },
            body: {
              length: 11,
              stream: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("hello world"));
                  controller.close();
                },
              }),
            },
          };
        }
        if (call === "fs.transfer.receive" && deviceId === "browser") {
          received = await new Response(options?.body?.stream).text();
          return {
            type: "res",
            id: "destination-receive",
            ok: true,
            data: { ok: true, path: "/tmp/destination.txt", bytesWritten: received.length },
          };
        }
        throw new Error(`unexpected call ${call}`);
      },
    });

    expect(result).toMatchObject({ ok: true, size: 11 });
    expect(received).toBe("hello world");
  });

});

describe("native administration shell commands", () => {
  it("shows codemode command usage", async () => {
    const result = await handleShellExec(
      { input: "codemode --help" },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("codemode <script.js>");
    expect(result.stderr).toBe("");
  });

  it("runs codemode directly with the invoking cwd and MCP bindings", async () => {
    const request = vi.fn(async (
      frame: RequestFrame,
      signal?: AbortSignal,
    ): Promise<ResponseFrame> => {
      expect(signal).toBeInstanceOf(AbortSignal);
      if (frame.call === "sys.mcp.list") {
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: {
            servers: [{
              serverId: "server-1",
              uid: IDENTITY.uid,
              name: "Search",
              url: "https://mcp.example.com/mcp",
              transport: "auto",
              state: "ready",
              authUrl: null,
              error: null,
              instructions: null,
              capabilities: null,
              tools: [{
                name: "lookup-record",
                description: "Look up a record",
                inputSchema: { type: "object" },
                outputSchema: { type: "object" },
              }],
              resourceCount: 0,
              promptCount: 0,
              createdAt: 1,
              updatedAt: 2,
            }],
          },
        };
      }
      if (frame.call === "fs.read") {
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: {
            ok: true,
            kind: "text",
            path: frame.args.path,
            size: 5,
            contentType: "text/plain; charset=utf-8",
          },
          body: bodyFromText("hello"),
        };
      }
      if (frame.call === "sys.mcp.call") {
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: { structuredContent: { title: "GSV" } },
        };
      }
      throw new Error(`unexpected call: ${frame.call}`);
    });
    const ctx = makeContext({ capabilities: ["codemode.run"] });
    ctx.processId = undefined;
    Object.assign(ctx.env, { LOADER: env.LOADER });

    const result = await handleShellExec(
      {
        input: "codemode -e 'const note = await fs.read({ path: \"note.txt\" }); return { note: note.content, match: await lookup_record({ query: \"gsv\" }) };'",
        cwd: "/tmp",
      },
      ctx,
      { request },
    );

    expect(result).toMatchObject({
      status: "completed",
      exitCode: 0,
    });
    expect(result.stdout).toContain('"note": "hello"');
    expect(result.stdout).toContain('"title": "GSV"');
    expect(request.mock.calls.map(([frame]) => ({
      call: frame.call,
      args: frame.args,
    }))).toEqual([
      {
        call: "sys.mcp.list",
        args: {},
      },
      {
        call: "fs.read",
        args: { path: "/tmp/note.txt" },
      },
      {
        call: "sys.mcp.call",
        args: {
          serverId: "server-1",
          name: "lookup-record",
          arguments: { query: "gsv" },
        },
      },
    ]);
    expect(sendFrameToProcessMock).not.toHaveBeenCalled();
  });

  it("derives native CodeMode mail delivery ids from the outer shell request", async () => {
    const mailFrames: RequestFrame[] = [];
    const request = vi.fn(async (frame: RequestFrame): Promise<ResponseFrame> => {
      if (frame.call === "sys.mcp.list") {
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: { servers: [] },
        };
      }
      if (frame.call === "mail.send") {
        mailFrames.push(frame);
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: {
            ok: true,
            deliveryId: frame.args.deliveryId,
          },
        };
      }
      throw new Error(`unexpected call: ${frame.call}`);
    });
    const ctx = makeContext({ capabilities: ["codemode.run"] });
    ctx.requestId = "native-mail-shell-request";
    Object.assign(ctx.env, { LOADER: env.LOADER });
    const input = "codemode -e 'return await mail.send({ to: \"mike@example.com\", text: \"Hello\" })'";

    const first = await handleShellExec({ input }, ctx, { request });
    const replay = await handleShellExec({ input }, ctx, { request });

    const deliveryBase = await stableOpaqueId("mail-send", [
      ctx.installationId,
      ctx.processId!,
      ctx.requestId,
      1,
    ]);
    expect(first).toMatchObject({ status: "completed", exitCode: 0 });
    expect(replay).toMatchObject({ status: "completed", exitCode: 0 });
    expect(mailFrames.map((frame) => frame.args)).toEqual([
      {
        to: "mike@example.com",
        text: "Hello",
        deliveryId: `${deliveryBase}:1`,
      },
      {
        to: "mike@example.com",
        text: "Hello",
        deliveryId: `${deliveryBase}:1`,
      },
    ]);
  });

  it("releases a CodeMode response body when cancellation wins after dispatch", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const body = {
      length: 4,
      stream: new ReadableStream<Uint8Array>({ cancel }),
    };
    const request = vi.fn(async (frame: RequestFrame): Promise<ResponseFrame> => {
      if (frame.call === "sys.mcp.list") {
        return { type: "res", id: frame.id, ok: true, data: { servers: [] } };
      }
      controller.abort(new Error("request cancelled"));
      return {
        type: "res",
        id: frame.id,
        ok: true,
        data: {
          ok: true,
          kind: "text",
          path: "/tmp/note.txt",
          size: 4,
          contentType: "text/plain",
        },
        body,
      };
    });
    const ctx = makeContext({ capabilities: ["codemode.run"] });
    ctx.requestSignal = controller.signal;
    Object.assign(ctx.env, { LOADER: env.LOADER });

    const result = await handleShellExec(
      { input: "codemode -e 'return await fs.read({ path: \"/tmp/note.txt\" })'" },
      ctx,
      { request },
    );

    expect(result).toMatchObject({ status: "failed", error: "request cancelled" });
    expect(cancel).toHaveBeenCalledWith("CodeMode response completed");
  });

  it("shows mcp command usage", async () => {
    const result = await handleShellExec(
      { input: "mcp --help" },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("mcp list");
    expect(result.stdout).toContain("mcp tools [server-id|name]");
    expect(result.stdout).toContain("mcp call <server-id|name> <tool-name|codemode-function>");
    expect(result.stderr).toBe("");
  });

  it("lists MCP servers through the native shell command", async () => {
    const ctx = makeContext({ capabilities: ["sys.mcp.list"] });
    Object.assign(ctx, {
      mcpServers: {
        list: () => [{
          serverId: "server-1",
          uid: IDENTITY.uid,
          name: "Search",
          createdAt: 1,
          updatedAt: 2,
        }],
      },
      mcp: {
        mcpConnections: {
          "server-1": { connectionState: "ready" },
        },
        listServers: () => [{
          id: "server-1",
          name: `u${IDENTITY.uid}:Search`,
          server_url: "https://mcp.example.com/mcp",
          client_id: null,
          auth_url: null,
          callback_url: "",
          server_options: JSON.stringify({ transport: { type: "auto" } }),
        }],
        listTools: () => [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
        listResources: () => [],
        listPrompts: () => [],
      },
    });

    const result = await handleShellExec(
      { input: "mcp list" },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("SERVER_ID\tSTATE\tTOOLS\tRES\tPROMPTS\tAUTH\tNAME\tURL");
    expect(result.stdout).toContain("server-1\tready\t1\t0\t0\t-\tSearch\thttps://mcp.example.com/mcp");
    expect(result.stderr).toBe("");
  });

  it("lists MCP tools with CodeMode function names", async () => {
    const ctx = makeContext({ capabilities: ["sys.mcp.list"] });
    Object.assign(ctx, {
      mcpServers: {
        list: () => [{
          serverId: "server-1",
          uid: IDENTITY.uid,
          name: "Search",
          createdAt: 1,
          updatedAt: 2,
        }],
      },
      mcp: {
        mcpConnections: {
          "server-1": { connectionState: "ready" },
        },
        listServers: () => [{
          id: "server-1",
          name: `u${IDENTITY.uid}:Search`,
          server_url: "https://mcp.example.com/mcp",
          client_id: null,
          auth_url: null,
          callback_url: "",
          server_options: JSON.stringify({ transport: { type: "auto" } }),
        }],
        listTools: () => [{ name: "lookup-record", description: "Lookup records", inputSchema: { type: "object", required: ["query"] } }],
        listResources: () => [],
        listPrompts: () => [],
      },
    });

    const result = await handleShellExec(
      { input: "mcp tools Search" },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("SERVER_ID\tSERVER\tSTATE\tTOOL\tCODEMODE\tREQUIRED\tDESCRIPTION");
    expect(result.stdout).toContain("server-1\tSearch\tready\tlookup-record");
    expect(result.stdout).toContain("lookup_record");
    expect(result.stdout).toContain("Search_lookup_record");
    expect(result.stdout).toContain("query");
    expect(result.stderr).toBe("");
  });

  it("calls MCP tools through the native shell command", async () => {
    const ctx = makeContext({ capabilities: ["sys.mcp.call"] });
    const controller = new AbortController();
    ctx.requestSignal = controller.signal;
    const callMcpTool = vi.fn(async () => ({
      content: [{ type: "text", text: "found" }],
    }));
    const server = {
      serverId: "server-1",
      uid: IDENTITY.uid,
      name: "Search",
      createdAt: 1,
      updatedAt: 2,
    };
    Object.assign(ctx, {
      mcpServers: {
        get: () => server,
        list: () => [server],
      },
      mcp: {
        mcpConnections: {
          "server-1": { connectionState: "ready" },
        },
        listServers: () => [{
          id: "server-1",
          name: `u${IDENTITY.uid}:Search`,
          server_url: "https://mcp.example.com/mcp",
          client_id: null,
          auth_url: null,
          callback_url: "",
          server_options: JSON.stringify({ transport: { type: "auto" } }),
        }],
        listTools: () => [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
        listResources: () => [],
        listPrompts: () => [],
      },
      callMcpTool,
    });

    const result = await handleShellExec(
      { input: "mcp call Search lookup --arg query=gsv" },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(callMcpTool).toHaveBeenCalledWith(
      "server-1",
      "lookup",
      { query: "gsv" },
      controller.signal,
    );
    expect(result.stdout).toBe("found\n");
    expect(result.stderr).toBe("");
  });

  it("shows proc command usage", async () => {
    const result = await handleShellExec(
      { input: "proc --help" },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("proc self");
    expect(result.stdout).toContain("proc reset [--pid PID]");
    expect(result.stdout).toContain("proc kill PID [--no-archive]");
    expect(result.stdout).toContain("proc send <pid>");
    expect(result.stdout).toContain("proc call <pid>");
    expect(result.stderr).toBe("");
  });

  it("exposes the current GSV process id to shell commands", async () => {
    const result = await handleShellExec(
      { input: "printf \"$GSV_PID\\n\" && proc self" },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("task:shell\ntask:shell\n");
    expect(result.stderr).toBe("");
  });

  it("exposes the installation identity and canonical URL to shell commands", async () => {
    const result = await handleShellExec(
      { input: "printf \"$GSV_INSTALLATION_ID\\n$GSV_URL\\n\"" },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe(
      "inst_shell_test\nhttps://shell-test.gsv.space\n",
    );
    expect(result.stderr).toBe("");
  });

  it("shows sched command usage", async () => {
    const result = await handleShellExec(
      { input: "sched --help" },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("sched add --here");
    expect(result.stdout).toContain("sched add --json JSON");
    expect(result.stdout).toContain("Use crontab");
    expect(result.stdout).toContain("--all includes disabled schedules");
    expect(result.stdout).toContain("sched run <id>");
    expect(result.stderr).toBe("");
  });

  it("lists and toggles built-in responsibility sources", async () => {
    let enabled = true;
    const responsibilitySources = {
      list: vi.fn(() => [{
        id: "mail.received",
        name: "Incoming mail",
        description: "Ask the Ship to review each newly received email.",
        control: "configurable",
        defaultEnabled: true,
        enabled,
      }]),
      set: vi.fn((_uid: number, id: string, next: boolean) => {
        enabled = next;
        return {
          id,
          name: "Incoming mail",
          description: "Ask the Ship to review each newly received email.",
          control: "configurable",
          defaultEnabled: true,
          enabled,
        };
      }),
    };
    const ctx = makeContext({
      capabilities: ["r12y.source.list", "r12y.source.update"],
      responsibilitySources,
    });

    const listed = await handleShellExec({ input: "r12y sources" }, ctx);
    const disabled = await handleShellExec({ input: "r12y source disable mail.received" }, ctx);

    expect(listed.stdout).toContain("mail.received\tenabled\tconfigurable\tIncoming mail");
    expect(disabled.stdout).toContain('"enabled":false');
    expect(responsibilitySources.set).toHaveBeenCalledWith(IDENTITY.uid, "mail.received", false);
  });

  it("installs and lists a user crontab", async () => {
    const wake = vi.fn(async () => "wake-1");
    const setWakeScheduleId = vi.fn();
    const cronFiles = new Map<string, {
      path: string;
      ownerUid: number | null;
      content: string;
      createdAtMs: number;
      updatedAtMs: number;
    }>();
    const links = new Map<string, string[]>();
    const schedules = new Map<string, any>();
    const create = vi.fn((input) => ({
      id: `sched-${schedules.size + 1}`,
      ownerUid: input.ownerUid,
      creator: input.creator,
      runAs: input.runAs,
      name: input.name,
      enabled: input.enabled,
      expression: input.expression,
      target: input.target,
      overlapPolicy: "skip",
      createdAtMs: input.now,
      updatedAtMs: input.now,
      state: {
        nextRunAtMs: input.now + 60_000,
        runningAtMs: null,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        lastDurationMs: null,
        runCount: 0,
      },
    }));
    create.mockImplementation((input) => {
      const record = {
        id: `sched-${schedules.size + 1}`,
        ownerUid: input.ownerUid,
        creator: input.creator,
        runAs: input.runAs,
        name: input.name,
        description: input.description,
        enabled: input.enabled,
        expression: input.expression,
        target: input.target,
        overlapPolicy: "skip",
        createdAtMs: input.now,
        updatedAtMs: input.now,
        state: {
          nextRunAtMs: input.now + 60_000,
          runningAtMs: null,
          lastRunAtMs: null,
          lastStatus: null,
          lastError: null,
          lastDurationMs: null,
          runCount: 0,
        },
      };
      schedules.set(record.id, { ...record, wakeScheduleId: null });
      return record;
    });
    const auth = {
      getPasswdByUsername: vi.fn((username: string) => username === "sam"
        ? { username: "sam", uid: IDENTITY.uid, gid: IDENTITY.gid, gecos: "", home: IDENTITY.home, shell: "/bin/init" }
        : null),
      getPasswdByUid: vi.fn((uid: number) => uid === IDENTITY.uid
        ? { username: "sam", uid: IDENTITY.uid, gid: IDENTITY.gid, gecos: "", home: IDENTITY.home, shell: "/bin/init" }
        : null),
      resolveGids: vi.fn(() => IDENTITY.gids),
    };
    const ctx = makeContext({
      capabilities: ["sched.add", "sched.remove", "sched.list"],
      auth,
      caps: {
        resolve: vi.fn(() => ["shell.*"]),
      },
      schedules: {
        create,
        setWakeScheduleId,
        getStored: vi.fn((id: string) => schedules.get(id) ?? null),
        remove: vi.fn((id: string) => {
          const existing = schedules.get(id) ?? null;
          schedules.delete(id);
          return existing;
        }),
        getCronFile: vi.fn((path: string) => cronFiles.get(path) ?? null),
        listCronFiles: vi.fn(() => [...cronFiles.values()]),
        upsertCronFile: vi.fn((input) => {
          const record = {
            path: input.path,
            ownerUid: input.ownerUid,
            content: input.content,
            createdAtMs: input.now,
            updatedAtMs: input.now,
          };
          cronFiles.set(input.path, record);
          return record;
        }),
        removeCronFile: vi.fn((path: string) => {
          const existing = cronFiles.get(path) ?? null;
          cronFiles.delete(path);
          return existing;
        }),
        cronFileScheduleIds: vi.fn((path: string) => links.get(path) ?? []),
        clearCronFileScheduleLinks: vi.fn((path: string) => links.delete(path)),
        linkCronFileSchedule: vi.fn((path: string, scheduleId: string) => {
          links.set(path, [...(links.get(path) ?? []), scheduleId]);
        }),
      },
      scheduleScheduleWake: wake,
    });
    await env.STORAGE.put(
      "home/sam/jobs.cron",
      "CRON_TZ=Europe/Amsterdam\n0 9 * * * proc spawn --as sam-agent --non-interactive --label daily-brief \"Daily brief\"\n",
    );

    const result = await handleShellExec(
      { input: "crontab jobs.cron" },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.stderr).toBe("");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      ownerUid: IDENTITY.uid,
      name: "cron /var/spool/cron/sam:2",
      expression: { kind: "cron", expr: "0 9 * * *", timezone: "Europe/Amsterdam" },
      target: {
        kind: "command.exec",
        command: "proc spawn --as sam-agent --non-interactive --label daily-brief \"Daily brief\"",
      },
    }));
    expect(wake).toHaveBeenCalledWith("sched-1", expect.any(Number));
    expect(setWakeScheduleId).toHaveBeenCalledWith("sched-1", "wake-1");

    const listed = await handleShellExec(
      { input: "crontab -l" },
      ctx,
    );
    expect(listed.ok).toBe(true);
    expect(listed.stdout).toBe("CRON_TZ=Europe/Amsterdam\n0 9 * * * proc spawn --as sam-agent --non-interactive --label daily-brief \"Daily brief\"\n");
  });

  it("lists agent-installed user crontabs through the owning user's sched view", async () => {
    const agent: ProcessIdentity = {
      uid: 2000,
      gid: 2000,
      gids: [2000],
      username: "sam-agent",
      home: "/home/sam-agent",
      cwd: "/home/sam-agent",
    };
    const wake = vi.fn(async () => "wake-1");
    const cronFiles = new Map<string, {
      path: string;
      ownerUid: number | null;
      content: string;
      createdAtMs: number;
      updatedAtMs: number;
    }>();
    const links = new Map<string, string[]>();
    const schedules = new Map<string, any>();
    const create = vi.fn((input) => {
      const record = {
        id: `sched-${schedules.size + 1}`,
        ownerUid: input.ownerUid,
        creator: input.creator,
        runAs: input.runAs,
        name: input.name,
        description: input.description,
        enabled: input.enabled,
        expression: input.expression,
        target: input.target,
        overlapPolicy: "skip",
        createdAtMs: input.now,
        updatedAtMs: input.now,
        state: {
          nextRunAtMs: input.now + 60_000,
          runningAtMs: null,
          lastRunAtMs: null,
          lastStatus: null,
          lastError: null,
          lastDurationMs: null,
          runCount: 0,
        },
      };
      schedules.set(record.id, { ...record, wakeScheduleId: null });
      return record;
    });
    const auth = {
      getPasswdByUsername: vi.fn((username: string) => {
        if (username === IDENTITY.username) {
          return {
            username: IDENTITY.username,
            uid: IDENTITY.uid,
            gid: IDENTITY.gid,
            gecos: "",
            home: IDENTITY.home,
            shell: "/bin/init",
          };
        }
        if (username === agent.username) {
          return {
            username: agent.username,
            uid: agent.uid,
            gid: agent.gid,
            gecos: "",
            home: agent.home,
            shell: "/bin/init",
          };
        }
        return null;
      }),
      getPasswdByUid: vi.fn((uid: number) => {
        if (uid === IDENTITY.uid) {
          return {
            username: IDENTITY.username,
            uid: IDENTITY.uid,
            gid: IDENTITY.gid,
            gecos: "",
            home: IDENTITY.home,
            shell: "/bin/init",
          };
        }
        if (uid === agent.uid) {
          return {
            username: agent.username,
            uid: agent.uid,
            gid: agent.gid,
            gecos: "",
            home: agent.home,
            shell: "/bin/init",
          };
        }
        return null;
      }),
      resolveGids: vi.fn((username: string) => username === agent.username ? agent.gids : IDENTITY.gids),
    };
    const ctx = makeContext({
      identity: agent,
      capabilities: ["sched.add", "sched.remove", "sched.list"],
      auth,
      caps: {
        resolve: vi.fn(() => ["shell.exec"]),
      },
      procs: {
        getOwnerUid: vi.fn(() => IDENTITY.uid),
      },
      schedules: {
        create,
        setWakeScheduleId: vi.fn(),
        getStored: vi.fn((id: string) => schedules.get(id) ?? null),
        remove: vi.fn((id: string) => {
          const existing = schedules.get(id) ?? null;
          schedules.delete(id);
          return existing;
        }),
        list: vi.fn((args) => {
          const records = [...schedules.values()]
            .filter((schedule) => args.ownerUid === undefined || schedule.ownerUid === args.ownerUid)
            .filter((schedule) => args.includeDisabled || schedule.enabled)
            .map(({ wakeScheduleId: _wakeScheduleId, ...record }) => record);
          return { records, count: records.length };
        }),
        getCronFile: vi.fn((path: string) => cronFiles.get(path) ?? null),
        listCronFiles: vi.fn(() => [...cronFiles.values()]),
        upsertCronFile: vi.fn((input) => {
          const record = {
            path: input.path,
            ownerUid: input.ownerUid,
            content: input.content,
            createdAtMs: input.now,
            updatedAtMs: input.now,
          };
          cronFiles.set(input.path, record);
          return record;
        }),
        removeCronFile: vi.fn((path: string) => {
          const existing = cronFiles.get(path) ?? null;
          cronFiles.delete(path);
          return existing;
        }),
        cronFileScheduleIds: vi.fn((path: string) => links.get(path) ?? []),
        clearCronFileScheduleLinks: vi.fn((path: string) => links.delete(path)),
        linkCronFileSchedule: vi.fn((path: string, scheduleId: string) => {
          links.set(path, [...(links.get(path) ?? []), scheduleId]);
        }),
      },
      scheduleScheduleWake: wake,
    });
    await env.STORAGE.put(
      "home/sam-agent/jobs.cron",
      "*/5 * * * * printf 'agent cron fired\\n'\n",
    );

    const result = await handleShellExec(
      { input: "crontab jobs.cron && sched list --all" },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.stderr).toBe("");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      ownerUid: IDENTITY.uid,
      runAs: expect.objectContaining({
        uid: agent.uid,
        username: agent.username,
      }),
      name: "cron /var/spool/cron/sam-agent:1",
    }));
    expect(result.stdout).toContain("sched-1\tyes\t");
    expect(result.stdout).toContain("crontab:/var/spool/cron/sam-agent:1");
    expect(result.stdout).toContain("cron /var/spool/cron/sam-agent:1");
    expect(result.stdout).toContain("cmd:printf 'agent cron fired\\n'");
  });

  it("keeps sched add as a low-level JSON compatibility path", async () => {
    const wake = vi.fn(async () => "wake-1");
    const setWakeScheduleId = vi.fn();
    const create = vi.fn((input) => ({
      id: "sched-2",
      ownerUid: input.ownerUid,
      creator: input.creator,
      runAs: input.runAs,
      name: input.name,
      enabled: input.enabled,
      expression: input.expression,
      target: input.target,
      overlapPolicy: "skip",
      createdAtMs: input.now,
      updatedAtMs: input.now,
      state: {
        nextRunAtMs: input.now + input.expression.everyMs,
        runningAtMs: null,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        lastDurationMs: null,
        runCount: 0,
      },
    }));
    const args = {
      name: "ops pulse",
      expression: { kind: "every", everyMs: 900_000 },
      target: {
        kind: "process.event",
        pid: "init:1000",
        message: "Run pulse.",
      },
    };

    const result = await handleShellExec(
      { input: `sched add --json '${JSON.stringify(args)}'` },
      makeContext({
        capabilities: ["sched.add", "proc.send"],
        procs: {
          get: vi.fn(() => ({
            uid: IDENTITY.uid,
            ownerUid: IDENTITY.uid,
          })),
        },
        schedules: {
          create,
          setWakeScheduleId,
        },
        scheduleScheduleWake: wake,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("schedule_id=sched-2");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: "ops pulse",
      expression: { kind: "every", everyMs: 900_000 },
      target: {
        kind: "process.event",
        pid: "init:1000",
        message: "Run pulse.",
      },
    }));
    expect(setWakeScheduleId).toHaveBeenCalledWith("sched-2", "wake-1");
  });

  it("distinguishes the directed endpoint from intentional separate messages", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "adapter.send"],
      processRunId: "run-telegram",
    });
    const { adapterFrame } = enableTelegramMessaging(ctx);

    const current = await handleShellExec({ input: "message current" }, ctx);
    const currentJson = await handleShellExec({ input: "message current --json" }, ctx);
    const terminalFallback = await handleShellExec({
      input: 'message send --message "terminal reply"',
    }, ctx);
    const yieldFallback = await handleShellExec({
      input: "yield",
    }, ctx);
    const duplicate = await handleShellExec({
      input: 'message send --to here --message "duplicate reply"',
    }, ctx);
    const intentional = await handleShellExec({
      input: 'message send --to here --message "extra update" --also',
    }, ctx);

    expect(current).toMatchObject({ status: "completed", exitCode: 0 });
    expect(current.stdout).toContain("directed endpoint: Telegram direct message");
    expect(current.stdout).toContain("cross-channel delivery");
    const currentOutput = currentDestinationOutputSchema.safeParse(
      JSON.parse(currentJson.stdout),
    );
    expect(currentOutput.success).toBe(true);
    if (!currentOutput.success) throw new Error("invalid message current output");
    const { destinationId } = currentOutput.data;
    expect(destinationId).toMatch(/^message-destination:[0-9a-f]{64}$/);
    expect(current.stdout).toContain(`destination: ${destinationId}`);
    expect(current.stdout).not.toContain("chat-42");
    expect(currentJson.stdout).not.toContain("chat-42");
    expect(duplicate.status).toBe("failed");
    expect(duplicate.stderr).toContain("current-conversation form");
    expect(duplicate.stderr).toContain("--also");
    expect(terminalFallback).toMatchObject({ status: "failed", exitCode: 1 });
    expect(terminalFallback.stderr).toContain("direct Shell tool call");
    expect(yieldFallback).toMatchObject({ status: "failed", exitCode: 1 });
    expect(yieldFallback.stderr).toContain("direct Shell tool call");
    expect(intentional).toMatchObject({ status: "completed", exitCode: 0 });
    expect(intentional.stdout).toContain("sent=true");
    expect(intentional.stdout).toMatch(/destination=message-destination:[0-9a-f]{64}/);
    expect(intentional.stdout).not.toContain("chat-42");
    expect(intentional.stdout).not.toContain("account=bot");
    expect(intentional.stdout).not.toContain("message_id=msg-1");
    expect(adapterFrame).toHaveBeenCalledTimes(1);
    expect(adapterFrame).toHaveBeenCalledWith(
      TEST_INSTALLATION_CONTEXT,
      expect.objectContaining({
        accountId: "bot",
        surface: { kind: "dm", id: "chat-42" },
      }),
      expect.objectContaining({
        type: "req",
        call: "adapter.send",
        args: expect.objectContaining({ text: "extra update" }),
      }),
    );
  });

  it("lists and resolves opaque destinations without provider identifiers", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "adapter.send"],
      processRunId: "run-telegram-destinations",
    });
    const { adapterFrame } = enableTelegramMessaging(ctx);

    const listed = await handleShellExec({ input: "message destinations --json" }, ctx);
    expect(listed).toMatchObject({ status: "completed", exitCode: 0 });
    const listedOutput = destinationListOutputSchema.safeParse(JSON.parse(listed.stdout));
    expect(listedOutput.success).toBe(true);
    if (!listedOutput.success || !listedOutput.data.destinations[0]) {
      throw new Error("invalid message destinations output");
    }
    const destinationId = listedOutput.data.destinations[0].id;
    expect(destinationId).toMatch(/^message-destination:[0-9a-f]{64}$/);
    expect(listed.stdout).toContain("Telegram direct message");
    expect(listed.stdout).not.toContain("chat-42");
    expect(listed.stdout).not.toContain('"bot"');
    const removedAlias = await handleShellExec({ input: "message targets" }, ctx);
    expect(removedAlias).toMatchObject({ status: "failed", exitCode: 1 });
    expect(removedAlias.stderr).toContain("unknown command: targets");

    const sent = await handleShellExec({
      input: `message send --to ${destinationId} --message "opaque route" --also`,
    }, ctx);
    expect(sent).toMatchObject({ status: "completed", exitCode: 0 });
    expect(sent.stdout).toContain(`destination=${destinationId}`);
    expect(sent.stdout).not.toContain("chat-42");
    expect(sent.stdout).not.toContain("msg-1");
    expect(adapterFrame).toHaveBeenCalledWith(
      TEST_INSTALLATION_CONTEXT,
      expect.objectContaining({ accountId: "bot" }),
      expect.objectContaining({
        type: "req",
        call: "adapter.send",
        args: expect.objectContaining({ text: "opaque route" }),
      }),
    );
  });

  it("preserves an observed thread when sending to a listed destination", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "adapter.send"],
      processRunId: "run-slack-thread",
    });
    const link = {
      adapter: "slack",
      accountId: "managed",
      actorId: "U123",
      uid: IDENTITY.uid,
      createdAt: 1,
      linkedByUid: IDENTITY.uid,
      metadata: {
        managed: true,
        routeScope: "actor",
        routeGeneration: "generation-1",
      },
    };
    const route: SurfaceRouteRecord = {
      adapter: "slack",
      accountId: "managed",
      actorId: "U123",
      surfaceKind: "channel",
      surfaceId: "C123",
      threadId: "1700000000.000100",
      uid: IDENTITY.uid,
      pid: "proc:slack-thread",
      mode: "surface",
      updatedAt: 2,
      updatedByUid: IDENTITY.uid,
    };
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
          ok: true,
          adapter: "slack",
          accountId: context.accountId,
          surfaceId: context.surface.id,
          deliveryId: context.deliveryId,
          messageId: "1700000001.000100",
          deliveryState: "sent",
        },
      };
    });
    Object.assign(ctx.env, {
      CHANNEL_SLACK: { adapterFrame },
    });
    ctx.adapters = focusedFixture<KernelContext["adapters"]>({
      identityLinks: {
        list: vi.fn(() => [link]),
        get: vi.fn(() => link),
      },
      surfaceRoutes: {
        list: vi.fn(() => [route]),
        get: vi.fn((key) => (
          key.adapter === route.adapter
            && key.accountId === route.accountId
            && key.actorId === route.actorId
            && key.surfaceKind === route.surfaceKind
            && key.surfaceId === route.surfaceId
            && key.threadId === route.threadId
            ? route
            : null
        )),
      },
      status: {
        get: vi.fn(() => ({ connected: true, authenticated: true })),
      },
    });

    const listed = await handleShellExec({ input: "message destinations --json" }, ctx);
    expect(listed).toMatchObject({ status: "completed", exitCode: 0 });
    const output = destinationListOutputSchema.safeParse(JSON.parse(listed.stdout));
    expect(output.success).toBe(true);
    if (!output.success || !output.data.destinations[0]) {
      throw new Error("invalid threaded message destination output");
    }

    const sent = await handleShellExec({
      input: `message send --to ${output.data.destinations[0].id} --message "delegated result" --also`,
    }, ctx);

    expect(sent).toMatchObject({ status: "completed", exitCode: 0 });
    expect(adapterFrame).toHaveBeenCalledWith(
      TEST_INSTALLATION_CONTEXT,
      expect.objectContaining({
        accountId: "managed",
        actorId: "U123",
        surface: {
          kind: "channel",
          id: "C123",
          threadId: "1700000000.000100",
        },
        routeGeneration: "generation-1",
      }),
      expect.objectContaining({
        type: "req",
        call: "adapter.send",
        args: expect.objectContaining({ text: "delegated result" }),
      }),
    );
  });

  it("lists trusted GSV contacts as first-class message destinations", async () => {
    const contact = { ...makeContact(), localAlias: "Alice" };
    const list = vi.fn(() => [contact]);
    const ctx = makeContext({
      capabilities: ["shell.exec", "contact.list"],
      federation: { list },
    });

    const destinations = await handleShellExec({ input: "message destinations --json" }, ctx);
    const contacts = await handleShellExec({ input: "contact list" }, ctx);
    const help = await handleShellExec({ input: "contact help" }, ctx);

    expect(destinations).toMatchObject({ status: "completed", exitCode: 0 });
    expect(JSON.parse(destinations.stdout)).toMatchObject({
      destinations: [{
        id: contact.id,
        kind: "contact",
        label: "Alice",
        state: "active",
      }],
    });
    expect(contacts).toMatchObject({ status: "completed", exitCode: 0 });
    expect(contacts.stdout).toContain("contact:friend\tactive\tAlice\tship:friend");
    expect(help).toMatchObject({ status: "completed", exitCode: 0 });
    expect(help.stdout).toContain("contact invite create");
    expect(list).toHaveBeenCalledWith(IDENTITY.uid, false);
  });

  it("lets the canonical Ship set a local Contact alias", async () => {
    const contact = makeContact();
    const setAlias = vi.fn((_contactId: string, _ownerUid: number, alias: string | null) => {
      const updated: FederationContactRecord = { ...contact };
      if (alias !== null) updated.localAlias = alias;
      return updated;
    });
    const setTitle = vi.fn();
    const ctx = makeContext({
      capabilities: ["shell.exec", "contact.alias.set"],
      procs: {
        get: vi.fn(() => makeProcess({
          processId: "proc:ship",
          isPersonalController: true,
        })),
      },
      auth: {
        isPersonalAgentUid: vi.fn(() => false),
        getShadowByUsername: vi.fn(() => ({ username: IDENTITY.username, hash: "unlocked" })),
      },
      federation: { get: vi.fn(() => contact), setAlias },
      conversations: { setTitle },
      processId: "proc:ship",
    });

    const result = await handleShellExec({
      input: `contact alias ${contact.id} Alice Cooper`,
    }, ctx);

    expect(result).toMatchObject({ status: "completed", exitCode: 0 });
    expect(JSON.parse(result.stdout).contact.localAlias).toBe("Alice Cooper");
    expect(setAlias).toHaveBeenCalledWith(contact.id, IDENTITY.uid, "Alice Cooper");
    expect(setTitle).toHaveBeenCalledWith(contact.conversationId, "Alice Cooper");
  });

  it("lets only the canonical Ship perform human contact pairing", async () => {
    const result = await handleShellExec(
      { input: "contact invite cancel invite:one" },
      makeContext({ capabilities: ["shell.exec", "contact.invite.cancel"] }),
    );

    expect(result).toMatchObject({ status: "failed", exitCode: 1 });
    expect(result.stderr).toContain("requires a signed-in human or their Ship");

    const cancelledAtMs = Date.now();
    const cancelInvite = vi.fn(() => ({
      inviteId: "invite:one",
      ownerUid: IDENTITY.uid,
      tokenHash: "secret-hash",
      issuingShipId: "ship:local",
      issuingOrigin: "https://local.example",
      state: "cancelled" as const,
      expiresAtMs: cancelledAtMs + 60_000,
      cancelledAtMs,
      createdAtMs: cancelledAtMs - 1_000,
    }));
    const ship = makeContext({
      capabilities: ["shell.exec", "contact.invite.cancel"],
      procs: {
        get: vi.fn(() => makeProcess({
          processId: "proc:ship",
          isPersonalController: true,
        })),
      },
      auth: {
        isPersonalAgentUid: vi.fn(() => false),
        getShadowByUsername: vi.fn(() => ({ username: IDENTITY.username, hash: "unlocked" })),
      },
      federation: { cancelInvite },
      processId: "proc:ship",
    });
    const shipResult = await handleShellExec(
      { input: "contact invite cancel invite:one" },
      ship,
    );
    expect(shipResult).toMatchObject({ status: "completed", exitCode: 0 });
    expect(JSON.parse(shipResult.stdout)).toMatchObject({
      invite: { inviteId: "invite:one", state: "cancelled" },
    });
    expect(cancelInvite).toHaveBeenCalledWith("invite:one", IDENTITY.uid, expect.any(Number));
  });

  it("reads Contact history from the canonical Ship", async () => {
    const contact = makeContact();
    const conversation = {
      id: contact.conversationId,
      ownerUid: IDENTITY.uid,
      kind: "contact" as const,
      title: "Flynn",
      handlerPid: "proc:ship",
      latestSequence: 1,
      createdAt: 1,
      updatedAt: 2,
    };
    getConversationByIdMock.mockReturnValue({
      history: vi.fn(async () => ({
        messages: [{
          id: "msg:one",
          conversationId: conversation.id,
          sequence: 1,
          author: {
            kind: "contact",
            contactId: contact.id,
            shipId: contact.remoteShipId,
            subjectId: contact.remoteSubject.id,
            displayName: contact.remoteSubject.displayName,
          },
          text: "hello from Flynn",
          origin: { kind: "federation", contactId: contact.id, deliveryId: "delivery:one" },
          createdAt: 1,
        }],
        hasMore: false,
        latestSequence: 1,
      })),
    });
    const ctx = makeContext({
      capabilities: ["shell.exec", "contact.list", "conversation.history"],
      federation: { list: vi.fn(() => [contact]) },
      procs: {
        get: vi.fn(() => makeProcess({
          processId: "proc:ship",
          isPersonalController: true,
        })),
      },
      processId: "proc:ship",
    });
    ctx.conversations = focusedFixture<KernelContext["conversations"]>({
      get: vi.fn(() => conversation),
      recordSequence: vi.fn(),
    });

    const history = await handleShellExec({
      input: `message history --with ${contact.id}`,
    }, ctx);
    expect(history).toMatchObject({ status: "completed", exitCode: 0 });
    expect(history.stdout).toContain(`conversation=${conversation.id}`);
    expect(history.stdout).toContain("Flynn (contact:friend)");
    expect(history.stdout).toContain("hello from Flynn");
  });

  it("reports Contact delivery acceptance and later state separately", async () => {
    const contact = makeContact();
    const outbox = vi.fn(() => ({
      deliveryId: "delivery:one",
      ownerUid: IDENTITY.uid,
      contactId: contact.id,
      contactGeneration: contact.generation,
      idempotencyKey: "logical:one",
      fingerprint: "fingerprint",
      payload: {
        kind: "message" as const,
        messageId: "msg:one",
        threadId: contact.threadId,
        text: "hello",
      },
      state: "pending" as const,
      attemptCount: 1,
      createdAtMs: 1,
      updatedAtMs: 2,
    }));
    const ctx = makeContext({
      capabilities: ["shell.exec", "contact.delivery.get"],
      federation: {
        outbox,
        get: vi.fn(() => contact),
      },
    });

    const status = await handleShellExec({
      input: "message delivery show delivery:one",
    }, ctx);
    expect(status).toMatchObject({ status: "completed", exitCode: 0 });
    expect(status.stdout).toContain("accepted=true");
    expect(status.stdout).toContain("delivery_confirmed=false");
    expect(status.stdout).toContain("delivery_state=queued");
  });

  it("shows and changes the process route for an adapter group", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "adapter.route"],
      processRunId: "run-telegram-route",
    });
    const { link } = enableTelegramMessaging(ctx);
    link.metadata = { surfaceKind: "group", surfaceId: "group-42" };
    ctx.runRoutes = focusedFixture<KernelContext["runRoutes"]>({
      get: vi.fn(() => ({
        kind: "adapter",
        runId: ctx.processRunId!,
        processId: ctx.processId!,
        uid: IDENTITY.uid,
        destination: {
          kind: "adapter",
          adapter: "telegram",
          accountId: "bot",
          actorId: "chat-42",
          surface: { kind: "group", id: "group-42" },
        },
      })),
    });
    const target = makeProcess({
      processId: "proc:groceries",
      label: "groceries",
      username: "helper",
      uid: 1001,
    });
    const { setRoute, clearRoute } = enableMessageRouteStore(ctx, [target]);

    const set = await handleShellExec({
      input: "message route set --process groceries",
    }, ctx);
    expect(set).toMatchObject({ status: "completed", exitCode: 0 });
    expect(set.stdout).toContain("routed=true");
    expect(set.stdout).toContain("process=proc:groceries");
    expect(set.stdout).not.toContain("chat-42");
    expect(set.stdout).not.toContain("account=bot");
    expect(setRoute).toHaveBeenCalledWith(expect.objectContaining({
      adapter: "telegram",
      accountId: "bot",
      actorId: "chat-42",
      surfaceKind: "group",
      surfaceId: "group-42",
      uid: IDENTITY.uid,
      pid: "proc:groceries",
      mode: "surface",
      updatedByUid: IDENTITY.uid,
    }));

    const shown = await handleShellExec({ input: "message route show --json" }, ctx);
    expect(shown).toMatchObject({ status: "completed", exitCode: 0 });
    expect(JSON.parse(shown.stdout)).toMatchObject({
      routes: [{
        chat: "Telegram group",
        process: "proc:groceries",
        processState: "idle",
        processLabel: "groceries",
      }],
    });
    expect(shown.stdout).not.toContain("chat-42");
    expect(shown.stdout).not.toContain('"bot"');

    const listed = await handleShellExec({ input: "message route list" }, ctx);
    expect(listed).toMatchObject({ status: "completed", exitCode: 0 });
    expect(listed.stdout).toContain("proc:groceries");
    expect(listed.stdout).toContain("Telegram group");
    expect(listed.stdout).not.toContain("chat-42");

    const cleared = await handleShellExec({ input: "message route clear" }, ctx);
    expect(cleared).toMatchObject({ status: "completed", exitCode: 0 });
    expect(cleared.stdout).toContain("cleared=true");
    expect(clearRoute).toHaveBeenCalledTimes(1);
  });

  it("lets the exact personal DM run open an owned work direct line", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "adapter.route"],
      processRunId: "run-personal-handoff",
    });
    enableTelegramMessaging(ctx);
    const { target, setRoute } = enablePrivateDmHandoff(ctx);

    const first = await handleShellExec({
      input: "message route set --process groceries",
    }, ctx);
    const replay = await handleShellExec({
      input: "message route set --process groceries",
    }, ctx);

    expect(first).toMatchObject({ status: "completed", exitCode: 0 });
    expect(replay).toMatchObject({ status: "completed", exitCode: 0 });
    expect(first.stdout).toContain(`process=${target.processId}`);
    expect(setRoute).toHaveBeenCalledTimes(1);
    expect(setRoute).toHaveBeenCalledWith(expect.objectContaining({
      adapter: "telegram",
      accountId: "bot",
      actorId: "chat-42",
      surfaceKind: "dm",
      surfaceId: "chat-42",
      uid: IDENTITY.uid,
      pid: target.processId,
      mode: "work",
      updatedByUid: IDENTITY.uid,
    }));
  });

  it("fences a personal DM handoff after newer private activity", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "adapter.route"],
      processRunId: "run-stale-personal-handoff",
    });
    enableTelegramMessaging(ctx);
    const { setRoute } = enablePrivateDmHandoff(ctx, "newer-message");

    const result = await handleShellExec({
      input: "message route set --process groceries",
    }, ctx);

    expect(result).toMatchObject({ status: "failed", exitCode: 1 });
    expect(result.stderr).toContain("conversation changed before the direct line");
    expect(setRoute).not.toHaveBeenCalled();
  });

  it("rejects a handoff from a superseded personal run", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "adapter.route"],
      processRunId: "run-superseded-personal-handoff",
    });
    enableTelegramMessaging(ctx);
    const { controller, setRoute } = enablePrivateDmHandoff(ctx);
    controller.activeRunId = "run-newer-personal-activity";

    const result = await handleShellExec({
      input: "message route set --process groceries",
    }, ctx);

    expect(result).toMatchObject({ status: "failed", exitCode: 1 });
    expect(result.stderr).toContain("Only the personal intelligence");
    expect(setRoute).not.toHaveBeenCalled();
  });

  it("fences a delayed handoff after a later /ship with an older provider timestamp", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "adapter.route"],
      processRunId: "run-delayed-before-home",
    });
    enableTelegramMessaging(ctx);
    const { setRoute } = enablePrivateDmHandoff(ctx, "msg-1");
    ctx.adapters.ingressReceipts.isLatestPrivateMessage = vi.fn(() => false);

    const result = await handleShellExec({
      input: "message route set --process groceries",
    }, ctx);

    expect(result).toMatchObject({ status: "failed", exitCode: 1 });
    expect(result.stderr).toContain("conversation changed before the direct line");
    expect(ctx.adapters.privateDestinations.get(IDENTITY.uid)).toMatchObject({
      messageId: "msg-1",
      updatedAt: 1,
    });
    expect(ctx.adapters.ingressReceipts.isLatestPrivateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ surface: { kind: "dm", id: "chat-42" } }),
      "msg-1",
    );
    expect(setRoute).not.toHaveBeenCalled();
  });

  it("fences a personal DM handoff after its selection changed", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "adapter.route"],
      processRunId: "run-reselected-personal-handoff",
    });
    enableTelegramMessaging(ctx);
    const { setRoute } = enablePrivateDmHandoff(ctx);
    const other = makeProcess({ processId: "proc:newer-work", label: "newer" });
    ctx.procs.get = vi.fn((pid: string) => (
      pid === other.processId ? other : pid === "proc:groceries"
        ? makeProcess({ processId: "proc:groceries", label: "groceries" })
        : pid === ctx.processId
          ? makeProcess({ processId: ctx.processId!, isPersonalController: true })
          : null
    ));
    ctx.adapters.surfaceRoutes.setRoute({
      adapter: "telegram",
      accountId: "bot",
      actorId: "chat-42",
      surfaceKind: "dm",
      surfaceId: "chat-42",
      uid: IDENTITY.uid,
      pid: other.processId,
      mode: "work",
      updatedByUid: IDENTITY.uid,
    });
    setRoute.mockClear();

    const result = await handleShellExec({
      input: "message route set --process groceries",
    }, ctx);

    expect(result).toMatchObject({ status: "failed", exitCode: 1 });
    expect(result.stderr).toContain("selection changed before the direct line");
    expect(setRoute).not.toHaveBeenCalled();
  });

  it("rejects private DM route changes from a top-level user shell", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "adapter.route"],
    });
    delete ctx.processId;
    enableTelegramMessaging(ctx);
    const target = makeProcess({
      processId: "proc:groceries",
      label: "groceries",
    });
    const { setRoute, clearRoute } = enableMessageRouteStore(ctx, [target]);

    const set = await handleShellExec({
      input: "message route set --process groceries --to telegram",
    }, ctx);
    expect(set).toMatchObject({ status: "failed", exitCode: 1 });
    expect(set.stderr).toContain("Only the personal intelligence can open a private DM direct line");

    const cleared = await handleShellExec({
      input: "message route clear --to telegram",
    }, ctx);
    expect(cleared).toMatchObject({ status: "failed", exitCode: 1 });
    expect(cleared.stderr).toContain("Use /ship in the private DM");
    expect(setRoute).not.toHaveBeenCalled();
    expect(clearRoute).not.toHaveBeenCalled();
  });

  it("explains the personal-intelligence DM handoff boundary", async () => {
    const result = await handleShellExec(
      { input: "message route --help" },
      makeContext({ capabilities: ["shell.exec", "adapter.route"] }),
    );

    expect(result).toMatchObject({ status: "completed", exitCode: 0 });
    expect(result.stdout).toContain("intelligence can use `set`");
    expect(result.stdout).toContain("Use /ship inside the DM to return");
  });

  it("only routes chats to owned interactive processes", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "adapter.route"],
      processRunId: "run-telegram-route-denied",
    });
    enableTelegramMessaging(ctx);
    enableMessageRouteStore(ctx, [makeProcess({
      processId: "proc:background",
      label: "background",
      interactive: false,
    })]);

    const result = await handleShellExec({
      input: "message route set --process background",
    }, ctx);
    expect(result).toMatchObject({ status: "failed", exitCode: 1 });
    expect(result.stderr).toContain("No owned interactive process matches");

    enableMessageRouteStore(ctx, [makeProcess({
      processId: "proc:foreign",
      label: "foreign",
      ownerUid: 2000,
    })]);
    const foreign = await handleShellExec({
      input: "message route set --process foreign",
    }, ctx);
    expect(foreign).toMatchObject({ status: "failed", exitCode: 1 });
    expect(foreign.stderr).toContain("Process not found");
  });

  it("bridges a GSV file into an explicit adapter message body", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "adapter.send", "fs.write"],
      processRunId: "run-telegram-file",
    });
    const { adapterFrame } = enableTelegramMessaging(ctx);
    await handleFsWrite({ path: "/tmp/share.png", content: "PNG" }, ctx);

    const result = await handleShellExec({
      input: "message send --to here --attach /tmp/share.png --also",
    }, ctx);

    expect(result).toMatchObject({ status: "completed", exitCode: 0 });
    expect(result.stdout).toContain("sent=true");
    expect(result.stdout).not.toContain("bytes-3");
    expect(adapterFrame).toHaveBeenCalledWith(
      TEST_INSTALLATION_CONTEXT,
      expect.objectContaining({
        accountId: "bot",
      }),
      expect.objectContaining({
        type: "req",
        call: "adapter.send",
        args: expect.objectContaining({
          text: "",
          media: [{
            type: "image",
            mimeType: "image/png",
            filename: "share.png",
            size: 3,
            body: { offset: 0, length: 3 },
          }],
        }),
        body: expect.objectContaining({ length: 3 }),
      }),
    );
  });

  it("retries an explicit message with the same delivery id", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "adapter.send"],
      processRunId: "run-telegram-retry",
    });
    enableTelegramMessaging(ctx);
    const adapterFrame = vi.fn()
      .mockRejectedValueOnce(new Error("service binding disconnected"))
      .mockImplementationOnce(async (_installation, context, frame) => ({
        type: "res",
        id: frame.id,
        ok: true,
        data: {
          ok: true,
          adapter: "telegram",
          accountId: context.accountId,
          surfaceId: context.surface.id,
          deliveryId: context.deliveryId,
          messageId: "msg-retried",
          deliveryState: "sent",
        },
      }));
    Object.assign(ctx.env, {
      CHANNEL_TELEGRAM: { adapterFrame },
    });

    const result = await handleShellExec({
      input: "message send --to here --message retry --delivery-id logical-send-1 --also",
    }, ctx);

    expect(result).toMatchObject({ status: "completed", exitCode: 0 });
    expect(result.stdout).toContain("delivery_id=logical-send-1");
    expect(adapterFrame).toHaveBeenCalledTimes(2);
    expect(adapterFrame.mock.calls.map((call) => call[1].deliveryId)).toEqual([
      "logical-send-1",
      "logical-send-1",
    ]);
  });

  it("reports an ambiguous explicit delivery as unconfirmed, not sent", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "adapter.send"],
      processRunId: "run-telegram-ambiguous",
    });
    enableTelegramMessaging(ctx);
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
          ok: true,
          adapter: "telegram",
          accountId: context.accountId,
          surfaceId: context.surface.id,
          deliveryId: context.deliveryId,
          deliveryState: "ambiguous",
        },
      };
    });
    Object.assign(ctx.env, {
      CHANNEL_TELEGRAM: { adapterFrame },
    });

    const result = await handleShellExec({
      input: "message send --to here --message uncertain --delivery-id logical-send-ambiguous --also",
    }, ctx);

    expect(result).toMatchObject({ status: "completed", exitCode: 0 });
    expect(result.stdout).toContain("sent=false");
    expect(result.stdout).toContain("delivery_confirmed=false");
    expect(result.stdout).toContain("delivery_state=ambiguous");
    expect(result.stdout).toContain("delivery_id=logical-send-ambiguous");
  });

  it("keeps the reconciliation id when reopening a retry attachment fails", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "adapter.send", "fs.write"],
      processRunId: "run-telegram-retry-file",
    });
    enableTelegramMessaging(ctx);
    await handleFsWrite({ path: "/tmp/retry-share.png", content: "PNG" }, ctx);
    const adapterFrame: NonNullable<AdapterService["adapterFrame"]> = vi.fn(async (
      _installation,
      context,
      frame,
    ) => {
      if (frame.type !== "req") throw new Error("Expected a request frame");
      if (frame.body) await bodyToBytes(frame.body);
      await env.STORAGE.delete("tmp/retry-share.png");
      return {
        type: "res",
        id: frame.id,
        ok: true,
        data: {
          ok: false,
          error: "retry safely",
          deliveryId: context.deliveryId,
          retryable: true,
        },
      };
    });
    Object.assign(ctx.env, {
      CHANNEL_TELEGRAM: { adapterFrame },
    });

    const result = await handleShellExec({
      input: "message send --to here --attach /tmp/retry-share.png --delivery-id logical-send-file --also",
    }, ctx);

    expect(result).toMatchObject({ status: "failed", exitCode: 1 });
    expect(adapterFrame).toHaveBeenCalledTimes(1);
    expect(result.stderr).toContain("delivery_id=logical-send-file");
    expect(result.stderr).toContain("retry with --delivery-id using this value");
  });

  it("stages files for the active run's next message", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "fs.read", "fs.write"],
      processRunId: "run-native-file",
    });
    await handleFsWrite({ path: "/tmp/final.png", content: "PNG" }, ctx);
    sendFrameToProcessMock.mockImplementation(async (_installationId, _pid, frame) => {
      if (frame.type !== "req") return null;
      if (frame.call === "proc.run.attach") {
        return responseFixture({
          type: "res",
          id: frame.id,
          ok: true,
          data: { ok: true, runId: frame.args.runId, media: frame.args.media },
        });
      }
      return null;
    });

    const result = await handleShellExec({ input: "message attach /tmp/final.png" }, ctx);

    expect(result).toMatchObject({ status: "completed", exitCode: 0 });
    expect(result.stdout).toContain("attached=true");
    expect(result.stdout).toContain("run_id=run-native-file");
    expect(sendFrameToProcessMock).toHaveBeenLastCalledWith(
      TEST_INSTALLATION_ID,
      "task:shell",
      expect.objectContaining({
        call: "proc.run.attach",
        args: expect.objectContaining({
          runId: "run-native-file",
          media: [expect.objectContaining({
            type: "resource",
            ref: expect.objectContaining({
              target: "gsv",
              path: "/tmp/final.png",
              contentType: "image/png",
              size: 3,
              revision: expect.any(String),
            }),
          })],
        }),
      }),
    );
  });

  it("keeps immutable source metadata when a media hint differs", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "fs.read", "fs.write"],
      processRunId: "run-native-mime",
    });
    const received = await handleFsTransferReceive({
      path: "/tmp/voice.ogg",
      contentType: "application/octet-stream",
    }, ctx, bodyFromText("audio"));
    expect(received).toMatchObject({
      ok: true,
      contentType: "application/octet-stream",
    });
    sendFrameToProcessMock.mockImplementation(async (_installationId, _pid, frame) => {
      if (frame.type !== "req") return null;
      if (frame.call === "proc.run.attach") {
        return responseFixture({
          type: "res",
          id: frame.id,
          ok: true,
          data: { ok: true, runId: frame.args.runId, media: frame.args.media },
        });
      }
      return null;
    });

    const result = await handleShellExec({
      input: "message attach /tmp/voice.ogg --mime audio/ogg",
    }, ctx);

    expect(result).toMatchObject({ status: "completed", exitCode: 0 });
    expect(sendFrameToProcessMock).toHaveBeenLastCalledWith(
      TEST_INSTALLATION_ID,
      "task:shell",
      expect.objectContaining({
        call: "proc.run.attach",
        args: expect.objectContaining({
          media: [expect.objectContaining({
            mediaType: "audio",
            ref: expect.objectContaining({
              path: "/tmp/voice.ogg",
              contentType: "application/octet-stream",
            }),
          })],
        }),
      }),
    );
  });

  it("leaves the source file intact when active-run registration fails", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "fs.read", "fs.write"],
      processRunId: "run-ended",
    });
    await handleFsWrite({ path: "/tmp/late.pdf", content: "PDF" }, ctx);
    sendFrameToProcessMock.mockImplementation(async (_installationId, _pid, frame) => {
      if (frame.type !== "req") return null;
      if (frame.call === "proc.run.attach") {
        return responseFixture({
          type: "res",
          id: frame.id,
          ok: true,
          data: { ok: false, error: "the process run is no longer active" },
        });
      }
      return null;
    });

    const result = await handleShellExec({ input: "message attach /tmp/late.pdf" }, ctx);

    expect(result.status).toBe("failed");
    expect(result.stderr).toContain("run is no longer active");
    const source = await handleFsTransferSend({ path: "/tmp/late.pdf" }, ctx);
    expect(source.data).toMatchObject({ ok: true, path: "/tmp/late.pdf", size: 3 });
    await source.body?.stream.cancel();
  });

  it("captures the current adapter reply destination in a --here schedule", async () => {
    const create = vi.fn((input) => ({
      id: "sched-adapter-here",
      ownerUid: input.ownerUid,
      creator: input.creator,
      runAs: input.runAs,
      name: input.name,
      enabled: input.enabled,
      expression: input.expression,
      target: input.target,
      overlapPolicy: "skip",
      createdAtMs: input.now,
      updatedAtMs: input.now,
      state: {
        nextRunAtMs: input.now + input.expression.afterMs,
        runningAtMs: null,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        lastDurationMs: null,
        runCount: 0,
      },
    }));
    const ctx = makeContext({
      capabilities: ["shell.exec", "sched.add", "proc.send", "adapter.send"],
      processRunId: "run-schedule-here",
      procs: {
        get: vi.fn(() => ({
          processId: "task:shell",
          uid: IDENTITY.uid,
          ownerUid: IDENTITY.uid,
        })),
        getOwnerUid: vi.fn(() => IDENTITY.uid),
      },
      schedules: {
        create,
        setWakeScheduleId: vi.fn(),
      },
      scheduleScheduleWake: vi.fn(async () => "wake-adapter-here"),
    });
    enableTelegramMessaging(ctx);

    const result = await handleShellExec({
      input: 'sched add --here --name reminder --after 10m --message "Check the oven."',
    }, ctx);

    expect(result.stderr).toBe("");
    expect(result).toMatchObject({ status: "completed", exitCode: 0 });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      target: {
        kind: "process.event",
        pid: "task:shell",
        message: "Check the oven.",
        replyTo: {
          kind: "adapter",
          adapter: "telegram",
          accountId: "bot",
          actorId: "chat-42",
          surface: { kind: "dm", id: "chat-42" },
        },
      },
    }));
  });

  it("creates direct adapter delivery schedules from authorized destinations", async () => {
    const create = vi.fn((input) => ({
      id: "sched-adapter-direct",
      ownerUid: input.ownerUid,
      creator: input.creator,
      runAs: input.runAs,
      name: input.name,
      enabled: input.enabled,
      expression: input.expression,
      target: input.target,
      overlapPolicy: "skip",
      createdAtMs: input.now,
      updatedAtMs: input.now,
      state: {
        nextRunAtMs: input.now + input.expression.afterMs,
        runningAtMs: null,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        lastDurationMs: null,
        runCount: 0,
      },
    }));
    const ctx = makeContext({
      capabilities: ["shell.exec", "sched.add", "adapter.send"],
      schedules: {
        create,
        setWakeScheduleId: vi.fn(),
      },
      scheduleScheduleWake: vi.fn(async () => "wake-adapter-direct"),
    });
    enableTelegramMessaging(ctx);

    const result = await handleShellExec({
      input: 'sched add --to telegram --name reminder --after 10m --message "Check the oven."',
    }, ctx);
    const invalidConversation = await handleShellExec({
      input: 'sched add --to telegram --name invalid --after 10m --message "No." --conversation ops',
    }, ctx);

    expect(result).toMatchObject({ status: "completed", exitCode: 0 });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      target: {
        kind: "adapter.send",
        destination: {
          kind: "adapter",
          adapter: "telegram",
          accountId: "bot",
          actorId: "chat-42",
          surface: { kind: "dm", id: "chat-42" },
        },
        text: "Check the oven.",
      },
    }));
    expect(invalidConversation.status).toBe("failed");
    expect(invalidConversation.stderr).toContain("unexpected argument: --conversation");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("returns a delegated schedule to the IPC caller", async () => {
    const wake = vi.fn(async () => "wake-here");
    const setWakeScheduleId = vi.fn();
    const create = vi.fn((input) => ({
      id: "sched-here",
      ownerUid: input.ownerUid,
      creator: input.creator,
      runAs: input.runAs,
      name: input.name,
      enabled: input.enabled,
      expression: input.expression,
      target: input.target,
      overlapPolicy: "skip",
      createdAtMs: input.now,
      updatedAtMs: input.now,
      state: {
        nextRunAtMs: input.now + input.expression.everyMs,
        runningAtMs: null,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        lastDurationMs: null,
        runCount: 0,
      },
    }));
    const worker = {
      processId: "task:shell",
      uid: IDENTITY.uid,
      ownerUid: IDENTITY.uid,
    };
    const caller = {
      processId: "proc:personal-chat",
      uid: 2000,
      ownerUid: IDENTITY.uid,
      isPersonalController: true,
    };

    const result = await handleShellExec(
      {
        input: 'sched add --here --name "animal facts" --every 2m --message "Send a niche animal fact."',
      },
      makeContext({
        capabilities: ["sched.add", "proc.send", "r12y.create"],
        procs: {
          get: vi.fn((pid: string) => [worker, caller].find((proc) => proc.processId === pid) ?? null),
          getOwnerUid: vi.fn(() => IDENTITY.uid),
        },
        ipcCalls: {
          findPendingByTargetRun: vi.fn(() => ({
            sourcePid: caller.processId,
            sourceRunId: null,
          })),
        },
        schedules: {
          create,
          setWakeScheduleId,
        },
        scheduleScheduleWake: wake,
        processRunId: "run-worker",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("schedule_id=sched-here");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: "animal facts",
      expression: { kind: "every", everyMs: 120_000 },
      target: {
        kind: "responsibility",
        message: "Send a niche animal fact.",
      },
    }));
    expect(setWakeScheduleId).toHaveBeenCalledWith("sched-here", "wake-here");
  });

  it("creates an explicit Ship responsibility schedule from a top-level shell", async () => {
    const create = vi.fn((input) => ({
      id: "sched-ship",
      ownerUid: input.ownerUid,
      creator: input.creator,
      runAs: input.runAs,
      name: input.name,
      enabled: input.enabled,
      expression: input.expression,
      target: input.target,
      overlapPolicy: "skip",
      createdAtMs: input.now,
      updatedAtMs: input.now,
      state: {
        nextRunAtMs: input.now + input.expression.everyMs,
        runningAtMs: null,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        lastDurationMs: null,
        runCount: 0,
      },
    }));
    const result = await handleShellExec({
      input: 'sched add --ship --name upkeep --every 24h --message "Review system health."',
    }, makeContext({
      capabilities: ["sched.add", "r12y.create"],
      schedules: { create, setWakeScheduleId: vi.fn() },
      scheduleScheduleWake: vi.fn(async () => "wake-ship"),
      processId: null,
    }));

    expect(result).toMatchObject({ status: "completed", exitCode: 0 });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      target: { kind: "responsibility", message: "Review system health." },
    }));
  });

  it.each([
    {
      label: "cron with the configured timezone",
      options: '--cron "*/5 * * * *"',
      config: { "config/server/timezone": "Europe/Amsterdam" },
      expectedExpression: {
        kind: "cron",
        expr: "*/5 * * * *",
        timezone: "Europe/Amsterdam",
      },
    },
    {
      label: "cron with an explicit timezone",
      options: '--cron "0 9 * * *" --timezone Asia/Tokyo',
      config: {},
      expectedExpression: {
        kind: "cron",
        expr: "0 9 * * *",
        timezone: "Asia/Tokyo",
      },
    },
    {
      label: "a relative one-shot delay",
      options: "--after 15m",
      config: {},
      expectedExpression: { kind: "after", afterMs: 900_000 },
    },
    {
      label: "an absolute one-shot timestamp",
      options: "--at 2099-01-02T03:04:05Z",
      config: {},
      expectedExpression: {
        kind: "at",
        atMs: Date.parse("2099-01-02T03:04:05Z"),
      },
    },
  ])("supports sched add --here with $label", async ({
    options,
    config,
    expectedExpression,
  }) => {
    const create = vi.fn((input) => ({
      id: "sched-expression",
      ownerUid: input.ownerUid,
      creator: input.creator,
      runAs: input.runAs,
      name: input.name,
      enabled: input.enabled,
      expression: input.expression,
      target: input.target,
      overlapPolicy: "skip",
      createdAtMs: input.now,
      updatedAtMs: input.now,
      state: {
        nextRunAtMs: input.now + 60_000,
        runningAtMs: null,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        lastDurationMs: null,
        runCount: 0,
      },
    }));
    const result = await handleShellExec(
      {
        input: `sched add --here --name reminder ${options} --message "Check in."`,
      },
      makeContext({
        capabilities: ["sched.add", "proc.send"],
        config,
        procs: {
          get: vi.fn(() => ({
            processId: "task:shell",
            uid: IDENTITY.uid,
            ownerUid: IDENTITY.uid,
          })),
          getOwnerUid: vi.fn(() => IDENTITY.uid),
        },
        schedules: {
          create,
          setWakeScheduleId: vi.fn(),
        },
        scheduleScheduleWake: vi.fn(async () => "wake-expression"),
      }),
    );

    expect(result.ok).toBe(true);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      expression: expectedExpression,
      target: {
        kind: "process.event",
        pid: "task:shell",
        message: "Check in.",
      },
    }));
  });

  it("rejects sched add --here from a top-level shell", async () => {
    const create = vi.fn();
    const ctx = makeContext({
      capabilities: ["sched.add", "proc.send"],
      schedules: { create },
    });
    ctx.processId = undefined;

    const result = await handleShellExec(
      {
        input: 'sched add --here --name "animal facts" --every 2m --message "Send a fact."',
      },
      ctx,
    );

    expect(result.status).toBe("failed");
    expect(result.stderr).toContain("sched add --here requires a process caller");
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects ambiguous and invalid sched add --here options", async () => {
    const create = vi.fn();
    const ctx = makeContext({
      capabilities: ["sched.add", "proc.send"],
      schedules: { create },
    });

    const ambiguous = await handleShellExec(
      {
        input: 'sched add --here --name test --every 2m --after 1h --message "Run."',
      },
      ctx,
    );
    const misplacedTimezone = await handleShellExec(
      {
        input: 'sched add --here --name test --every 2m --timezone UTC --message "Run."',
      },
      ctx,
    );
    const unknown = await handleShellExec(
      {
        input: 'sched add --here --name test --every 2m --message "Run." --wat',
      },
      ctx,
    );
    const timezoneLessAt = await handleShellExec(
      {
        input: 'sched add --here --name test --at "2099-01-02 03:04:05" --message "Run."',
      },
      ctx,
    );
    const pastAt = await handleShellExec(
      {
        input: 'sched add --here --name test --at 2020-01-02T03:04:05Z --message "Run."',
      },
      ctx,
    );

    expect(ambiguous.status).toBe("failed");
    expect(ambiguous.stderr).toContain("requires exactly one");
    expect(misplacedTimezone.status).toBe("failed");
    expect(misplacedTimezone.stderr).toContain("--timezone is only valid with --cron");
    expect(unknown.status).toBe("failed");
    expect(unknown.stderr).toContain("unexpected argument: --wat");
    expect(timezoneLessAt.status).toBe("failed");
    expect(timezoneLessAt.stderr).toContain("requires an ISO timestamp with Z or a UTC offset");
    expect(pastAt.status).toBe("failed");
    expect(pastAt.stderr).toContain("schedule atMs must be in the future");
    expect(create).not.toHaveBeenCalled();
  });

  it("shows schedule last status and error in sched list", async () => {
    const result = await handleShellExec(
      { input: "sched list --all" },
      makeContext({
        capabilities: ["sched.list"],
        schedules: {
          list: vi.fn(() => ({
            count: 1,
            records: [{
              id: "sched-err",
              ownerUid: IDENTITY.uid,
              creator: { kind: "process", uid: IDENTITY.uid, username: IDENTITY.username, pid: "task:shell" },
              runAs: { kind: "process", uid: IDENTITY.uid, username: IDENTITY.username, pid: "task:shell" },
              name: "broken target",
              enabled: false,
              expression: { kind: "after", afterMs: 30_000 },
              target: { kind: "process.event", pid: "missing", message: "Run." },
              overlapPolicy: "skip",
              createdAtMs: 1,
              updatedAtMs: 2,
              state: {
                nextRunAtMs: null,
                runningAtMs: null,
                lastRunAtMs: 3,
                lastStatus: "error",
                lastError: "Process not found: missing",
                lastDurationMs: 4,
                runCount: 1,
              },
            }],
          })),
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("LAST\tERROR\tSOURCE");
    expect(result.stdout).toContain("error\tProcess not found: missing");
  });

  it("initializes wiki databases through the native wiki command", async () => {
    const applyBodies: JsonObject[] = [];
    const ripgit = focusedFixture<Fetcher>({
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        const url = new URL(String(input));
        if (url.pathname === "/hyperspace/repos/sam/memory/refs") {
          return Response.json({ heads: {}, tags: {} });
        }
        if (url.pathname === "/hyperspace/repos/sam/memory/read") {
          return new Response("missing", { status: 404 });
        }
        if (url.pathname === "/hyperspace/repos/sam/memory/apply") {
          const parsed = jsonObjectSchema.safeParse(JSON.parse(String(init?.body ?? "{}")));
          applyBodies.push(parsed.success ? parsed.data : {});
          return Response.json({ ok: true, head: `head-${applyBodies.length}` });
        }
        return new Response(`unexpected ${url.pathname}`, { status: 500 });
      },
    });

    const result = await handleShellExec(
      { input: 'wiki db init memory --title "Sam Memory"' },
      makeContext({ capabilities: ["repo.create", "repo.apply", "repo.read"], ripgit }),
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("created /src/repos/sam/memory");
    expect(applyBodies).toHaveLength(2);
    const parsedInitBody = wikiApplyBodySchema.safeParse(applyBodies[1]);
    expect(parsedInitBody.success).toBe(true);
    if (!parsedInitBody.success) throw new Error("invalid wiki apply body");
    const initBody = parsedInitBody.data;
    expect(initBody.message).toBe("wiki: init memory");
    expect(initBody.ops).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "put", path: "wiki.json" }),
        expect.objectContaining({ type: "put", path: "index.md" }),
        expect.objectContaining({ type: "put", path: "pages/.dir" }),
      ]),
    );
    const indexOp = initBody.ops?.find((op) => op.path === "index.md");
    expect(indexOp?.contentBytes).toBeDefined();
    const indexContent = new TextDecoder().decode(new Uint8Array(indexOp?.contentBytes ?? []));
    expect(indexContent).toContain("# Sam Memory");
  });

  it("searches wiki collections and returns source repo file refs", async () => {
    const ripgit = focusedFixture<Fetcher>({
      async fetch(input: RequestInfo | URL) {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/read")) {
          const repo = url.pathname.includes("/root/gsv-manual/");
          const path = url.searchParams.get("path");
          if (repo && path === "wiki.json") {
            return new Response(JSON.stringify({
              kind: "gsv.wiki",
              version: 1,
              id: "gsv-manual",
              title: "GSV Manual",
            }), {
              headers: {
                "Content-Type": "text/plain",
                "X-Blob-Size": "80",
              },
            });
          }
          return new Response("missing", { status: 404 });
        }
        if (url.pathname === "/hyperspace/repos/root/gsv-manual/search") {
          return Response.json({
            ok: true,
            matches: [
              { path: "pages/auth.md", line: 12, content: "Auth links route users to setup." },
            ],
          });
        }
        return new Response(`unexpected ${url.pathname}`, { status: 500 });
      },
    });

    const result = await handleShellExec(
      { input: "wiki search auth --prefix gsv-manual" },
      makeContext({
        capabilities: ["repo.list", "repo.read", "repo.search"],
        config: {
          "repos/root/gsv-manual/created_at": "1",
          "repos/root/gsv-manual/visibility": "public",
        },
        ripgit,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PATH\tLINE\tSNIPPET");
    expect(result.stdout).toContain("/src/repos/root/gsv-manual/pages/auth.md\t12\tAuth links route users to setup.");
  });

  it("preserves explicit wiki index search prefixes", async () => {
    const searchPrefixes: Array<string | null> = [];
    const ripgit = focusedFixture<Fetcher>({
      async fetch(input: RequestInfo | URL) {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/read")) {
          const repo = url.pathname.includes("/root/gsv-manual/");
          const path = url.searchParams.get("path");
          if (repo && path === "wiki.json") {
            return new Response(JSON.stringify({
              kind: "gsv.wiki",
              version: 1,
              id: "gsv-manual",
              title: "GSV Manual",
            }), {
              headers: {
                "Content-Type": "text/plain",
                "X-Blob-Size": "80",
              },
            });
          }
          return new Response("missing", { status: 404 });
        }
        if (url.pathname === "/hyperspace/repos/root/gsv-manual/search") {
          searchPrefixes.push(url.searchParams.get("prefix"));
          return Response.json({
            ok: true,
            matches: [
              { path: "index.md", line: 4, content: "Auth overview." },
            ],
          });
        }
        return new Response(`unexpected ${url.pathname}`, { status: 500 });
      },
    });

    const result = await handleShellExec(
      { input: "wiki search auth --prefix gsv-manual/index.md" },
      makeContext({
        capabilities: ["repo.list", "repo.read", "repo.search"],
        config: {
          "repos/root/gsv-manual/created_at": "1",
          "repos/root/gsv-manual/visibility": "public",
        },
        ripgit,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(searchPrefixes).toEqual(["index.md"]);
    expect(result.stdout).toContain("/src/repos/root/gsv-manual/index.md\t4\tAuth overview.");
  });

  it("aborts native shell execution with its request", async () => {
    const controller = new AbortController();
    const ctx = makeContext();
    ctx.requestSignal = controller.signal;
    const exec = vi.spyOn(Bash.prototype, "exec").mockImplementation(
      async (_command, options) => await new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
    );

    try {
      const request = handleShellExec({ input: "slow command" }, ctx);
      await vi.waitFor(() => expect(exec).toHaveBeenCalledOnce());
      controller.abort(new Error("User interrupted"));

      await expect(request).resolves.toMatchObject({
        status: "failed",
        error: "User interrupted",
      });
    } finally {
      exec.mockRestore();
    }
  });
});
