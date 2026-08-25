import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  BINARY_FRAME_DATA,
  BINARY_FRAME_END,
  bodyFromText,
  bodyToText,
  buildBinaryFrame,
  parseBinaryFrame,
} from "@humansandmachines/gsv/protocol";
import {
  AppRunner,
  AppSocketBodyTransport,
  GsvApiBinding,
  appRunnerWorkerCodeKey,
  isAppSessionCurrent,
  requestAppKernelFrame,
  type AppRunnerProps,
} from "./app-runner";
import { Kernel } from "./kernel/do";
import {
  artifactMetadataFromArtifact,
  computePackageArtifactHash,
  storePackageArtifact,
  type PackageArtifact,
} from "./kernel/packages";

type AppRunnerTestEnv = Env & {
  APP_RUNNER: DurableObjectNamespace<AppRunner>;
};

function activeRunnerProps(kernelName: string): AppRunnerProps {
  const now = Date.now();
  return {
    kernelName,
    packageId: "pkg-chat",
    packageName: "chat",
    routeBase: "/apps/chat",
    entrypointName: "main",
    artifact: {
      hash: "sha256:chat-v1",
      mainModule: "index.js",
      modulePaths: ["index.js"],
      runtimeAccess: {
        daemon: { rpcSchedules: true },
      },
    },
    appFrame: {
      uid: 1000,
      username: "alice",
      packageId: "pkg-chat",
      packageName: "chat",
      packageUpdatedAt: now - 1_000,
      packageArtifactHash: "sha256:chat-v1",
      entrypointName: "main",
      routeBase: "/apps/chat",
      issuedAt: now,
      expiresAt: now + 5 * 60_000,
    },
  };
}

function preSplitRunnerProps(props: AppRunnerProps) {
  const artifact = { ...props.artifact };
  delete artifact.runtimeAccess;
  return {
    packageId: props.packageId,
    packageName: props.packageName,
    routeBase: props.routeBase,
    entrypointName: props.entrypointName,
    artifact,
    appFrame: {
      uid: props.appFrame.uid,
      username: props.appFrame.username,
      packageId: props.appFrame.packageId,
      packageName: props.appFrame.packageName,
      entrypointName: props.appFrame.entrypointName,
      routeBase: props.appFrame.routeBase,
      issuedAt: props.appFrame.issuedAt,
      expiresAt: props.appFrame.expiresAt,
    },
  };
}

function appRunner(name: string): DurableObjectStub<AppRunner> {
  return (env as AppRunnerTestEnv).APP_RUNNER.getByName(name);
}

function baseProps(runtimeAccess?: Parameters<typeof appRunnerWorkerCodeKey>[0]["artifact"]["runtimeAccess"]) {
  return {
    appFrame: {
      uid: 1000,
      packageName: "chat",
      packageUpdatedAt: 1234,
      entrypointName: "main",
      routeBase: "/chat",
    },
    packageId: "pkg-chat",
    artifact: {
      hash: "sha256:abc123",
      ...(runtimeAccess ? { runtimeAccess } : {}),
    },
  };
}

function cancellableBody() {
  const cancel = vi.fn();
  return {
    body: {
      stream: new ReadableStream<Uint8Array>({ cancel }),
      length: 1,
    },
    cancel,
  };
}

describe("appRunnerWorkerCodeKey", () => {
  it("changes when package runtime access changes", () => {
    const denied = appRunnerWorkerCodeKey(baseProps({ egress: { mode: "none" } }));
    const allowed = appRunnerWorkerCodeKey(baseProps({
      egress: { mode: "allowlist", allow: ["api.example.com"] },
    }));

    expect(allowed).not.toBe(denied);
  });

  it("normalizes runtime access object key order", () => {
    const first = appRunnerWorkerCodeKey(baseProps({
      egress: { mode: "none" },
      daemon: { rpcSchedules: true },
      storage: { sql: true },
    }));
    const second = appRunnerWorkerCodeKey(baseProps({
      storage: { sql: true },
      daemon: { rpcSchedules: true },
      egress: { mode: "none" },
    }));

    expect(second).toBe(first);
  });

  it("isolates code caches by actor, package, and artifact", () => {
    const baseline = baseProps();

    expect(appRunnerWorkerCodeKey({
      ...baseline,
      appFrame: { ...baseline.appFrame, uid: 1001 },
    })).not.toBe(appRunnerWorkerCodeKey(baseline));
    expect(appRunnerWorkerCodeKey({
      ...baseline,
      packageId: "pkg-other",
    })).not.toBe(appRunnerWorkerCodeKey(baseline));
    expect(appRunnerWorkerCodeKey({
      ...baseline,
      artifact: { hash: "sha256:def456" },
    })).not.toBe(appRunnerWorkerCodeKey(baseline));
    expect(appRunnerWorkerCodeKey({
      ...baseline,
      appFrame: { ...baseline.appFrame, entrypointName: "settings" },
    })).not.toBe(appRunnerWorkerCodeKey(baseline));
  });
});

