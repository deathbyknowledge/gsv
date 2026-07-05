import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleShellExec } from "./shell";
import { handleFsCopy, handleFsRead, handleFsTransferReceive, handleFsTransferSend } from "./fs";
import { parseBinaryFrame } from "@humansandmachines/gsv/protocol";
import { sendFrameToProcess } from "../../shared/utils";
import type { KernelContext } from "../../kernel/context";
import type { DeviceRecord } from "../../kernel/devices";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { InstalledPackageRecord } from "../../kernel/packages";

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
  getAppRunner?: KernelContext["getAppRunner"];
  scheduleIpcCallTimeout?: KernelContext["scheduleIpcCallTimeout"];
  scheduleScheduleWake?: KernelContext["scheduleScheduleWake"];
  identity?: ProcessIdentity;
  aiRun?: (model: string, input: Record<string, unknown>) => Promise<unknown>;
  ripgit?: Fetcher;
}): KernelContext {
  const records = [...(options?.packages ?? [options?.pkg ?? makePackage()])];
  const identity = options?.identity ?? IDENTITY;
  const configValues = new Map<string, string>(Object.entries(options?.config ?? {}));
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
    auth: options?.auth ?? null as never,
    caps: options?.caps ?? null as never,
    config: {
      get(key: string) {
        if (key === "config/server/name") return "gsv";
        if (key === "config/server/version") return "0.3.2";
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
    adapters: null as never,
    runRoutes: null as never,
    schedules: options?.schedules,
    ipcCalls: options?.ipcCalls,
    connection: null as never,
    identity: {
      role: "user",
      process: identity,
      capabilities: options?.capabilities ?? ["pkg.list", "repo.refs", "repo.log"],
    },
    processId: "task:pkg",
    serverVersion: "0.3.2",
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
    expect(sourceList.ok).toBe(true);
    if (sourceList.ok) {
      expect(sourceList.directories).toContain("human-tools");
      expect(sourceList.directories).not.toContain("agent-tools");
    }

    const binList = await handleFsRead({ path: "/usr/local/bin" }, ctx);
    expect(binList.ok).toBe(true);
    if (binList.ok) {
      expect(binList.files).toContain("human-tool");
      expect(binList.files).not.toContain("agent-tool");
    }
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
      contextFiles: [],
      createdAt: 1,
    };
    const spawn = vi.fn((pid: string) => {
      spawnedPids.push(pid);
    });
    const ipcCalls = {
      create: vi.fn(),
      remove: vi.fn(),
      attachRun: vi.fn(),
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
          replyToPid: "task:pkg",
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
            runId: "child-run",
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
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("status=in_progress");
    expect(result.stdout).toContain("run_id=child-run");
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
      targetPid: spawnedPids[0],
      uid: IDENTITY.uid,
    }));
    const callId = ipcCalls.create.mock.calls[0]?.[0]?.callId;
    expect(ipcCalls.attachRun).toHaveBeenCalledWith(callId, "child-run");
    expect(scheduleIpcCallTimeout).toHaveBeenCalledWith(callId, 600_000);
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

    const sent: unknown[] = [];
    const ctx = makeContext();
    ctx.connection = {
      send(message: unknown) {
        sent.push(message);
      },
    } as never;

    const result = await handleFsTransferSend({
      path: "/home/sam/copy-test/stream-source.txt",
      streamId: 123,
    }, ctx);

    expect(result).toMatchObject({
      ok: true,
      path: "/home/sam/copy-test/stream-source.txt",
      size: "stream source".length,
      bytesSent: "stream source".length,
    });
    expect(sent).toHaveLength(2);
    const frame = parseBinaryFrame(sent[0] as ArrayBuffer);
    expect(frame).toMatchObject({ streamId: 123 });
    expect(new TextDecoder().decode(frame?.payload)).toBe("stream source");
    expect(parseBinaryFrame(sent[1] as ArrayBuffer)?.flags).toBe(2);
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
      expectedSize: 11,
      streamId: 123,
    }, makeContext(), stream);

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
      contentType: "text/plain",
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
    const frames: Array<{ flags: number; payload?: Uint8Array }> = [];

    const result = await handleFsCopy({
      source: { target: "gsv", path: "/home/sam/copy-test/device-source.txt" },
      destination: { target: "rearden", path: "/tmp/device-destination.txt" },
    }, ctx, {
      async requestDevice(deviceId, call, args) {
        expect(deviceId).toBe("rearden");
        if (call === "fs.transfer.stat") {
          throw new Error("No such file or directory: /tmp/device-destination.txt");
        }
        throw new Error(`unexpected call ${call}`);
      },
      allocateBinaryStreamId() {
        return 99;
      },
      async startDeviceRequest(deviceId, call, args) {
        expect(deviceId).toBe("rearden");
        expect(call).toBe("fs.transfer.receive");
        expect(args).toMatchObject({
          path: "/tmp/device-destination.txt",
          streamId: 99,
          expectedSize: "to device".length,
        });
        return {
          requestId: "receive-1",
          promise: Promise.resolve({ ok: true, path: "/tmp/device-destination.txt", bytesWritten: "to device".length }),
          cancel: vi.fn(),
        };
      },
      registerBinaryRelay: vi.fn(),
      receiveDeviceBinaryStream: vi.fn(),
      sendDeviceBinaryFrame(deviceId, streamId, flags, payload) {
        expect(deviceId).toBe("rearden");
        expect(streamId).toBe(99);
        frames.push({ flags, payload });
      },
    });

    expect(result).toMatchObject({
      ok: true,
      size: "to device".length,
      destination: { target: "rearden", path: "/tmp/device-destination.txt" },
    });
    const payload = frames
      .filter((frame) => (frame.flags & 1) !== 0)
      .map((frame) => new TextDecoder().decode(frame.payload))
      .join("");
    expect(payload).toBe("to device");
    expect(frames.at(-1)?.flags).toBe(2);
  });

  it("cleans up device receives when gsv-to-device send fails", async () => {
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
    const cancelReceive = vi.fn();
    const sendDeviceBinaryFrame = vi.fn(() => {
      throw new Error("destination disconnected");
    });

    const result = await handleFsCopy({
      source: { target: "gsv", path: "/home/sam/copy-test/device-send-fail.txt" },
      destination: { target: "rearden", path: "/tmp/device-destination.txt" },
    }, ctx, {
      async requestDevice(deviceId, call) {
        expect(deviceId).toBe("rearden");
        if (call === "fs.transfer.stat") {
          return { ok: false, error: "not found" };
        }
        throw new Error(`unexpected call ${call}`);
      },
      allocateBinaryStreamId() {
        return 103;
      },
      async startDeviceRequest(deviceId, call) {
        expect(deviceId).toBe("rearden");
        expect(call).toBe("fs.transfer.receive");
        return {
          requestId: "receive-send-fail",
          promise: new Promise(() => {}),
          cancel: cancelReceive,
        };
      },
      registerBinaryRelay: vi.fn(),
      receiveDeviceBinaryStream: vi.fn(),
      sendDeviceBinaryFrame,
    });

    expect(result).toMatchObject({ ok: false, error: "destination disconnected" });
    expect(sendDeviceBinaryFrame).toHaveBeenCalledTimes(2);
    expect(cancelReceive).toHaveBeenCalledOnce();
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
      async requestDevice(deviceId, call) {
        expect(deviceId).toBe("rearden");
        if (call === "fs.transfer.stat") {
          return { ok: true, path: "/tmp/source.txt", size: 11, isFile: true, isDirectory: false, contentType: "text/plain" };
        }
        throw new Error(`unexpected call ${call}`);
      },
      allocateBinaryStreamId() {
        return 100;
      },
      async startDeviceRequest(deviceId, call, args) {
        expect(deviceId).toBe("rearden");
        expect(call).toBe("fs.transfer.send");
        expect(args).toMatchObject({ path: "/tmp/source.txt", streamId: 100 });
        return {
          requestId: "send-1",
          promise: Promise.resolve({ ok: true, path: "/tmp/source.txt", size: 11, bytesSent: 11 }),
          cancel: vi.fn(),
        };
      },
      registerBinaryRelay: vi.fn(),
      receiveDeviceBinaryStream(route) {
        expect(route).toMatchObject({
          streamId: 100,
          sourceDeviceId: "rearden",
        });
        return {
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("hello world"));
              controller.close();
            },
          }),
          cancel: vi.fn(),
        };
      },
      sendDeviceBinaryFrame: vi.fn(),
    });

    expect(result).toMatchObject({
      ok: true,
      size: 11,
      source: { target: "rearden", path: "/tmp/source.txt" },
    });
    expect(await (await env.STORAGE.get(destinationKey))?.text()).toBe("hello world");
  });

  it("cleans up native receive streams when device send setup fails", async () => {
    const ctx = makeContext() as KernelContext;
    ctx.devices = {
      canAccess: vi.fn(() => true),
      canHandle: vi.fn(() => true),
    } as never;
    const cancelReceive = vi.fn();

    const result = await handleFsCopy({
      source: { target: "rearden", path: "/tmp/source.txt" },
      destination: { target: "gsv", path: "/home/sam/copy-test/from-device-fail.txt" },
    }, ctx, {
      async requestDevice(deviceId, call) {
        expect(deviceId).toBe("rearden");
        if (call === "fs.transfer.stat") {
          return { ok: true, path: "/tmp/source.txt", size: 11, isFile: true, isDirectory: false, contentType: "text/plain" };
        }
        throw new Error(`unexpected call ${call}`);
      },
      allocateBinaryStreamId() {
        return 101;
      },
      async startDeviceRequest() {
        throw new Error("source disconnected");
      },
      registerBinaryRelay: vi.fn(),
      receiveDeviceBinaryStream: vi.fn(() => ({
        stream: new ReadableStream<Uint8Array>(),
        cancel: cancelReceive,
      })),
      sendDeviceBinaryFrame: vi.fn(),
    });

    expect(result).toMatchObject({ ok: false, error: "source disconnected" });
    expect(cancelReceive).toHaveBeenCalledOnce();
  });

  it("cleans up device relay state when source send setup fails", async () => {
    const ctx = makeContext() as KernelContext;
    ctx.devices = {
      canAccess: vi.fn(() => true),
      canHandle: vi.fn(() => true),
    } as never;
    const cancelReceive = vi.fn();
    const cancelRelay = vi.fn();
    const sendErrorFrame = vi.fn();

    const result = await handleFsCopy({
      source: { target: "rearden", path: "/tmp/source.txt" },
      destination: { target: "browser", path: "/tmp/destination.txt" },
    }, ctx, {
      async requestDevice(deviceId, call) {
        if (call === "fs.transfer.stat" && deviceId === "browser") {
          return { ok: false, error: "not found" };
        }
        if (call === "fs.transfer.stat" && deviceId === "rearden") {
          return { ok: true, path: "/tmp/source.txt", size: 11, isFile: true, isDirectory: false, contentType: "text/plain" };
        }
        throw new Error(`unexpected call ${call}`);
      },
      allocateBinaryStreamId() {
        return 102;
      },
      async startDeviceRequest(deviceId, call) {
        if (deviceId === "browser" && call === "fs.transfer.receive") {
          return {
            requestId: "receive-2",
            promise: new Promise(() => {}),
            cancel: cancelReceive,
          };
        }
        throw new Error("source route failed");
      },
      registerBinaryRelay: vi.fn(() => ({ cancel: cancelRelay })),
      receiveDeviceBinaryStream: vi.fn(),
      sendDeviceBinaryFrame: sendErrorFrame,
    });

    expect(result).toMatchObject({ ok: false, error: "source route failed" });
    expect(cancelRelay).toHaveBeenCalledOnce();
    expect(cancelReceive).toHaveBeenCalledOnce();
    expect(sendErrorFrame).toHaveBeenCalledWith(
      "browser",
      102,
      6,
      expect.any(Uint8Array),
    );
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
    expect(callMcpTool).toHaveBeenCalledWith("server-1", "lookup", { query: "gsv" });
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
});
