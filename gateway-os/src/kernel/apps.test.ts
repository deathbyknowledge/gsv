import { describe, expect, it, vi } from "vitest";
import {
  executeShellAppCommand,
  listShellAppCommands,
  openAppSession,
  type AppPackageManifest,
  type AppRuntimeSpec,
} from "./apps";
import type { KernelContext } from "./context";
import type { ProcessRecord } from "./processes";
import type { WorkspaceRecord } from "./workspaces";

function makeProcess(overrides: Partial<ProcessRecord> = {}): ProcessRecord {
  return {
    processId: "task:alpha",
    parentPid: "init:1000",
    uid: 1000,
    profile: "task",
    gid: 100,
    gids: [100],
    username: "hank",
    home: "/home/hank",
    cwd: "/workspaces/ws_alpha",
    workspaceId: "ws_alpha",
    state: "running",
    label: "alpha",
    createdAt: 1,
    ...overrides,
  };
}

function makeWorkspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    workspaceId: "ws_alpha",
    ownerUid: 1000,
    label: "alpha",
    kind: "thread",
    state: "active",
    createdAt: 1,
    updatedAt: 2,
    defaultBranch: "main",
    headCommit: null,
    metaJson: null,
    ...overrides,
  };
}

function makeContext(options?: {
  uid?: number;
  processes?: ProcessRecord[];
  workspaces?: WorkspaceRecord[];
  env?: Record<string, unknown>;
  runtime?: KernelContext["runtime"];
}): KernelContext & {
  workspaces: {
    get: ReturnType<typeof vi.fn>;
    touch: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
} {
  const uid = options?.uid ?? 1000;
  const processMap = new Map((options?.processes ?? []).map((process) => [process.processId, process]));
  const workspaceMap = new Map((options?.workspaces ?? []).map((workspace) => [workspace.workspaceId, workspace]));

  const create = vi.fn((ownerUid: number, createOptions?: { label?: string; kind?: "thread" | "app" | "shared"; metaJson?: string | null }) => {
    const record = makeWorkspace({
      workspaceId: "ws_created",
      ownerUid,
      label: createOptions?.label ?? "created",
      kind: createOptions?.kind ?? "app",
      metaJson: createOptions?.metaJson ?? null,
    });
    workspaceMap.set(record.workspaceId, record);
    return record;
  });

  const workspaces = {
    get: vi.fn((workspaceId: string) => workspaceMap.get(workspaceId) ?? null),
    touch: vi.fn((workspaceId: string) => workspaceMap.has(workspaceId)),
    create,
  };

  return {
    env: (options?.env ?? {}) as Env,
    runtime: options?.runtime,
    identity: {
      role: "user",
      process: {
        uid,
        gid: 100,
        gids: [100],
        username: uid === 0 ? "root" : "hank",
        home: uid === 0 ? "/root" : "/home/hank",
        cwd: uid === 0 ? "/root" : "/home/hank",
        workspaceId: null,
      },
      capabilities: ["*"],
    },
    procs: {
      get: vi.fn((processId: string) => processMap.get(processId) ?? null),
    } as unknown as KernelContext["procs"],
    workspaces: workspaces as unknown as KernelContext["workspaces"],
  } as KernelContext & {
    workspaces: {
      get: ReturnType<typeof vi.fn>;
      touch: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
  };
}

function makeRuntimeStubs() {
  const appBackendSyscall = vi.fn();
  const kernelGet = vi.fn(() => ({
    appBackendSyscall,
  }));
  const appKernelBinding = vi.fn(() => "kernel-binding-stub");

  return {
    runtime: {
      exports: {
        AppKernelBinding: appKernelBinding,
        Kernel: {
          get: kernelGet,
        },
      } as unknown as Cloudflare.Exports,
      kernelId: { toString: () => "kernel-id" } as DurableObjectId,
    } satisfies NonNullable<KernelContext["runtime"]>,
    appBackendSyscall,
    kernelGet,
    appKernelBinding,
  };
}

describe("openAppSession", () => {
  it("binds a host session to the requested thread workspace", () => {
    const process = makeProcess();
    const workspace = makeWorkspace();
    const ctx = makeContext({
      processes: [process],
      workspaces: [workspace],
    });

    const result = openAppSession(
      {
        appId: "files",
        host: {
          kind: "window",
          instanceId: "win-1",
        },
        target: {
          thread: {
            pid: process.processId,
            cwd: "/tmp/ignored-by-kernel",
          },
        },
      },
      ctx,
    );

    expect(result.session.host).toEqual({
      kind: "window",
      instanceId: "win-1",
    });
    expect(result.session.surface).toEqual({
      kind: "renderer",
      name: "desktop",
    });
    expect(result.session.thread).toEqual({
      pid: "task:alpha",
      cwd: "/workspaces/ws_alpha",
      workspaceId: "ws_alpha",
    });
    expect(result.session.workspace).toEqual({
      workspaceId: "ws_alpha",
      root: "/workspaces/ws_alpha",
      cwd: "/workspaces/ws_alpha",
      kind: "thread",
      ownerUid: 1000,
    });
    expect(ctx.workspaces.touch).toHaveBeenCalledWith("ws_alpha");
    expect(result.session.backend.kind).toBe("none");
  });

  it("rejects binding to a foreign thread", () => {
    const ctx = makeContext({
      processes: [makeProcess({ processId: "task:foreign", uid: 2000 })],
    });

    expect(() =>
      openAppSession(
        {
          appId: "chat",
          host: {
            kind: "window",
            instanceId: "win-2",
          },
          target: { thread: { pid: "task:foreign" } },
        },
        ctx,
      )).toThrow("Permission denied: cannot bind app to foreign process task:foreign");
  });

  it("creates an app workspace and resolves a dynamic worker backend descriptor", () => {
    const registry: Record<string, AppRuntimeSpec> = {
      firewall: {
        appId: "firewall",
        name: "Firewall",
        description: "runtime test manifest",
        thread: "none",
        workspace: {
          mode: "new-app",
          kind: "app",
          label: "Firewall Workspace",
        },
        backend: {
          kind: "dynamic-worker",
          workerName: "firewall-backend",
          entrypoint: "FirewallBackend",
          lifecycle: "workspace",
          network: "none",
          bindings: [
            { kind: "kernel", syscalls: ["proc.spawn", "proc.send", "proc.send"] },
            { kind: "workspace", access: "read-write" },
            { kind: "service", binding: "RIPGIT", capability: "ripgit.internal" },
          ],
        },
        renderers: [
          { name: "desktop", hosts: ["window"] },
        ],
      },
    };

    const ctx = makeContext({
      env: {
        RIPGIT: {} as Fetcher,
      },
    });

    const result = openAppSession(
      {
        appId: "firewall",
        host: {
          kind: "window",
          instanceId: "win-3",
        },
        surface: {
          kind: "renderer",
          name: "desktop",
        },
      },
      ctx,
      registry,
    );

    expect(ctx.workspaces.create).toHaveBeenCalledWith(
      1000,
      expect.objectContaining({
        kind: "app",
        label: "Firewall Workspace",
      }),
    );
    expect(result.session.workspace?.workspaceId).toBe("ws_created");
    expect(result.session.workspace?.kind).toBe("app");
    expect(result.session.backend.kind).toBe("dynamic-worker");

    if (result.session.backend.kind !== "dynamic-worker") {
      throw new Error("expected dynamic worker backend");
    }

    expect(result.session.backend.state).toBe("missing_loader");
    expect(result.session.backend.instanceKey).toBe("app:firewall:workspace:ws_created");
    expect(result.session.backend.bindings).toEqual([
      { kind: "kernel", syscalls: ["proc.spawn", "proc.send"] },
      {
        kind: "workspace",
        access: "read-write",
        workspace: {
          workspaceId: "ws_created",
          root: "/workspaces/ws_created",
          cwd: "/workspaces/ws_created",
          kind: "app",
          ownerUid: 1000,
        },
      },
      {
        kind: "service",
        binding: "RIPGIT",
        capability: "ripgit.internal",
        status: "configured",
      },
    ]);
  });

  it("rejects required backend bindings that are not configured", () => {
    const registry: Record<string, AppRuntimeSpec> = {
      bridge: {
        appId: "bridge",
        name: "Bridge",
        description: "runtime test manifest",
        thread: "none",
        workspace: { mode: "none" },
        backend: {
          kind: "dynamic-worker",
          workerName: "bridge-backend",
          lifecycle: "shared",
          network: "gateway",
          bindings: [
            { kind: "service", binding: "KNOWLEDGE", capability: "knowledge.query" },
          ],
        },
        commands: [
          {
            name: "bridge",
            binaryName: "bridge",
            description: "bridge command",
          },
        ],
      },
    };

    const ctx = makeContext();

    expect(() =>
      openAppSession(
        {
          appId: "bridge",
          host: {
            kind: "shell",
            instanceId: "bridge",
          },
          surface: {
            kind: "command",
            name: "bridge",
          },
        },
        ctx,
        registry,
      )).toThrow('App "bridge" backend requires binding "KNOWLEDGE"');
  });

  it("inherits the current workspace for shell-hosted package commands", () => {
    const workspace = makeWorkspace();
    const ctx = makeContext({
      workspaces: [workspace],
    });
    ctx.identity!.process.cwd = "/workspaces/ws_alpha";
    ctx.identity!.process.workspaceId = "ws_alpha";

    const result = openAppSession(
      {
        appId: "workspace-doctor",
        host: {
          kind: "shell",
          instanceId: "doctor",
        },
        surface: {
          kind: "command",
          name: "doctor",
        },
      },
      ctx,
    );

    expect(result.session.host).toEqual({
      kind: "shell",
      instanceId: "doctor",
    });
    expect(result.session.surface).toEqual({
      kind: "command",
      name: "doctor",
    });
    expect(result.session.workspace?.workspaceId).toBe("ws_alpha");
    expect(result.session.backend.kind).toBe("dynamic-worker");
  });
});

describe("package shell commands", () => {
  it("lists the example package binaries", () => {
    expect(listShellAppCommands().map((item) => item.command.binaryName)).toEqual(["deploy", "doctor"]);
  });

  it("renders manifest-driven help for package commands", async () => {
    const workspace = makeWorkspace();
    const ctx = makeContext({
      workspaces: [workspace],
    });
    ctx.identity!.process.cwd = "/workspaces/ws_alpha";
    ctx.identity!.process.workspaceId = "ws_alpha";

    const result = await executeShellAppCommand("doctor", ["--help"], ctx);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("doctor - Scan, explain, and repair workspace issues.");
    expect(result.stdout).toContain("package: workspace-doctor");
    expect(result.stdout).toContain("workspace: ws_alpha");
  });

  it("dispatches package commands through the Dynamic Worker loader", async () => {
    const workspace = makeWorkspace();
    const runtime = makeRuntimeStubs();
    const execCommand = vi.fn(async () => ({
      stdout: "doctor scan ok\n",
      stderr: "",
      exitCode: 0,
    }));
    const getEntrypoint = vi.fn(() => ({
      execCommand,
    }));
    const get = vi.fn((name: string, getCode: () => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>) => ({
      name,
      getCode,
      getEntrypoint,
    }));
    const ctx = makeContext({
      workspaces: [workspace],
      env: {
        APP_BACKENDS: {
          get,
        } as unknown as WorkerLoader,
      },
      runtime: runtime.runtime,
    });
    ctx.identity!.process.cwd = "/workspaces/ws_alpha";
    ctx.identity!.process.workspaceId = "ws_alpha";

    const result = await executeShellAppCommand("doctor", ["scan", "src"], ctx);

    expect(result).toEqual({
      stdout: "doctor scan ok\n",
      stderr: "",
      exitCode: 0,
    });
    expect(get).toHaveBeenCalledWith(
      "workspace-doctor-backend@app:workspace-doctor:workspace:ws_alpha",
      expect.any(Function),
    );

    const getCode = get.mock.calls[0]?.[1];
    const code = await getCode();
    expect(code.mainModule).toBe("index.js");
    expect(code.globalOutbound).toBeNull();
    expect(code.env).toEqual({
      KERNEL: "kernel-binding-stub",
    });
    expect(code.modules["index.js"]).toEqual(
      expect.objectContaining({
        js: expect.stringContaining("export class WorkspaceDoctor extends WorkerEntrypoint"),
      }),
    );
    expect(runtime.kernelGet).toHaveBeenCalled();
    expect(runtime.appKernelBinding).toHaveBeenCalledWith({
      props: expect.objectContaining({
        session: expect.objectContaining({
          appId: "workspace-doctor",
        }),
        allowedSyscalls: ["fs.read", "fs.search", "shell.exec"],
        kernel: expect.objectContaining({
          appBackendSyscall: expect.any(Function),
        }),
      }),
    });

    expect(getEntrypoint).toHaveBeenCalledWith(
      "WorkspaceDoctor",
      {
        props: expect.objectContaining({
          session: expect.objectContaining({
            appId: "workspace-doctor",
            host: {
              kind: "shell",
              instanceId: "doctor",
            },
            surface: {
              kind: "command",
              name: "doctor",
            },
          }),
        }),
      },
    );
    expect(execCommand).toHaveBeenCalledWith({
      command: {
        name: "doctor",
        binaryName: "doctor",
        argv: ["scan", "src"],
      },
    });
  });

  it("inherits workspace context from the live shell cwd", async () => {
    const workspace = makeWorkspace();
    const runtime = makeRuntimeStubs();
    const execCommand = vi.fn(async () => ({
      stdout: "doctor scan ok\n",
      stderr: "",
      exitCode: 0,
    }));
    const getEntrypoint = vi.fn(() => ({
      execCommand,
    }));
    const get = vi.fn(() => ({
      getEntrypoint,
    }));
    const ctx = makeContext({
      uid: 0,
      workspaces: [workspace],
      env: {
        APP_BACKENDS: {
          get,
        } as unknown as WorkerLoader,
      },
      runtime: runtime.runtime,
    });

    const result = await executeShellAppCommand(
      "doctor",
      ["scan"],
      ctx,
      {
        cwd: "/workspaces/ws_alpha/src/runtime",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(get).toHaveBeenCalledWith(
      "workspace-doctor-backend@app:workspace-doctor:workspace:ws_alpha",
      expect.any(Function),
    );
    expect(getEntrypoint).toHaveBeenCalledWith(
      "WorkspaceDoctor",
      {
        props: expect.objectContaining({
          session: expect.objectContaining({
            workspace: expect.objectContaining({
              workspaceId: "ws_alpha",
              cwd: "/workspaces/ws_alpha/src/runtime",
            }),
          }),
        }),
      },
    );
  });
});