describe("AppRunner app sessions", () => {
  it("accepts only sessions whose expiry is still in the future", () => {
    expect(isAppSessionCurrent({ expiresAt: 10_001 }, 10_000)).toBe(true);
    expect(isAppSessionCurrent({ expiresAt: 10_000 }, 10_000)).toBe(false);
    expect(isAppSessionCurrent({ expiresAt: Number.NaN }, 10_000)).toBe(false);
  });

  it("closes singleton-bound sockets before rebinding preserved state to a user Kernel", async () => {
    const runner = appRunner("rebind-singleton-runtime");
    const singletonProps = activeRunnerProps("singleton");
    const userProps = {
      ...singletonProps,
      kernelName: "user:alice",
    };
    const legacyProps = preSplitRunnerProps(singletonProps);

    await runInDurableObject(runner, async (instance: AppRunner, state) => {
      const [, server] = Object.values(new WebSocketPair());
      state.acceptWebSocket(server, ["app-client"]);
      server.serializeAttachment({
        kind: "app-client",
        connected: true,
        session: {
          sessionId: "session-1",
          clientId: "client-1",
          rpcBase: "/apps/chat/rpc",
          expiresAt: Date.now() + 60_000,
        },
        appFrame: legacyProps.appFrame,
        connectedAt: Date.now(),
      });

      state.storage.kv.put("app-runner:props", legacyProps);
      await instance.ensureRuntime(userProps);

      expect(server.deserializeAttachment()).toEqual({
        kind: "app-client",
        connected: false,
      });
      expect(state.storage.kv.get<AppRunnerProps>("app-runner:props")?.kernelName)
        .toBe("user:alice");
    });
  });

  it("does not interpret a malformed current record as pre-split state", async () => {
    const runner = appRunner("reject-malformed-current-runtime");
    const current = activeRunnerProps("user:alice");
    const malformed = structuredClone(current) as Omit<AppRunnerProps, "appFrame"> & {
      appFrame: Partial<AppRunnerProps["appFrame"]>;
    };
    delete malformed.appFrame.packageUpdatedAt;

    await runInDurableObject(runner, async (instance: AppRunner, state) => {
      state.storage.kv.put("app-runner:props", malformed);
      await expect(instance.ensureRuntime(current))
        .rejects.toThrow("AppRunner props are incomplete or inconsistent");
    });
  });

  it("rejects an explicit singleton binding as malformed current state", async () => {
    const runner = appRunner("reject-explicit-singleton-runtime");

    await runInDurableObject(runner, async (instance: AppRunner) => {
      await expect(instance.ensureRuntime(activeRunnerProps("singleton")))
        .rejects.toThrow("AppRunner props are incomplete or inconsistent");
    });
  });
});

