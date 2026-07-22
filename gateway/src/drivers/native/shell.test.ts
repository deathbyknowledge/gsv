import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { Bash } from "just-bash";
import { handleShellExec } from "./shell";
import {
  handleFsCopy,
  handleFsRead,
  handleFsTransferReceive,
  handleFsTransferSend,
  handleFsTransferStat,
  handleFsWrite,
} from "./fs";
import { sendFrameToProcess } from "../../shared/utils";
import type { KernelContext } from "../../kernel/context";
import type { DeviceRecord } from "../../kernel/devices";
import {
  bodyFromText,
  bodyToBytes,
  bodyToText,
  type ProcessIdentity,
} from "@humansandmachines/gsv/protocol";
import type { InstalledPackageRecord } from "../../kernel/packages";
import type { RequestFrame, ResponseFrame } from "../../protocol/frames";

const generateMock = vi.hoisted(() => vi.fn());

vi.mock("../../inference/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../inference/service")>();
  return {
    ...actual,
    createGenerationService: () => ({
      generate: generateMock,
      stream: vi.fn(),
      generateText: vi.fn(),
    }),
  };
});

vi.mock("../../shared/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/utils")>();
  return {
    ...actual,
    sendFrameToProcess: vi.fn(),
  };
});

const sendFrameToProcessMock = vi.mocked(sendFrameToProcess);