describe("AppRunner daemon authorization", () => {
  it("refreshes and runs a genuine pre-split daemon on its first alarm", async () => {
    const runner = appRunner("daemon-singleton-rebind");
    const scheduleKey = "chat:preserved-refresh";
    const candidate: PackageArtifact = {
      hash: `sha256:${"0".repeat(64)}`,
      mainModule: "index.js",
      modules: [{
        path: "index.js",
        kind: "esm",
        content: [
          'import { WorkerEntrypoint } from "cloudflare:workers";',
          "export class GsvAppRpcEntrypoint extends WorkerEntrypoint {",
          "  async invoke(method) {",
          '    if (method !== "refresh") throw new Error("unexpected method");',
          "    return { ok: true };",
          "  }",
          "}",
        ].join("\n"),
      }],
    };
    const artifact = {
      ...candidate,
      hash: await computePackageArtifactHash(candidate),
    };
    await storePackageArtifact(env.STORAGE, artifact);
    const props = activeRunnerProps("user:alice");
    props.artifact = {
      ...artifactMetadataFromArtifact(artifact),
      runtimeAccess: { daemon: { rpcSchedules: true } },
    };
    props.appFrame.packageArtifactHash = artifact.hash;
    const legacyProps = preSplitRunnerProps(props);
    await runInDurableObject(runner, async (_instance: AppRunner, state) => {
      state.storage.kv.put("app-runner:props", legacyProps);
    });
    await runner.upsertRpcSchedule({
      key: scheduleKey,
      rpcMethod: "refresh",
      schedule: { kind: "every", everyMs: 60_000 },
    });
    await runInDurableObject(runner, async (instance: AppRunner, state) => {
      Object.defineProperty((instance as any).ctx, "exports", {
        configurable: true,
        value: {
          GsvApiBinding: () => ({}),
        },
      });
      state.storage.sql.exec(
        "UPDATE app_rpc_schedules SET next_run_at = ? WHERE schedule_key = ?",
        1,
        scheduleKey,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    const route = vi.spyOn(Kernel.prototype as any, "resolvePreservedAppRuntimeRoute")
      .mockResolvedValue({ ok: true, kernelName: "user:alice" });
    const refresh = vi.spyOn(Kernel.prototype as any, "refreshPreservedAppRuntime")
      .mockResolvedValue({ ok: true, props });
    const authorize = vi.spyOn(Kernel.prototype as any, "authorizeAppDaemonFrame")
      .mockResolvedValue(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await runDurableObjectAlarm(runner)).toBe(true);
      expect(route).toHaveBeenCalledWith({ uid: 1000, username: "alice" });
      expect(refresh).toHaveBeenCalledWith({
        uid: 1000,
        username: "alice",
        packageId: "pkg-chat",
        packageName: "chat",
        entrypointName: "main",
        routeBase: "/apps/chat",
      });
      expect(authorize).toHaveBeenCalledOnce();
      expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
        packageUpdatedAt: props.appFrame.packageUpdatedAt,
        packageArtifactHash: artifact.hash,
      }));
    } finally {
      warn.mockRestore();
      authorize.mockRestore();
      refresh.mockRestore();
      route.mockRestore();
    }

    await runInDurableObject(runner, async (_instance: AppRunner, state) => {
      expect(state.storage.kv.get<AppRunnerProps>("app-runner:props")?.kernelName)
        .toBe("user:alice");
    });
    expect(await runner.listRpcSchedules()).toEqual([
      expect.objectContaining({
        key: scheduleKey,
        enabled: true,
        lastStatus: "ok",
        nextRunAt: expect.any(Number),
      }),
    ]);
  });

  it("routes a preserved personal-agent runtime through its controlling human Kernel", async () => {
    const runner = appRunner("daemon-personal-agent-rebind");
    const scheduleKey = "chat:agent-refresh";
    const props = activeRunnerProps("user:alice");
    props.appFrame.uid = 2000;
    props.appFrame.username = "aria";
    await runInDurableObject(runner, async (_instance: AppRunner, state) => {
      state.storage.kv.put("app-runner:props", preSplitRunnerProps(props));
    });
    await runner.upsertRpcSchedule({
      key: scheduleKey,
      rpcMethod: "refresh",
      schedule: { kind: "every", everyMs: 60_000 },
    });
    await runInDurableObject(runner, async (_instance: AppRunner, state) => {
      state.storage.sql.exec(
        "UPDATE app_rpc_schedules SET next_run_at = ? WHERE schedule_key = ?",
        1,
        scheduleKey,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    const route = vi.spyOn(Kernel.prototype as any, "resolvePreservedAppRuntimeRoute")
      .mockResolvedValue({ ok: true, kernelName: "user:alice" });
    const refresh = vi.spyOn(Kernel.prototype as any, "refreshPreservedAppRuntime")
      .mockResolvedValue({ ok: true, props });
    const authorize = vi.spyOn(Kernel.prototype as any, "authorizeAppDaemonFrame")
      .mockResolvedValue(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await runDurableObjectAlarm(runner)).toBe(true);
      expect(route).toHaveBeenCalledWith({ uid: 2000, username: "aria" });
      expect(refresh).toHaveBeenCalledWith(expect.objectContaining({
        uid: 2000,
        username: "aria",
      }));
      expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
        uid: 2000,
        username: "aria",
      }));
    } finally {
      warn.mockRestore();
      authorize.mockRestore();
      refresh.mockRestore();
      route.mockRestore();
    }

    await runInDurableObject(runner, async (_instance: AppRunner, state) => {
      expect(state.storage.kv.get<AppRunnerProps>("app-runner:props"))
        .toMatchObject({
          kernelName: "user:alice",
          appFrame: { uid: 2000, username: "aria" },
        });
    });
  });

  it("retries a preserved daemon after transient placement provisioning fails", async () => {
    const runner = appRunner("daemon-transient-placement");
    const scheduleKey = "chat:placement-retry";
    const current = activeRunnerProps("user:alice");
    const { kernelName: _kernelName, ...unbound } = current;
    await runInDurableObject(runner, async (_instance: AppRunner, state) => {
      state.storage.kv.put("app-runner:props", unbound);
    });
    await runner.upsertRpcSchedule({
      key: scheduleKey,
      rpcMethod: "refresh",
      schedule: { kind: "every", everyMs: 60_000 },
    });
    await runInDurableObject(runner, async (_instance: AppRunner, state) => {
      state.storage.sql.exec(
        "UPDATE app_rpc_schedules SET next_run_at = ? WHERE schedule_key = ?",
        1,
        scheduleKey,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    const route = vi.spyOn(Kernel.prototype as any, "resolvePreservedAppRuntimeRoute")
      .mockResolvedValue({ ok: false });
    const authorize = vi.spyOn(Kernel.prototype as any, "authorizeAppDaemonFrame");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await runDurableObjectAlarm(runner)).toBe(true);
      expect(route).toHaveBeenCalledWith({ uid: 1000, username: "alice" });
      expect(authorize).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      authorize.mockRestore();
      route.mockRestore();
    }

    expect(await runner.listRpcSchedules()).toEqual([
      expect.objectContaining({
        key: scheduleKey,
        enabled: true,
        lastStatus: "error",
        lastError: "Package runtime placement is unavailable",
        nextRunAt: expect.any(Number),
      }),
    ]);
  });

  it("disables a due schedule before package code when current authorization fails", async () => {
    const runner = appRunner("daemon-runtime-authorization");
    const scheduleKey = "chat:refresh";
    await runner.ensureRuntime(activeRunnerProps("user:alice"));
    await runner.upsertRpcSchedule({
      key: scheduleKey,
      rpcMethod: "refresh",
      schedule: { kind: "every", everyMs: 60_000 },
    });
    await runInDurableObject(runner, async (_instance: AppRunner, state) => {
      state.storage.sql.exec(
        "UPDATE app_rpc_schedules SET next_run_at = ? WHERE schedule_key = ?",
        1,
        scheduleKey,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await runDurableObjectAlarm(runner)).toBe(true);
    } finally {
      warn.mockRestore();
    }

    expect(await runner.listRpcSchedules()).toEqual([
      expect.objectContaining({
        key: scheduleKey,
        enabled: false,
        nextRunAt: null,
        lastStatus: "error",
        lastError: "Package runtime authorization expired",
      }),
    ]);
  });
});