beforeEach(() => {
  sendFrameToProcessMock.mockReset();
  sendFrameToProcessMock.mockImplementation(async (_pid, frame) => (
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

function makePackage(partial?: Partial<InstalledPackageRecord>): InstalledPackageRecord {
  return {
    packageId: "import:root/pkg-test:.",
    scope: { kind: "global" },
    manifest: {
      name: "sample-console",
      description: "Sample console",
      version: "0.1.0",
      runtime: "web-ui",
      source: {
        repo: "root/pkg-test",
        ref: "main",
        subdir: ".",
        resolvedCommit: "abc123",
      },
      entrypoints: [{ name: "Console", kind: "ui" }],
      capabilities: {
        bindings: [],
        egress: {
          mode: "none",
        },
      },
    },
    artifact: { hash: "hash1", mainModule: "index.js", modulePaths: ["index.js"] },
    grants: {
      bindings: [],
      egress: {
        mode: "none",
      },
    },
    enabled: false,
    reviewRequired: true,
    reviewedAt: null,
    installedAt: 1,
    updatedAt: 2,
    ...partial,
  } as InstalledPackageRecord;
}

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

function makeContext(options?: {
  capabilities?: string[];
  config?: Record<string, string>;
  pkg?: InstalledPackageRecord;
  packages?: InstalledPackageRecord[];
  procs?: Partial<KernelContext["procs"]>;
  devices?: KernelContext["devices"];
  auth?: KernelContext["auth"];
  caps?: KernelContext["caps"];
  schedules?: KernelContext["schedules"];
  ipcCalls?: KernelContext["ipcCalls"];
  oauth?: KernelContext["oauth"];
  getAppRunner?: KernelContext["getAppRunner"];
  scheduleIpcCallTimeout?: KernelContext["scheduleIpcCallTimeout"];
  scheduleScheduleWake?: KernelContext["scheduleScheduleWake"];
  processRunId?: string;
  identity?: ProcessIdentity;
  aiRun?: (model: string, input: Record<string, unknown>) => Promise<unknown>;
  ripgit?: Fetcher;
}): KernelContext {
  const records = [...(options?.packages ?? [options?.pkg ?? makePackage()])];
  const identity = options?.identity ?? IDENTITY;
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
  } as unknown as KernelContext["auth"];
  const findRecord = (packageId: string, scope?: InstalledPackageRecord["scope"]) => {
    const index = records.findIndex((record) =>
      record.packageId === packageId && (!scope || packageScopeKey(record.scope) === packageScopeKey(scope))
    );
    return index >= 0 ? { index, record: records[index] } : null;
  };
  return {
    env: {
      STORAGE: env.STORAGE,
      RIPGIT: options?.ripgit ?? {} as Fetcher,
      LOADER: { get() { throw new Error("LOADER should not be used in pkg shell tests"); } },
      ...(options?.aiRun ? { AI: { run: vi.fn(options.aiRun) } } : {}),
    } as unknown as Env,
    auth: {
      ...defaultAuth,
      ...options?.auth,
    } as KernelContext["auth"],
    caps: options?.caps ?? {
      resolve: vi.fn(() => []),
    } as unknown as KernelContext["caps"],
    config: {
      get(key: string) {
        if (key === "config/server/name") return "gsv";
        if (key === "config/server/version") return "0.4.0";
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
    } as never,
    devices: options?.devices ?? null as never,
    procs: {
      get() {
        return {
          profile: "task",
          uid: identity.uid,
        };
      },
      getOwnerUid() {
        return identity.uid;
      },
      ...(options?.procs ?? {}),
    } as never,
    conversations: {
      create: vi.fn(() => ({ conversationId: "conv-1" })),
      setActivePid: vi.fn(() => true),
      clearActivePid: vi.fn(),
      remove: vi.fn(() => true),
      getByActivePid: vi.fn(() => null),
    } as unknown as KernelContext["conversations"],
    packages: {
      list(opts?: { scopes?: readonly InstalledPackageRecord["scope"][] }) {
        if (!opts?.scopes) {
          return [...records];
        }
        const scopeKeys = new Set(opts.scopes.map(packageScopeKey));
        return records.filter((record) => scopeKeys.has(packageScopeKey(record.scope)));
      },
      resolve(packageId: string, scopes?: readonly InstalledPackageRecord["scope"][]) {
        for (const scope of scopes ?? []) {
          const found = findRecord(packageId, scope);
          if (found) return found.record;
        }
        return records.find((record) => record.packageId === packageId) ?? null;
      },
      get(packageId: string, scope?: InstalledPackageRecord["scope"]) {
        return findRecord(packageId, scope)?.record ?? null;
      },
      setEnabled(packageId: string, enabled: boolean, scope?: InstalledPackageRecord["scope"]) {
        const found = findRecord(packageId, scope);
        if (!found) return null;
        const existing = found.record;
        const updated = { ...existing, enabled, updatedAt: existing.updatedAt + 1 };
        records[found.index] = updated;
        return updated;
      },
      setReviewed(packageId: string, reviewedAt: number, scope?: InstalledPackageRecord["scope"]) {
        const found = findRecord(packageId, scope);
        if (!found) return null;
        const existing = found.record;
        const updated = { ...existing, reviewedAt, reviewRequired: true, updatedAt: existing.updatedAt + 1 };
        records[found.index] = updated;
        return updated;
      },
    } as never,
    oauth: options?.oauth ?? {
      listAccounts: vi.fn(() => []),
      listFlows: vi.fn(() => []),
      deleteAccount: vi.fn(() => false),
    } as unknown as KernelContext["oauth"],
    adapters: {
      identityLinks: { list: vi.fn(() => []) },
      status: {
        list: vi.fn(() => []),
        listAll: vi.fn(() => []),
        listByOwner: vi.fn(() => []),
      },
    } as unknown as KernelContext["adapters"],
    runRoutes: null as never,
    schedules: options?.schedules,
    ipcCalls: options?.ipcCalls,
    connection: null,
    identity: {
      role: "user",
      process: identity,
      capabilities: options?.capabilities ?? ["pkg.list", "repo.refs", "repo.log"],
    },
    processId: "task:pkg",
    processRunId: options?.processRunId,
    serverVersion: "0.4.0",
    getAppRunner: options?.getAppRunner,
    scheduleIpcCallTimeout: options?.scheduleIpcCallTimeout,
    scheduleScheduleWake: options?.scheduleScheduleWake,
  } as KernelContext;
}

function packageScopeKey(scope: InstalledPackageRecord["scope"]): string {
  switch (scope.kind) {
    case "global":
      return "global";
    case "user":
      return `user:${scope.uid}`;
  }
}

function makeSkillFetcher(
  files: Record<string, string>,
  readPaths: string[] = [],
): Fetcher {
  const encoder = new TextEncoder();
  const names = Object.keys(files).sort();
  return {
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
  } as unknown as Fetcher;
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
  const adapterSend = vi.fn(async (
    _accountId: string,
    _message: unknown,
    body?: { stream: ReadableStream<Uint8Array>; length?: number },
  ) => {
    const bytes = body ? await bodyToBytes(body) : undefined;
    return { ok: true as const, messageId: bytes ? `bytes-${bytes.byteLength}` : "msg-1" };
  });
  Object.assign(ctx.env as unknown as Record<string, unknown>, {
    CHANNEL_TELEGRAM: { adapterSend },
  });
  ctx.adapters = {
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
    status: {
      get: vi.fn((adapter: string, accountId: string) =>
        adapter === status.adapter && accountId === status.accountId ? status : null),
      list: vi.fn(() => [status]),
      listAll: vi.fn(() => [status]),
      listByOwner: vi.fn(() => [status]),
    },
  } as unknown as KernelContext["adapters"];
  ctx.runRoutes = {
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
          createdAt: 1,
          expiresAt: Date.now() + 60_000,
        }
      : null),
  } as unknown as KernelContext["runRoutes"];
  return { adapterSend, link, status };
}

describe("native shell execution", () => {
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

  it("runs user administration with a password redirected from GSV storage", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "user.admin", "fs.write"],
      caps: {
        list: vi.fn((gid?: number) => gid === IDENTITY.gid
          ? [{ gid: IDENTITY.gid, capability: "user.admin" }]
          : []),
        resolve: vi.fn(() => []),
      } as unknown as KernelContext["caps"],
    });
    const passwordPath = "/tmp/.new-user-password";
    await expect(handleFsWrite({ path: passwordPath, content: "" }, ctx))
      .resolves.toMatchObject({ ok: true });
    await expect(handleShellExec({ input: `chmod 600 ${passwordPath}` }, ctx))
      .resolves.toMatchObject({ status: "completed", exitCode: 0 });
    await handleFsWrite({ path: passwordPath, content: "password-123\n" }, ctx);
    await expect(handleShellExec({ input: `stat -c %a ${passwordPath}` }, ctx))
      .resolves.toMatchObject({ status: "completed", stdout: "600\n" });
    const request = vi.fn(async (frame: RequestFrame): Promise<ResponseFrame> => ({
      type: "res",
      id: frame.id,
      ok: true,
      data: {
        action: "create",
        account: {
          uid: 1002,
          gid: 1002,
          gids: [1002, 100],
          username: "alice",
          home: "/home/alice",
          cwd: "/home/alice",
        },
        personalAgent: {
          uid: 1003,
          gid: 1003,
          gids: [1003, 1002, 100],
          username: "friday",
          home: "/home/friday",
          cwd: "/home/friday",
        },
      },
    } as ResponseFrame));

    const result = await handleShellExec(
      { input: `user create alice --password-stdin < ${passwordPath}` },
      ctx,
      { request },
    );

    expect(result).toMatchObject({ status: "completed", exitCode: 0 });
    expect(result.stdout).toContain("Created human account alice");
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      call: "user.admin",
      args: {
        action: "create",
        username: "alice",
        password: "password-123",
      },
    }), expect.any(AbortSignal));
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

  it("uses stored MIME types for reads and transfer metadata", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await env.STORAGE.put("tmp/fs-read-image", bytes, {
      httpMetadata: { contentType: "image/png" },
    });

    const ctx = makeContext();
    const read = await handleFsRead({ path: "/tmp/fs-read-image" }, ctx);
    const stat = await handleFsTransferStat({ path: "/tmp/fs-read-image" }, ctx);

    expect(read.data).toMatchObject({
      ok: true,
      kind: "image",
      contentType: "image/png",
      size: bytes.byteLength,
    });
    expect(read.body && await bodyToBytes(read.body)).toEqual(bytes);
    expect(stat).toMatchObject({
      ok: true,
      contentType: "image/png",
      size: bytes.byteLength,
    });
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

  it("uses the owning human's package scopes for agent-backed fs", async () => {
    const humanPackage = makePackage({
      packageId: "user:1000:human-tools",
      scope: { kind: "user", uid: 1000 },
      enabled: true,
      manifest: {
        ...makePackage().manifest,
        name: "human-tools",
        source: {
          repo: "root/human-tools",
          ref: "main",
          subdir: ".",
          resolvedCommit: "abc123",
        },
        entrypoints: [{ name: "Human Tool", kind: "command", command: "human-tool" }],
      },
    });
    const agentPackage = makePackage({
      packageId: "user:2000:agent-tools",
      scope: { kind: "user", uid: 2000 },
      enabled: true,
      manifest: {
        ...makePackage().manifest,
        name: "agent-tools",
        source: {
          repo: "root/agent-tools",
          ref: "main",
          subdir: ".",
          resolvedCommit: "abc123",
        },
        entrypoints: [{ name: "Agent Tool", kind: "command", command: "agent-tool" }],
      },
    });
    const ctx = makeContext({
      capabilities: ["fs.read"],
      packages: [humanPackage, agentPackage],
      identity: {
        uid: 2000,
        gid: 2000,
        gids: [2000],
        username: "sam-agent",
        home: "/home/sam-agent",
        cwd: "/home/sam-agent",
      },
      procs: {
        getOwnerUid: vi.fn(() => 1000),
      } as unknown as KernelContext["procs"],
    });

    const sourceList = await handleFsRead({ path: "/src/repos/root" }, ctx);
    expect(sourceList.data.ok).toBe(true);
    if (sourceList.data.ok && "directories" in sourceList.data) {
      expect(sourceList.data.directories).toContain("human-tools");
      expect(sourceList.data.directories).not.toContain("agent-tools");
    }

    const binList = await handleFsRead({ path: "/usr/local/bin" }, ctx);
    expect(binList.data.ok).toBe(true);
    if (binList.data.ok && "files" in binList.data) {
      expect(binList.data.files).toContain("human-tool");
      expect(binList.data.files).not.toContain("agent-tool");
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
    expect(result.stdout).toContain("message      Send messages and file attachments");
    expect(result.stdout).toContain("skills       Inspect and maintain reusable agent workflows");
    expect(result.stdout).not.toContain("GSV manual pages");
  });

  it("documents secure native user administration without requiring authority", async () => {
    const result = await handleShellExec(
      { input: "man user" },
      makeContext({ capabilities: ["shell.exec"] }),
    );

    expect(result).toMatchObject({ status: "completed", exitCode: 0 });
    expect(result.stdout).toContain("user create USER --password-stdin");
    expect(result.stdout).toContain("protected file; do not put a password");
    expect(result.stdout).toContain("already-authenticated WebSocket");
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
    expect(result.stdout).toContain("img2txt [OPTIONS] IMAGE");
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
    expect(result.stdout).toContain("message send --to DESTINATION");
    expect(result.stdout).toContain("--attach PATH");
  });

  it("keeps messaging destinations separate from execution targets", async () => {
    const targets = await handleShellExec(
      { input: "man targets" },
      makeContext({ capabilities: ["shell.exec"] }),
    );
    const sched = await handleShellExec(
      { input: "man sched" },
      makeContext({ capabilities: ["shell.exec"] }),
    );

    expect(targets.ok).toBe(true);
    expect(targets.stdout).toContain("device   User-owned connected devices");
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

  it("discovers commands from the caller-visible package registry", async () => {
    const accessibilityPackage = makePackage({
      packageId: "user:1000:accessibility-tools",
      scope: { kind: "user", uid: 1000 },
      enabled: true,
      manifest: {
        ...makePackage().manifest,
        name: "accessibility-tools",
        description: "Audit web interfaces for accessibility problems.",
        entrypoints: [{
          name: "Accessibility Audit",
          kind: "command",
          command: "a11y-audit",
          description: "Audit a web page for contrast and accessibility problems.",
        }],
      },
    });
    const result = await handleShellExec(
      { input: "man --search -- 'check page contrast'" },
      makeContext({ capabilities: ["shell.exec"], packages: [accessibilityPackage] }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout.split("\n")[2]).toContain("command\ta11y-audit\t");
    expect(result.stdout).toContain("command\ta11y-audit\t");
    expect(result.stdout).toContain("man 'a11y-audit'");
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
    } as unknown as KernelContext["devices"];
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
  function oauthAccount(metadata: Record<string, unknown> = {}) {
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
    } as unknown as KernelContext["oauth"];

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
    } as unknown as KernelContext["oauth"];

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
    } as unknown as KernelContext["oauth"];

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
    } as unknown as KernelContext["devices"];
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
          if (Array.isArray(input.messages)) {
            return { response: "terminal screenshot" };
          }
          if (typeof input.audio === "string") {
            return { text: "hello audio" };
          }
          if (typeof input.text === "string") {
            return new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([4, 5, 6]));
                controller.close();
              },
            });
          }
          if (typeof input.prompt === "string") {
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
    let imageReadInput: Record<string, unknown> | undefined;
    await env.STORAGE.delete(key);

    const result = await handleShellExec(
      {
        input: "txt2img -o generated-jpeg.png green-square; img2txt generated-jpeg.png",
      },
      makeContext({
        capabilities: ["ai.image.read", "ai.image.generate"],
        aiRun: vi.fn(async (_model, input) => {
          if (Array.isArray(input.messages)) {
            imageReadInput = input;
            return { response: "a green square" };
          }
          if (typeof input.prompt === "string") {
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
    } as unknown as KernelContext["devices"];

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
    } as unknown as KernelContext["devices"];
    const auth = {
      getPasswdByUid: vi.fn(() => ({ username: "sam" })),
    } as unknown as KernelContext["auth"];

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
    const clearActivePid = vi.fn();
    const ctx = makeContext({
      capabilities: [capability],
      procs: {
        get: vi.fn((pid: string) => pid === process.processId ? process : null),
        getOwnerUid: vi.fn(() => IDENTITY.uid),
        kill,
      } as Partial<KernelContext["procs"]>,
      ipcCalls: {
        cancelBySourcePid,
      } as unknown as KernelContext["ipcCalls"],
    });
    Object.assign(ctx, {
      failIpcCallsByTarget,
      runRoutes: { clearForProcess: clearProcessRoutes },
    });
    Object.assign(ctx.conversations, { clearActivePid });
    return {
      ctx,
      kill,
      cancelBySourcePid,
      failIpcCallsByTarget,
      clearProcessRoutes,
      clearActivePid,
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
    } as unknown as KernelContext["auth"];

    const result = await handleShellExec(
      { input: "proc agents" },
      makeContext({
        capabilities: ["account.list"],
        auth,
        procs: { getOwnerUid: () => 1000 } as unknown as KernelContext["procs"],
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
              contextFiles: [],
              createdAt: 1,
            };
          },
          spawn,
        } as never,
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

  it("spawns a fresh process by default from a top-level native shell", async () => {
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
      procs: { spawn } as Partial<KernelContext["procs"]>,
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
      expect.stringMatching(/^proc:/),
      expect.objectContaining({ call: "proc.send", args: expect.objectContaining({ message: "do work" }) }),
    );

    const jsonResult = await handleShellExec(
      { input: `proc spawn --json '{"fresh":false,"label":"json-child"}'` },
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
        procs: { spawn } as Partial<KernelContext["procs"]>,
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.stderr).toContain("unexpected option: --timeout");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("accepts dash-prefixed proc spawn prompts after the option delimiter", async () => {
    const parent = {
      processId: "task:pkg",
      uid: IDENTITY.uid,
      ownerUid: IDENTITY.uid,
      gid: IDENTITY.gid,
      gids: IDENTITY.gids,
      username: IDENTITY.username,
      home: IDENTITY.home,
      cwd: IDENTITY.cwd,
      state: "running",
      activeRunId: null,
      activeConversationId: null,
      queuedCount: 0,
      lastActiveAt: null,
      interactive: true,
      parentPid: null,
      label: null,
      contextFiles: [],
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
        } as Partial<KernelContext["procs"]>,
      }),
    );

    expect(result.ok).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
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
      clearActivePid,
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
    expect(clearActivePid).toHaveBeenCalledWith("proc:child");
  });

  it("delegates bounded work through a new child process", async () => {
    const spawnedPids: string[] = [];
    const parent = {
      processId: "task:pkg",
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
      contextFiles: [],
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

    sendFrameToProcessMock.mockImplementation(async (pid, frame) => {
      const req = frame as any;
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
        }));
        return {
          type: "res",
          id: req.id,
          ok: true,
          data: {
            ok: true,
            status: "started",
            pid,
            sourcePid: "task:pkg",
            conversationId: "default",
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
            if (pid === "task:pkg") return parent;
            if (pid === spawnedPids[0]) {
              return {
                ...parent,
                processId: pid,
                parentPid: "task:pkg",
                interactive: false,
                label: "planning",
              };
            }
            return null;
          },
          getOwnerUid: vi.fn(() => IDENTITY.uid),
          spawn,
        } as unknown as KernelContext["procs"],
        ipcCalls: ipcCalls as unknown as KernelContext["ipcCalls"],
        scheduleIpcCallTimeout,
        processRunId: "parent-run",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("status=in_progress");
    const createdCall = ipcCalls.create.mock.calls[0]?.[0];
    expect(result.stdout).toContain(`run_id=${createdCall.targetRunId}`);
    expect(result.stdout).toContain("queued=false");
    expect(result.stdout).toContain('label="planning"');
    expect(spawn).toHaveBeenCalledWith(
      spawnedPids[0],
      expect.objectContaining({ username: "sam" }),
      expect.objectContaining({
        parentPid: "task:pkg",
        interactive: false,
        label: "planning",
      }),
    );
    expect(ipcCalls.create).toHaveBeenCalledWith(expect.objectContaining({
      sourcePid: "task:pkg",
      sourceRunId: "parent-run",
      targetPid: spawnedPids[0],
      targetRunId: expect.any(String),
      uid: IDENTITY.uid,
    }));
    const callId = createdCall.callId;
    expect(scheduleIpcCallTimeout).toHaveBeenCalledWith(callId, createdCall.deadlineAt);
  });

  it("rejects delegation from a top-level shell before spawning", async () => {
    const spawn = vi.fn();
    const ctx = makeContext({
      capabilities: ["proc.spawn", "proc.ipc.call"],
      procs: { spawn } as Partial<KernelContext["procs"]>,
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
      removesConversation: true,
      lookupError: null,
    },
    {
      label: "IPC setup throws",
      throws: true,
      error: "IPC store unavailable",
      removesConversation: true,
      lookupError: null,
    },
    {
      label: "conversation cleanup fails",
      throws: false,
      error: "delivery failed",
      removesConversation: false,
      lookupError: null,
    },
    {
      label: "conversation lookup throws",
      throws: false,
      error: "delivery failed",
      removesConversation: true,
      lookupError: "conversation registry unavailable",
    },
  ])("rolls back a fresh delegated child when $label", async ({
    throws,
    error,
    removesConversation,
    lookupError,
  }) => {
    const children: string[] = [];
    const parent = {
      processId: "task:pkg",
      uid: IDENTITY.uid,
      ownerUid: IDENTITY.uid,
      gid: IDENTITY.gid,
      gids: IDENTITY.gids,
      username: IDENTITY.username,
      home: IDENTITY.home,
      cwd: IDENTITY.cwd,
      state: "running",
      activeRunId: "parent-run",
      activeConversationId: "ops",
      queuedCount: 0,
      lastActiveAt: 1,
      interactive: true,
      parentPid: null,
      label: "parent",
      contextFiles: [],
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
    const removeConversation = vi.fn(() => removesConversation);
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
              activeConversationId: null,
              interactive: false,
              label: "investigate the schedule",
            };
          }
          return null;
        }),
        getOwnerUid: vi.fn(() => IDENTITY.uid),
        spawn,
        kill,
      } as unknown as KernelContext["procs"],
      ipcCalls: ipcCalls as unknown as KernelContext["ipcCalls"],
      scheduleIpcCallTimeout: vi.fn(async () => "timeout-schedule"),
      processRunId: "parent-run",
    });
    Object.assign(ctx, {
      failIpcCallsByTarget: vi.fn(),
      runRoutes: { clearForProcess: vi.fn() },
    });
    Object.assign(ctx.conversations, {
      getByActivePid: vi.fn(() => {
        if (lookupError) {
          throw new Error(lookupError);
        }
        return {
          conversationId: "conv-1",
          archiveBase: "/home/sam/conversations/conv-1",
        };
      }),
      remove: removeConversation,
    });
    sendFrameToProcessMock.mockImplementation(async (_pid, frame) => {
      const req = frame as RequestFrame;
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
    if (lookupError) {
      expect(result.stderr).toContain(`rollback failed: conversation lookup failed: ${lookupError}`);
    } else if (removesConversation) {
      expect(result.stderr).not.toContain("rollback failed");
    } else {
      expect(result.stderr).toContain("rollback failed: failed to remove conversation conv-1");
    }
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      children[0],
      expect.objectContaining({
        call: "proc.kill",
        args: { pid: children[0], archive: false },
      }),
    );
    expect(kill).toHaveBeenCalledWith(children[0]);
    if (lookupError) {
      expect(removeConversation).not.toHaveBeenCalled();
    } else {
      expect(removeConversation).toHaveBeenCalledWith("conv-1");
    }
  });

  it("rejects legacy profile selection in proc spawn", async () => {
    const result = await handleShellExec(
      { input: 'proc spawn --profile cron "Daily brief"' },
      makeContext({ capabilities: ["proc.spawn"] }),
    );

    expect(result.status).toBe("failed");
    expect(result.stderr).toContain("--profile is no longer supported");
  });

  it("denies conversation commands for same run-as processes owned by another user", async () => {
    const result = await handleShellExec(
      { input: "proc segments --pid foreign-pid" },
      makeContext({
        capabilities: ["proc.conversation.segments"],
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
                contextFiles: [],
                createdAt: 1,
              };
            }
            return null;
          }),
        } as Partial<KernelContext["procs"]>,
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.stderr).toContain("Permission denied: cannot access process foreign-pid");
  });

  it("reads live process history from the native proc command surface", async () => {
    sendFrameToProcessMock.mockResolvedValueOnce({
      type: "res",
      id: "history-1",
      ok: true,
      data: {
        ok: true,
        pid: "proc:child",
        conversationId: "default",
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
        activeConversationId: null,
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
            if (pid === "proc:child" || pid === "task:pkg") {
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
                contextFiles: [],
                createdAt: 1,
              };
            }
            return null;
          }),
        } as Partial<KernelContext["procs"]>,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("History proc:child");
    expect(result.stdout).toContain("Messages: 2/2");
    expect(result.stdout).toContain("please inves");
    expect(result.stdout).toContain("[truncated 6 chars; use --full or --json to inspect all content]");
    expect(result.stdout).toContain("xxxxxxxxxxxx");
    expect(result.stdout).toContain("[truncated 28 chars; use --full or --json to inspect all content]");
    expect(sendFrameToProcessMock).toHaveBeenCalledWith("proc:child", expect.objectContaining({
      call: "proc.history",
      args: {
        pid: "proc:child",
        limit: 2,
        tail: true,
      },
    }));
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

  it("streams gsv files to a device target", async () => {
    const sourceKey = "home/sam/copy-test/device-source.txt";
    await env.STORAGE.delete(sourceKey);
    await env.STORAGE.put(sourceKey, "to device", {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { uid: "1000", gid: "1000", mode: "644" },
    });
    const ctx = makeContext() as KernelContext;
    ctx.devices = {
      canAccess: vi.fn(() => true),
      canHandle: vi.fn(() => true),
    } as never;
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
    const ctx = makeContext() as KernelContext;
    ctx.requestSignal = controller.signal;
    ctx.devices = {
      canAccess: vi.fn(() => true),
      canHandle: vi.fn(() => true),
    } as never;
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
    const ctx = makeContext() as KernelContext;
    ctx.devices = {
      canAccess: vi.fn(() => true),
      canHandle: vi.fn(() => true),
    } as never;
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
    const ctx = makeContext() as KernelContext;
    ctx.devices = {
      canAccess: vi.fn(() => true),
      canHandle: vi.fn(() => true),
    } as never;

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
    const ctx = makeContext() as KernelContext;
    ctx.devices = {
      canAccess: vi.fn(() => true),
      canHandle: vi.fn(() => true),
    } as never;
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
    const ctx = makeContext() as KernelContext;
    ctx.devices = {
      canAccess: vi.fn(() => true),
      canHandle: vi.fn(() => true),
    } as never;
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

describe("pkg shell command", () => {
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
            path: (frame.args as { path: string }).path,
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
    const ctx = makeContext({ capabilities: ["sys.mcp.list"] }) as KernelContext;
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
        listTools: () => [{ name: "lookup", description: "Lookup", inputSchema: {} }],
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
    const ctx = makeContext({ capabilities: ["sys.mcp.list"] }) as KernelContext;
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
        listTools: () => [{ name: "lookup-record", description: "Lookup records", inputSchema: { required: ["query"] } }],
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
    const ctx = makeContext({ capabilities: ["sys.mcp.call"] }) as KernelContext;
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
        listTools: () => [{ name: "lookup", description: "Lookup", inputSchema: {} }],
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
    expect(result.stdout).toBe("task:pkg\ntask:pkg\n");
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
    } as unknown as KernelContext["auth"];
    const ctx = makeContext({
      capabilities: ["sched.add", "sched.remove", "sched.list"],
      auth,
      caps: {
        resolve: vi.fn(() => ["shell.*"]),
      } as unknown as KernelContext["caps"],
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
      } as unknown as KernelContext["schedules"],
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
    } as unknown as KernelContext["auth"];
    const ctx = makeContext({
      identity: agent,
      capabilities: ["sched.add", "sched.remove", "sched.list"],
      auth,
      caps: {
        resolve: vi.fn(() => ["shell.exec"]),
      } as unknown as KernelContext["caps"],
      procs: {
        getOwnerUid: vi.fn(() => IDENTITY.uid),
      } as Partial<KernelContext["procs"]>,
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
      } as unknown as KernelContext["schedules"],
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
        conversationId: "ops",
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
        } as Partial<KernelContext["procs"]>,
        schedules: {
          create,
          setWakeScheduleId,
        } as unknown as KernelContext["schedules"],
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
        conversationId: "ops",
        message: "Run pulse.",
      },
    }));
    expect(setWakeScheduleId).toHaveBeenCalledWith("sched-2", "wake-1");
  });

  it("distinguishes the automatic reply from intentional extra messages", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "adapter.send"],
      processRunId: "run-telegram",
    });
    const { adapterSend } = enableTelegramMessaging(ctx);

    const current = await handleShellExec({ input: "message current" }, ctx);
    const duplicate = await handleShellExec({
      input: 'message send --to here --message "duplicate reply"',
    }, ctx);
    const intentional = await handleShellExec({
      input: 'message send --to here --message "extra update" --also',
    }, ctx);

    expect(current).toMatchObject({ status: "completed", exitCode: 0 });
    expect(current.stdout).toContain("automatic reply: Telegram direct message");
    expect(current.stdout).toContain("create additional outbound messages");
    expect(duplicate.status).toBe("failed");
    expect(duplicate.stderr).toContain("automatic reply destination");
    expect(duplicate.stderr).toContain("--also");
    expect(intentional).toMatchObject({ status: "completed", exitCode: 0 });
    expect(intentional.stdout).toContain("sent=true");
    expect(intentional.stdout).toMatch(/destination=message-destination:[0-9a-f]{64}/);
    expect(intentional.stdout).not.toContain("chat-42");
    expect(intentional.stdout).not.toContain("account=bot");
    expect(intentional.stdout).not.toContain("message_id=msg-1");
    expect(adapterSend).toHaveBeenCalledTimes(1);
    expect(adapterSend).toHaveBeenCalledWith(
      "bot",
      expect.objectContaining({
        surface: { kind: "dm", id: "chat-42" },
        text: "extra update",
      }),
      undefined,
    );
  });

  it("lists and resolves opaque destinations without provider identifiers", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "adapter.send"],
      processRunId: "run-telegram-destinations",
    });
    const { adapterSend } = enableTelegramMessaging(ctx);

    const listed = await handleShellExec({ input: "message destinations --json" }, ctx);
    expect(listed).toMatchObject({ status: "completed", exitCode: 0 });
    const destinationId = JSON.parse(listed.stdout).destinations[0].id as string;
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
    expect(adapterSend).toHaveBeenCalledWith(
      "bot",
      expect.objectContaining({ text: "opaque route" }),
      undefined,
    );
  });

  it("bridges a GSV file into an explicit adapter message body", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "adapter.send", "fs.write"],
      processRunId: "run-telegram-file",
    });
    const { adapterSend } = enableTelegramMessaging(ctx);
    await handleFsWrite({ path: "/tmp/share.png", content: "PNG" }, ctx);

    const result = await handleShellExec({
      input: "message send --to here --attach /tmp/share.png --also",
    }, ctx);

    expect(result).toMatchObject({ status: "completed", exitCode: 0 });
    expect(result.stdout).toContain("sent=true");
    expect(result.stdout).not.toContain("bytes-3");
    expect(adapterSend).toHaveBeenCalledWith(
      "bot",
      expect.objectContaining({
        text: "",
        media: [{
          type: "image",
          mimeType: "image/png",
          filename: "share.png",
          size: 3,
          body: { offset: 0, length: 3 },
        }],
      }),
      expect.objectContaining({ length: 3 }),
    );
  });

  it("retries an explicit message with the same delivery id", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "adapter.send"],
      processRunId: "run-telegram-retry",
    });
    enableTelegramMessaging(ctx);
    const adapterSend = vi.fn()
      .mockRejectedValueOnce(new Error("service binding disconnected"))
      .mockResolvedValueOnce({ ok: true as const, messageId: "msg-retried" });
    Object.assign(ctx.env as unknown as Record<string, unknown>, {
      CHANNEL_TELEGRAM: { adapterSend },
    });

    const result = await handleShellExec({
      input: "message send --to here --message retry --delivery-id logical-send-1 --also",
    }, ctx);

    expect(result).toMatchObject({ status: "completed", exitCode: 0 });
    expect(result.stdout).toContain("delivery_id=logical-send-1");
    expect(adapterSend).toHaveBeenCalledTimes(2);
    expect(adapterSend.mock.calls.map((call) => (call[1] as any).deliveryId)).toEqual([
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
    Object.assign(ctx.env as unknown as Record<string, unknown>, {
      CHANNEL_TELEGRAM: {
        adapterSend: vi.fn(async () => ({
          ok: false as const,
          error: "provider outcome unknown",
          ambiguous: true,
        })),
      },
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
    const adapterSend = vi.fn(async (
      _accountId: string,
      _message: unknown,
      body?: { stream: ReadableStream<Uint8Array>; length?: number },
    ) => {
      if (body) await bodyToBytes(body);
      await env.STORAGE.delete("tmp/retry-share.png");
      return { ok: false as const, error: "retry safely", retryable: true };
    });
    Object.assign(ctx.env as unknown as Record<string, unknown>, {
      CHANNEL_TELEGRAM: { adapterSend },
    });

    const result = await handleShellExec({
      input: "message send --to here --attach /tmp/retry-share.png --delivery-id logical-send-file --also",
    }, ctx);

    expect(result).toMatchObject({ status: "failed", exitCode: 1 });
    expect(adapterSend).toHaveBeenCalledTimes(1);
    expect(result.stderr).toContain("delivery_id=logical-send-file");
    expect(result.stderr).toContain("retry with --delivery-id using this value");
  });

  it("stages files on the active run's automatic final reply", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "proc.media.write", "fs.write"],
      processRunId: "run-native-file",
    });
    await handleFsWrite({ path: "/tmp/final.png", content: "PNG" }, ctx);
    let stagedBytes: Uint8Array | undefined;
    let stagedKey = "";
    sendFrameToProcessMock.mockImplementation(async (_pid, frame) => {
      if (frame.type !== "req") return null;
      if (frame.call === "proc.media.write") {
        stagedBytes = frame.body ? await bodyToBytes(frame.body) : undefined;
        stagedKey = `var/media/1000/task:pkg/${frame.args.mediaId}`;
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: {
            ok: true,
            media: {
              type: "image",
              mimeType: "image/png",
              filename: "final.png",
              key: stagedKey,
              path: `/${stagedKey}`,
              size: 3,
            },
          },
        } as any;
      }
      if (frame.call === "proc.run.attach") {
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: { ok: true, runId: frame.args.runId, media: frame.args.media },
        } as any;
      }
      return null;
    });

    const result = await handleShellExec({ input: "message attach /tmp/final.png" }, ctx);

    expect(result).toMatchObject({ status: "completed", exitCode: 0 });
    expect(result.stdout).toContain("attached=true");
    expect(result.stdout).toContain("run_id=run-native-file");
    expect(stagedBytes && [...stagedBytes]).toEqual([80, 78, 71]);
    expect(sendFrameToProcessMock).toHaveBeenLastCalledWith(
      "task:pkg",
      expect.objectContaining({
        call: "proc.run.attach",
        args: expect.objectContaining({
          runId: "run-native-file",
          stagedKeys: [stagedKey],
        }),
      }),
    );
  });

  it("removes staged reply media when active-run registration fails", async () => {
    const ctx = makeContext({
      capabilities: ["shell.exec", "proc.media.write", "fs.write"],
      processRunId: "run-ended",
    });
    await handleFsWrite({ path: "/tmp/late.pdf", content: "PDF" }, ctx);
    let key = "";
    sendFrameToProcessMock.mockImplementation(async (_pid, frame) => {
      if (frame.type !== "req") return null;
      if (frame.call === "proc.media.write") {
        await frame.body?.stream.cancel("test does not need the bytes");
        key = `var/media/1000/task:pkg/${frame.args.mediaId}`;
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: {
            ok: true,
            media: {
              type: "document",
              mimeType: "application/pdf",
              filename: "late.pdf",
              key,
              path: `/${key}`,
              size: 3,
            },
          },
        } as any;
      }
      if (frame.call === "proc.run.attach") {
        return {
          type: "res",
          id: frame.id,
          ok: true,
          data: { ok: false, error: "the process run is no longer active" },
        } as any;
      }
      if (frame.call === "proc.media.delete") {
        return { type: "res", id: frame.id, ok: true, data: { ok: true, key } } as any;
      }
      return null;
    });

    const result = await handleShellExec({ input: "message attach /tmp/late.pdf" }, ctx);

    expect(result.status).toBe("failed");
    expect(result.stderr).toContain("run is no longer active");
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      "task:pkg",
      expect.objectContaining({ call: "proc.media.delete", args: { pid: "task:pkg", key } }),
    );
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
          processId: "task:pkg",
          uid: IDENTITY.uid,
          ownerUid: IDENTITY.uid,
          activeConversationId: null,
        })),
        getOwnerUid: vi.fn(() => IDENTITY.uid),
      } as Partial<KernelContext["procs"]>,
      schedules: {
        create,
        setWakeScheduleId: vi.fn(),
      } as unknown as KernelContext["schedules"],
      scheduleScheduleWake: vi.fn(async () => "wake-adapter-here"),
    });
    enableTelegramMessaging(ctx);

    const result = await handleShellExec({
      input: 'sched add --here --name reminder --after 10m --message "Check the oven."',
    }, ctx);

    expect(result).toMatchObject({ status: "completed", exitCode: 0 });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      target: {
        kind: "process.event",
        pid: "task:pkg",
        conversationId: "default",
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
      } as unknown as KernelContext["schedules"],
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
    expect(invalidConversation.stderr).toContain("--conversation is only valid with --here");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("schedules an event into the caller's active conversation", async () => {
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
    const caller = {
      processId: "task:pkg",
      uid: IDENTITY.uid,
      ownerUid: IDENTITY.uid,
      activeConversationId: "ops",
    };

    const result = await handleShellExec(
      {
        input: 'sched add --here --name "animal facts" --every 2m --message "Send a niche animal fact."',
      },
      makeContext({
        capabilities: ["sched.add", "proc.send"],
        procs: {
          get: vi.fn((pid: string) => pid === caller.processId ? caller : null),
          getOwnerUid: vi.fn(() => IDENTITY.uid),
        } as Partial<KernelContext["procs"]>,
        schedules: {
          create,
          setWakeScheduleId,
        } as unknown as KernelContext["schedules"],
        scheduleScheduleWake: wake,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("schedule_id=sched-here");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: "animal facts",
      expression: { kind: "every", everyMs: 120_000 },
      target: {
        kind: "process.event",
        pid: "task:pkg",
        conversationId: "ops",
        message: "Send a niche animal fact.",
      },
    }));
    expect(setWakeScheduleId).toHaveBeenCalledWith("sched-here", "wake-here");
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
      expectedConversation: "default",
    },
    {
      label: "cron with an explicit timezone and conversation",
      options: '--cron "0 9 * * *" --timezone Asia/Tokyo --conversation reviews',
      config: {},
      expectedExpression: {
        kind: "cron",
        expr: "0 9 * * *",
        timezone: "Asia/Tokyo",
      },
      expectedConversation: "reviews",
    },
    {
      label: "a relative one-shot delay",
      options: "--after 15m",
      config: {},
      expectedExpression: { kind: "after", afterMs: 900_000 },
      expectedConversation: "default",
    },
    {
      label: "an absolute one-shot timestamp",
      options: "--at 2099-01-02T03:04:05Z",
      config: {},
      expectedExpression: {
        kind: "at",
        atMs: Date.parse("2099-01-02T03:04:05Z"),
      },
      expectedConversation: "default",
    },
  ])("supports sched add --here with $label", async ({
    options,
    config,
    expectedExpression,
    expectedConversation,
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
            processId: "task:pkg",
            uid: IDENTITY.uid,
            ownerUid: IDENTITY.uid,
            activeConversationId: null,
          })),
          getOwnerUid: vi.fn(() => IDENTITY.uid),
        } as Partial<KernelContext["procs"]>,
        schedules: {
          create,
          setWakeScheduleId: vi.fn(),
        } as unknown as KernelContext["schedules"],
        scheduleScheduleWake: vi.fn(async () => "wake-expression"),
      }),
    );

    expect(result.ok).toBe(true);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      expression: expectedExpression,
      target: {
        kind: "process.event",
        pid: "task:pkg",
        conversationId: expectedConversation,
        message: "Check in.",
      },
    }));
  });

  it("rejects sched add --here from a top-level shell", async () => {
    const create = vi.fn();
    const ctx = makeContext({
      capabilities: ["sched.add", "proc.send"],
      schedules: { create } as Partial<KernelContext["schedules"]> as KernelContext["schedules"],
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
      schedules: { create } as Partial<KernelContext["schedules"]> as KernelContext["schedules"],
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
              creator: { kind: "process", uid: IDENTITY.uid, username: IDENTITY.username, pid: "task:pkg" },
              runAs: { kind: "process", uid: IDENTITY.uid, username: IDENTITY.username, pid: "task:pkg" },
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
        } as unknown as KernelContext["schedules"],
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("LAST\tERROR\tSOURCE");
    expect(result.stdout).toContain("error\tProcess not found: missing");
  });

  it("requires an explicit package for manifest inspection", async () => {
    const result = await handleShellExec(
      { input: "pkg manifest", cwd: "/src/repos/root/pkg-test" },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("packageId is required");
  });

  it("shows package source as a repo path", async () => {
    const result = await handleShellExec(
      { input: "pkg source sample-console" },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("repo: root/pkg-test");
    expect(result.stdout).toContain("path: /src/repos/root/pkg-test");
    expect(result.stderr).toBe("");
  });

  it("uses explicit --here for repo status from /src/repos", async () => {
    const result = await handleShellExec(
      { input: "rgit status --here", cwd: "/src/repos/root/pkg-test/src" },
      makeContext({ capabilities: ["repo.list"] }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("Repo: root/pkg-test");
    expect(result.stdout).toContain("No staged changes.");
    expect(result.stderr).toBe("");
  });

  it("uses the package source ref for repo log from /src/repos", async () => {
    const calls: string[] = [];
    const packageA = makePackage({
      packageId: "import:root/pkg-test:packages/a",
      manifest: {
        ...makePackage().manifest,
        name: "sample-a",
        source: {
          repo: "root/pkg-test",
          ref: "feature/a",
          subdir: "packages/a",
          resolvedCommit: "commit-a",
        },
      },
    });
    const packageB = makePackage({
      packageId: "import:root/pkg-test:packages/b",
      manifest: {
        ...makePackage().manifest,
        name: "sample-b",
        source: {
          repo: "root/pkg-test",
          ref: "feature/b",
          subdir: "packages/b",
          resolvedCommit: "commit-b",
        },
      },
    });
    const ripgit = {
      async fetch(input: RequestInfo | URL) {
        const url = new URL(String(input));
        calls.push(url.toString());
        expect(url.pathname).toBe("/hyperspace/repos/root/pkg-test/log");
        expect(url.searchParams.get("ref")).toBe("feature/b");
        return Response.json([{
          hash: "commit-b",
          tree_hash: "tree123",
          author: "Sam",
          author_email: "sam@gsv.local",
          author_time: 1,
          committer: "Sam",
          committer_email: "sam@gsv.local",
          commit_time: 1,
          message: "package update",
          parents: [],
        }]);
      },
    } as Fetcher;

    const result = await handleShellExec(
      { input: "rgit log --here", cwd: "/src/repos/root/pkg-test/packages/b/src" },
      makeContext({ capabilities: ["repo.log"], packages: [packageA, packageB], ripgit }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("commit-b");
    expect(result.stdout).toContain("package update");
    expect(result.stderr).toBe("");
    expect(calls).toHaveLength(1);
  });

  it("shows review status in pkg list output", async () => {
    const result = await handleShellExec(
      { input: "pkg list" },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("sample-console");
    expect(result.stdout).toContain("pending");
  });

  it("enables an approved package through pkg enable", async () => {
    const result = await handleShellExec(
      { input: "pkg enable sample-console" },
      makeContext({
        capabilities: ["pkg.install"],
        pkg: makePackage({
          scope: { kind: "user", uid: 1000 },
          reviewedAt: 100,
          reviewRequired: true,
        }),
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("enabled sample-console");
    expect(result.stderr).toBe("");
  });

  it("runs package commands through app runner", async () => {
    const calls: Array<{ kind: "ensure" | "run"; value: unknown }> = [];
    const runner = {
      async ensureRuntime(input: unknown) {
        calls.push({ kind: "ensure", value: input });
      },
      async runCommand(input: unknown) {
        calls.push({ kind: "run", value: input });
        return {
          stdout: "hello from runner\n",
          stderr: "",
          exitCode: 0,
        };
      },
    };

    const result = await handleShellExec(
      { input: "hello-world alpha beta" },
      makeContext({
        pkg: makePackage({
          enabled: true,
          reviewRequired: false,
          manifest: {
            ...makePackage().manifest,
            entrypoints: [
              {
                name: "Hello World",
                kind: "command",
                module: "index.js",
                exportName: "GsvCommandEntrypoint",
                command: "hello-world",
              },
            ],
          },
        }),
        getAppRunner() {
          return runner;
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("hello from runner");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.kind).toBe("ensure");
    expect(calls[1]).toEqual({
      kind: "run",
      value: {
        commandName: "hello-world",
        args: ["alpha", "beta"],
        cwd: "/home/sam",
        uid: 1000,
        gid: 1000,
        username: "sam",
      },
    });
  });

  it("registers owner-scoped package commands for agent-backed shells", async () => {
    const calls: Array<{ kind: "ensure" | "run"; value: unknown }> = [];
    const runner = {
      async ensureRuntime(input: unknown) {
        calls.push({ kind: "ensure", value: input });
      },
      async runCommand(input: unknown) {
        calls.push({ kind: "run", value: input });
        return {
          stdout: "human tool ran\n",
          stderr: "",
          exitCode: 0,
        };
      },
    };
    const humanPackage = makePackage({
      packageId: "user:1000:human-tools",
      scope: { kind: "user", uid: 1000 },
      enabled: true,
      reviewRequired: false,
      manifest: {
        ...makePackage().manifest,
        name: "human-tools",
        entrypoints: [{
          name: "Human Tool",
          kind: "command",
          module: "index.js",
          exportName: "GsvCommandEntrypoint",
          command: "human-tool",
        }],
      },
    });
    const agentPackage = makePackage({
      packageId: "user:2000:agent-tools",
      scope: { kind: "user", uid: 2000 },
      enabled: true,
      reviewRequired: false,
      manifest: {
        ...makePackage().manifest,
        name: "agent-tools",
        entrypoints: [{
          name: "Agent Tool",
          kind: "command",
          module: "index.js",
          exportName: "GsvCommandEntrypoint",
          command: "agent-tool",
        }],
      },
    });

    const result = await handleShellExec(
      { input: "human-tool alpha" },
      makeContext({
        packages: [humanPackage, agentPackage],
        identity: {
          uid: 2000,
          gid: 2000,
          gids: [2000],
          username: "sam-agent",
          home: "/home/sam-agent",
          cwd: "/home/sam-agent",
        },
        procs: {
          getOwnerUid: vi.fn(() => 1000),
        } as unknown as KernelContext["procs"],
        getAppRunner() {
          return runner;
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("human tool ran\n");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      kind: "ensure",
      value: expect.objectContaining({
        packageId: "user:1000:human-tools",
        appFrame: expect.objectContaining({
          uid: 2000,
          username: "sam-agent",
        }),
      }),
    });
    expect(calls[1]).toEqual({
      kind: "run",
      value: {
        commandName: "human-tool",
        args: ["alpha"],
        cwd: "/home/sam-agent",
        uid: 2000,
        gid: 2000,
        username: "sam-agent",
      },
    });
  });

  it("resolves current package source commands from the owning human scope", async () => {
    const humanPackage = makePackage({
      packageId: "user:1000:human-tools",
      scope: { kind: "user", uid: 1000 },
      enabled: true,
      manifest: {
        ...makePackage().manifest,
        name: "human-tools",
        entrypoints: [{ name: "Human Tool", kind: "command", command: "human-tool" }],
      },
    });
    const agentPackage = makePackage({
      packageId: "user:2000:agent-tools",
      scope: { kind: "user", uid: 2000 },
      enabled: true,
      manifest: {
        ...makePackage().manifest,
        name: "agent-tools",
        entrypoints: [{ name: "Agent Tool", kind: "command", command: "agent-tool" }],
      },
    });

    const result = await handleShellExec(
      { input: "pkg manifest human-tools" },
      makeContext({
        capabilities: ["pkg.list"],
        packages: [humanPackage, agentPackage],
        identity: {
          uid: 2000,
          gid: 2000,
          gids: [2000],
          username: "sam-agent",
          home: "/home/sam-agent",
          cwd: "/home/sam-agent",
        },
        procs: {
          getOwnerUid: vi.fn(() => 1000),
        } as unknown as KernelContext["procs"],
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('"name": "human-tools"');
    expect(result.stderr).toBe("");
  });

  it("initializes wiki databases through the native wiki command", async () => {
    const applyBodies: unknown[] = [];
    const ripgit = {
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        const url = new URL(String(input));
        if (url.pathname === "/hyperspace/repos/sam/memory/refs") {
          return Response.json({ heads: {}, tags: {} });
        }
        if (url.pathname === "/hyperspace/repos/sam/memory/read") {
          return new Response("missing", { status: 404 });
        }
        if (url.pathname === "/hyperspace/repos/sam/memory/apply") {
          const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
          applyBodies.push(body);
          return Response.json({ ok: true, head: `head-${applyBodies.length}` });
        }
        return new Response(`unexpected ${url.pathname}`, { status: 500 });
      },
    } as Fetcher;

    const result = await handleShellExec(
      { input: 'wiki db init memory --title "Sam Memory"' },
      makeContext({ capabilities: ["repo.create", "repo.apply", "repo.read"], ripgit }),
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("created /src/repos/sam/memory");
    expect(applyBodies).toHaveLength(2);
    const initBody = applyBodies[1] as {
      message?: string;
      ops?: Array<{ type?: string; path?: string; contentBytes?: number[] }>;
    };
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
    const ripgit = {
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
    } as Fetcher;

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
    const ripgit = {
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
    } as Fetcher;

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

  it("does not allow packages to shadow the wiki command", async () => {
    const calls: Array<{ kind: "ensure" | "run"; value: unknown }> = [];
    const runner = {
      async ensureRuntime(input: unknown) {
        calls.push({ kind: "ensure", value: input });
      },
      async runCommand(input: unknown) {
        calls.push({ kind: "run", value: input });
        return {
          stdout: "shadowed wiki command\n",
          stderr: "",
          exitCode: 0,
        };
      },
    };

    const result = await handleShellExec(
      { input: "wiki search auth" },
      makeContext({
        pkg: makePackage({
          enabled: true,
          reviewRequired: false,
          manifest: {
            ...makePackage().manifest,
            name: "wiki",
            entrypoints: [
              {
                name: "wiki",
                kind: "command",
                module: "index.js",
                exportName: "GsvCommandEntrypoint",
                command: "wiki",
              },
            ],
          },
        }),
        getAppRunner() {
          return runner;
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("shadowed wiki command");
    expect(calls).toHaveLength(0);
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