describe("GSV API runtime authority", () => {
  const authorized = {
    uid: 1000,
    username: "alice",
    packageId: "pkg-chat",
    packageName: "chat",
    packageUpdatedAt: 1234,
    packageArtifactHash: "sha256:abc123",
    entrypointName: "main",
    routeBase: "/chat",
    issuedAt: 10_000,
    expiresAt: 20_000,
  };

  function binding(runtimeAccess?: AppRunnerProps["artifact"]["runtimeAccess"]) {
    return new GsvApiBinding({
      props: {
        appRunnerName: "app:1000:pkg-chat",
        kernelName: "user:alice",
        appFrameAuthority: authorized,
        ...(runtimeAccess ? { runtimeAccess } : {}),
      },
      exports: {},
    } as any, env as any);
  }

  it.each([
    ["uid", { uid: 0 }],
    ["username", { username: "root" }],
    ["package id", { packageId: "pkg-admin" }],
    ["package name", { packageName: "admin" }],
    ["package revision", { packageUpdatedAt: 1235 }],
    ["package artifact", { packageArtifactHash: "sha256:def456" }],
    ["entrypoint", { entrypointName: "admin" }],
    ["route", { routeBase: "/admin" }],
  ])("rejects a forged %s", async (_label, patch) => {
    await expect(binding().kernelRequestFrame(
      { ...authorized, ...patch } as any,
      "fs.read",
      { path: "/secret" },
    )).rejects.toThrow("does not match");
  });

  it("cancels the body when forged authority is rejected", async () => {
    const { body, cancel } = cancellableBody();

    await expect(binding().kernelRequestFrame(
      { ...authorized, uid: 0 } as any,
      "proc.media.write",
      { key: "media-key" },
      { body },
    )).rejects.toThrow("does not match");

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("uses daemon authorization for platform calls from daemon-approved packages", async () => {
    const daemonRequest = vi.spyOn(Kernel.prototype as any, "appDaemonRequest")
      .mockImplementation(async (_appFrame: unknown, frame: { id: string }) => ({
        type: "res",
        id: frame.id,
        ok: true,
        data: { ok: true },
      }));
    const appRequest = vi.spyOn(Kernel.prototype as any, "appRequest");
    try {
      await expect(binding({ daemon: { rpcSchedules: true } }).kernelRequest(
        authorized,
        "fs.read",
        { path: "/tmp/status" },
      )).resolves.toEqual({ ok: true });
      expect(daemonRequest).toHaveBeenCalledOnce();
      expect(appRequest).not.toHaveBeenCalled();
    } finally {
      appRequest.mockRestore();
      daemonRequest.mockRestore();
    }
  });
});

describe("AppRunner body transport", () => {
  it("receives and sends shared binary body frames", async () => {
    const sent: Array<string | ArrayBuffer> = [];
    const socket = {
      send: (value: string | ArrayBuffer) => sent.push(value),
    } as unknown as WebSocket;
    const transport = new AppSocketBodyTransport();
    const incoming = transport.receive(socket, { streamId: 7, length: 3 });

    expect(transport.handleBinary(
      socket,
      buildBinaryFrame(7, BINARY_FRAME_DATA, new TextEncoder().encode("hey")),
    )).toBe(true);
    expect(transport.handleBinary(socket, buildBinaryFrame(7, BINARY_FRAME_END))).toBe(true);
    expect(await bodyToText(incoming)).toBe("hey");

    await transport.send(socket, {
      type: "res",
      id: "request-1",
      ok: true,
      data: { ok: true },
    }, bodyFromText("ok"));

    expect(JSON.parse(sent[0] as string)).toMatchObject({
      type: "res",
      id: "request-1",
      body: { streamId: 1, length: 2 },
    });
    expect(parseBinaryFrame(sent[1] as ArrayBuffer)?.payload).toEqual(new TextEncoder().encode("ok"));
    expect(parseBinaryFrame(sent[2] as ArrayBuffer)?.flags).toBe(BINARY_FRAME_END);
  });

  it("forwards request bodies and preserves response bodies at the kernel boundary", async () => {
    const appRequest = vi.fn(async (_appFrame: unknown, frame: any) => {
      expect(await bodyToText(frame.body)).toBe("request bytes");
      return {
        type: "res" as const,
        id: frame.id,
        ok: true as const,
        data: { ok: true },
        body: bodyFromText("response bytes"),
      };
    });

    const response = await requestAppKernelFrame(
      { appRequest },
      { uid: 1000 } as any,
      "proc.media.read",
      { key: "media-key" },
      { body: bodyFromText("request bytes") },
    );

    expect(appRequest).toHaveBeenCalledOnce();
    expect(response.data).toEqual({ ok: true });
    expect(response.body && await bodyToText(response.body)).toBe("response bytes");
  });

  it("cancels an accepted request body when the Kernel rejects it", async () => {
    const { body, cancel } = cancellableBody();
    const appRequest = vi.fn(async () => {
      throw new Error("kernel unavailable");
    });

    await expect(requestAppKernelFrame(
      { appRequest },
      { uid: 1000 } as any,
      "proc.media.write",
      { key: "media-key" },
      { body },
    )).rejects.toThrow("kernel unavailable");

    expect(cancel).toHaveBeenCalledOnce();
  });
});
