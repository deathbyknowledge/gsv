import { describe, expect, it, vi } from "vitest";
import {
  BINARY_FRAME_DATA,
  BINARY_FRAME_END,
  bodyFromText,
  bodyToText,
  buildBinaryFrame,
  parseBinaryFrame,
} from "@humansandmachines/gsv/protocol";
import {
  AppSocketBodyTransport,
  GsvApiBinding,
  appRpcScheduleAuthorityForRunner,
  appRunnerAuthorityForRuntime,
  appRunnerAuthorityFromRpcSchedule,
  appRunnerAuthorityKey,
  appRunnerRuntimeMatchesAuthority,
  appRunnerWorkerCodeKey,
  buildAppDataRunnerName,
  bindAppRunnerGlobalOutbound,
  captureAppRunnerRuntime,
  forwardPackageSqlToDataRunner,
  forwardAppRunnerFetchOperation,
  isAppDataRunnerName,
  isAppSessionCurrent,
  requestAppKernelFrame,
  trackAppRunnerResponseOperation,
} from "./app-runner";
import { AppRunnerPackageRuntimeFenceGate } from "./app-runner/package-runtime-fence";
import { isPackageOutboundAllowed } from "./kernel/packages";
import { buildAppRunnerName } from "./protocol/app-session";

function activeAppFrame() {
  const now = Date.now();
  return {
    uid: 1000,
    username: "alice",
    kernelOwnerUid: 1000,
    kernelUsername: "alice",
    kernelGeneration: 3,
    packageId: "pkg-chat",
    packageName: "chat",
    packageUpdatedAt: now - 1_000,
    packageArtifactHash: "sha256:chat-v1",
    entrypointName: "Chat",
    routeBase: "/apps/chat",
    issuedAt: now,
    expiresAt: now + 60_000,
  };
}

function activeArtifact() {
  return {
    hash: "sha256:chat-v1",
    mainModule: "index.js",
    modulePaths: ["index.js"],
    runtimeAccess: {
      egress: { mode: "allowlist" as const, allow: ["api.example.com"] },
    },
  };
}

function activeRuntime(frame: ReturnType<typeof activeAppFrame> = activeAppFrame()) {
  return {
    artifact: activeArtifact(),
    appFrame: frame,
  };
}

function gsvApiBindingFor(frame: ReturnType<typeof activeAppFrame>): GsvApiBinding {
  return new GsvApiBinding({
    props: {
      appRunnerName: "runner-1",
      authority: appRunnerAuthorityForRuntime(activeRuntime(frame)),
      runtimeEpoch: 7,
    },
    exports: {},
  } as any, {} as any);
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

function baseProps(runtimeAccess?: Parameters<typeof appRunnerWorkerCodeKey>[0]["artifact"]["runtimeAccess"]) {
  return {
    appFrame: {
      uid: 1000,
      username: "alice",
      kernelOwnerUid: 1000,
      kernelUsername: "alice",
      kernelGeneration: 1,
      packageId: "pkg-chat",
      packageUpdatedAt: 1,
      entrypointName: "main",
      routeBase: "/apps/chat",
    },
    artifact: {
      hash: "sha256:abc123",
      ...(runtimeAccess ? { runtimeAccess } : {}),
    },
  };
}

describe("appRunnerWorkerCodeKey", () => {
  it("changes when package runtime access changes", () => {
    const denied = appRunnerWorkerCodeKey(baseProps({ egress: { mode: "none" } }), 1);
    const allowed = appRunnerWorkerCodeKey(baseProps({
      egress: { mode: "allowlist", allow: ["api.example.com"] },
    }), 1);

    expect(allowed).not.toBe(denied);
  });

  it("normalizes runtime access object key order", () => {
    const first = appRunnerWorkerCodeKey(baseProps({
      egress: { mode: "none" },
      daemon: { rpcSchedules: true },
      storage: { sql: true },
    }), 1);
    const second = appRunnerWorkerCodeKey(baseProps({
      storage: { sql: true },
      daemon: { rpcSchedules: true },
      egress: { mode: "none" },
    }), 1);

    expect(second).toBe(first);
  });

  it("never reuses a Loader key across local runtime epochs", () => {
    const props = baseProps({ egress: { mode: "none" } });

    expect(appRunnerWorkerCodeKey(props, 2))
      .not.toBe(appRunnerWorkerCodeKey(props, 1));
  });
});

describe("AppRunner global outbound fencing", () => {
  const outbound = { fetch: vi.fn() } as unknown as Fetcher;
  const code = {
    compatibilityDate: "2026-01-01",
    mainModule: "index.js",
    modules: { "index.js": { js: "export default {}" } },
    globalOutbound: { fetch: vi.fn() } as unknown as Fetcher,
  } satisfies WorkerLoaderWorkerCode;

  it("replaces both allowlisted and inherited raw fetch with the AppRunner binding", () => {
    expect(bindAppRunnerGlobalOutbound(code, {
      egress: { mode: "allowlist", allow: ["api.example.com"] },
    }, outbound).globalOutbound).toBe(outbound);
    expect(bindAppRunnerGlobalOutbound(code, {
      egress: { mode: "inherit" },
    }, outbound).globalOutbound).toBe(outbound);
    expect(bindAppRunnerGlobalOutbound(code, {
      egress: { mode: "none" },
    }, outbound).globalOutbound).toBeNull();
    expect(bindAppRunnerGlobalOutbound(code, undefined, outbound).globalOutbound).toBeNull();
  });

  it("preserves exact scheme, host, and port allowlist semantics", () => {
    const access = {
      egress: {
        mode: "allowlist" as const,
        allow: ["api.example.test", "http://legacy.example.test:8080"],
      },
    };
    expect(isPackageOutboundAllowed(access.egress, new URL("https://api.example.test/v1")))
      .toBe(true);
    expect(isPackageOutboundAllowed(access.egress, new URL("http://api.example.test/v1")))
      .toBe(false);
    expect(isPackageOutboundAllowed(access.egress, new URL("http://legacy.example.test:8080/v1")))
      .toBe(true);
    expect(isPackageOutboundAllowed(access.egress, new URL("https://legacy.example.test:8080/v1")))
      .toBe(false);
    expect(isPackageOutboundAllowed({ mode: "inherit" }, new URL("https://other.test")))
      .toBe(true);
    expect(isPackageOutboundAllowed({ mode: "inherit" }, new URL("file:///tmp/x")))
      .toBe(false);
  });
});

describe("AppRunner forwarded request body ownership", () => {
  function runtimeFenceInput() {
    return {
      authorization: crypto.randomUUID(),
      fenceKind: "user-lifecycle" as const,
      sourceKernelName: "user:alice",
      runnerName: buildAppRunnerName(1000, 1000, "pkg-chat"),
      ownerUid: 1000,
      ownerUsername: "alice",
      kernelOwnerUid: 1000,
      kernelOwnerUsername: "alice",
      packageId: "pkg-chat",
      generation: 3,
      fenceId: crypto.randomUUID(),
    };
  }

  function runtimeFenceStorage() {
    const values = new Map<string, unknown>();
    return {
      get<T = unknown>(key: string): T | undefined {
        return values.get(key) as T | undefined;
      },
      put<T>(key: string, value: T): void {
        values.set(key, structuredClone(value));
      },
    };
  }

  async function within<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error("operation did not settle before the test deadline")),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([promise, deadline]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  it("preserves a streaming response while settling its forwarded request body", async () => {
    const input = runtimeFenceInput();
    const gate = new AppRunnerPackageRuntimeFenceGate(
      runtimeFenceStorage(),
      input.runnerName,
    );
    const operation = gate.acquireOperation();
    const requestReadStarted = Promise.withResolvers<void>();
    const requestCancel = vi.fn();
    let detachedRead: Promise<unknown> | null = null;
    const request = new Request("https://app.test/upload", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        pull() {
          requestReadStarted.resolve();
          return new Promise<void>(() => {});
        },
        cancel: requestCancel,
      }),
    });

    const response = await forwardAppRunnerFetchOperation(
      request,
      operation,
      async (forwardedRequest) => {
        const reader = forwardedRequest.body!.getReader();
        detachedRead = reader.read().then(
          (value) => value,
          (error) => error,
        );
        await requestReadStarted.promise;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("response bytes"));
            controller.close();
          },
        }), {
          status: 202,
          headers: { "x-app-result": "accepted" },
        });
      },
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("x-app-result")).toBe("accepted");
    expect(await response.text()).toBe("response bytes");
    expect(requestCancel).toHaveBeenCalledOnce();
    expect(await detachedRead).toBeInstanceOf(Error);
    await expect(gate.prepare(input, async () => true))
      .resolves.toMatchObject({ state: "fenced" });
  });

  it("bounds fence acknowledgment when request-source cancellation never settles", async () => {
    const input = runtimeFenceInput();
    const gate = new AppRunnerPackageRuntimeFenceGate(
      runtimeFenceStorage(),
      input.runnerName,
    );
    const operation = gate.acquireOperation();
    const requestReadStarted = Promise.withResolvers<void>();
    const maliciousRequestCancel = Promise.withResolvers<void>();
    const events: string[] = [];
    const requestCancel = vi.fn(() => {
      events.push("request-cancel-start");
      return maliciousRequestCancel.promise;
    });
    const responseCancel = vi.fn(() => {
      events.push("response-cancel");
    });
    let detachedRead: Promise<unknown> | null = null;
    const request = new Request("https://app.test/upload", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        pull() {
          requestReadStarted.resolve();
          return new Promise<void>(() => {});
        },
        cancel: requestCancel,
      }),
    });

    const response = await forwardAppRunnerFetchOperation(
      request,
      operation,
      async (forwardedRequest) => {
        const reader = forwardedRequest.body!.getReader();
        detachedRead = reader.read().then(
          (value) => value,
          (error) => error,
        );
        await requestReadStarted.promise;
        return new Response(new ReadableStream<Uint8Array>({
          cancel: responseCancel,
        }));
      },
    );

    const acknowledgment = within(gate.prepare(input, async () => true).then((ack) => {
      events.push("ack");
      return ack;
    }));
    await vi.waitFor(() => {
      expect(responseCancel).toHaveBeenCalledOnce();
      expect(requestCancel).toHaveBeenCalledOnce();
    });
    expect(await detachedRead).toBeInstanceOf(Error);
    await expect(acknowledgment).resolves.toMatchObject({ state: "fenced" });
    expect(events.slice(0, 2).sort()).toEqual([
      "request-cancel-start",
      "response-cancel",
    ]);
    expect(events.slice(2)).toEqual(["ack"]);

    maliciousRequestCancel.reject(new Error("malicious late request cancel rejection"));
    await Promise.resolve();
    await response.body?.cancel().catch(() => {});
  });

  it("bounds fence acknowledgment when response cancellation never settles", async () => {
    const input = runtimeFenceInput();
    const gate = new AppRunnerPackageRuntimeFenceGate(
      runtimeFenceStorage(),
      input.runnerName,
    );
    const operation = gate.acquireOperation();
    const cancelStarted = Promise.withResolvers<void>();
    const maliciousCancel = Promise.withResolvers<void>();
    const responseCancel = vi.fn(() => {
      cancelStarted.resolve();
      return maliciousCancel.promise;
    });
    const response = trackAppRunnerResponseOperation(
      new Response(new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => {});
        },
        cancel: responseCancel,
      })),
      operation,
    );
    const outwardRead = response.body!.getReader().read();
    const outwardExpectation = expect(outwardRead).rejects.toThrow(
      "Package runtime authority is fenced",
    );

    const acknowledgment = within(gate.prepare(input, async () => true));
    await cancelStarted.promise;
    await expect(acknowledgment).resolves.toMatchObject({ state: "fenced" });
    await outwardExpectation;
    expect(responseCancel).toHaveBeenCalledOnce();

    maliciousCancel.reject(new Error("malicious late cancel rejection"));
    await Promise.resolve();
  });
});

describe("AppRunner request-scoped runtime authority", () => {
  it("captures an immutable runtime snapshot before asynchronous work", () => {
    const input = activeRuntime();
    const captured = captureAppRunnerRuntime(input);

    input.appFrame.packageName = "admin";
    input.appFrame.entrypointName = "Admin";
    input.artifact.runtimeAccess.egress.allow.push("admin.example.com");

    expect(captured.appFrame.packageName).toBe("chat");
    expect(captured.appFrame.entrypointName).toBe("Chat");
    expect(captured.artifact.runtimeAccess?.egress?.allow).toEqual(["api.example.com"]);
  });

  it("keeps reverse-completing requests bound to their initiating revision", async () => {
    const firstGate = Promise.withResolvers<void>();
    const secondGate = Promise.withResolvers<void>();
    const captureAfter = async (
      input: ReturnType<typeof activeRuntime>,
      gate: Promise<void>,
    ) => {
      const captured = captureAppRunnerRuntime(input);
      await gate;
      return appRunnerAuthorityKey(appRunnerAuthorityForRuntime(captured));
    };
    const firstRuntime = activeRuntime();
    const secondRuntime = activeRuntime({
      ...activeAppFrame(),
      packageUpdatedAt: firstRuntime.appFrame.packageUpdatedAt + 1,
      packageArtifactHash: "sha256:chat-v2",
      entrypointName: "Admin",
    });
    secondRuntime.artifact = {
      ...activeArtifact(),
      hash: "sha256:chat-v2",
    };

    const first = captureAfter(firstRuntime, firstGate.promise);
    const second = captureAfter(secondRuntime, secondGate.promise);
    secondGate.resolve();
    const secondKey = await second;
    firstGate.resolve();
    const firstKey = await first;

    expect(firstKey).not.toBe(secondKey);
    expect(firstKey).toContain("sha256:chat-v1");
    expect(secondKey).toContain("sha256:chat-v2");
  });
});

describe("package SQL storage isolation", () => {
  it("uses a deterministic namespace isolated by Kernel owner, actor, and package", () => {
    expect(buildAppDataRunnerName(1000, 2000, "pkg-chat"))
      .toBe("app-data-v2:1000:2000:pkg-chat");
    expect(buildAppDataRunnerName(1000, 2000, "pkg-chat"))
      .not.toBe(buildAppDataRunnerName(1001, 2000, "pkg-chat"));
    expect(buildAppDataRunnerName(1000, 2000, "pkg-chat"))
      .not.toBe(buildAppDataRunnerName(1000, 2001, "pkg-chat"));
    expect(buildAppDataRunnerName(1000, 2000, "pkg-chat"))
      .not.toBe(buildAppDataRunnerName(1000, 2000, "pkg-admin"));
    expect(buildAppDataRunnerName(1000, 2000, "global:chat"))
      .toBe("app-data-v2:1000:2000:global%3Achat");
    expect(isAppDataRunnerName(buildAppDataRunnerName(1000, 2000, "pkg-chat"))).toBe(true);
    expect(isAppDataRunnerName("app-data:2000:pkg-chat")).toBe(false);
    expect(isAppDataRunnerName("app:1000:pkg-chat")).toBe(false);
  });

  it("routes hostile package SQL only to the isolated data object", async () => {
    const controlTables = new Set(["app_rpc_schedules", "_gsv_schema_migrations"]);
    const dataTables = new Map<string, Set<string>>();
    const selected: string[] = [];
    const authority = appRunnerAuthorityForRuntime(activeRuntime());
    const getRunner = (name: string) => ({
      async packageSqlExecIsolated(
        expectedName: string,
        _authority: unknown,
        statement: string,
      ) {
        expect(expectedName).toBe(name);
        selected.push(name);
        const tables = dataTables.get(name) ?? new Set(["package_notes"]);
        dataTables.set(name, tables);
        if (statement.startsWith("SELECT")) {
          return [...tables]
            .filter((table) => statement.includes(table))
            .map((table) => ({ table }));
        }
        for (const table of [...tables]) {
          if (statement.includes(table)) {
            tables.delete(table);
          }
        }
        return [];
      },
    });

    const leakedRows = await forwardPackageSqlToDataRunner(
      getRunner,
      authority,
      "SELECT * FROM app_rpc_schedules",
    );
    await forwardPackageSqlToDataRunner(
      getRunner,
      authority,
      "DROP TABLE app_rpc_schedules",
    );
    await forwardPackageSqlToDataRunner(
      getRunner,
      authority,
      "DELETE FROM _gsv_schema_migrations",
    );

    expect(selected).toEqual([
      "app-data-v2:1000:1000:pkg-chat",
      "app-data-v2:1000:1000:pkg-chat",
      "app-data-v2:1000:1000:pkg-chat",
    ]);
    expect(leakedRows).toEqual([]);
    expect(controlTables).toEqual(new Set([
      "app_rpc_schedules",
      "_gsv_schema_migrations",
    ]));
    expect(dataTables.get("app-data-v2:1000:1000:pkg-chat"))
      .toEqual(new Set(["package_notes"]));
  });
});

describe("AppRunner daemon schedule authority", () => {
  it("binds every execution-relevant authority field", () => {
    const authority = appRunnerAuthorityForRuntime(activeRuntime());
    const schedule = appRpcScheduleAuthorityForRunner(authority);

    expect(schedule).toMatchObject({
      ownerUid: 1000,
      ownerUsername: "alice",
      kernelUsername: "alice",
      kernelGeneration: 3,
      packageId: "pkg-chat",
      packageName: "chat",
      packageUpdatedAt: authority.packageUpdatedAt,
      artifactHash: "sha256:chat-v1",
      entrypointName: "Chat",
      routeBase: "/apps/chat",
    });
    expect(appRunnerAuthorityFromRpcSchedule(schedule)).toEqual(authority);
  });

  it.each([
    ["owner", { ownerUid: 0 }],
    ["owner username", { ownerUsername: "root" }],
    ["Kernel username", { kernelUsername: "bob" }],
    ["Kernel generation", { kernelGeneration: 4 }],
    ["package id", { packageId: "pkg-admin" }],
    ["package name", { packageName: "admin" }],
    ["package revision", { packageUpdatedAt: 1 }],
    ["artifact", { artifactHash: "sha256:admin" }],
    ["entrypoint", { entrypointName: "Admin" }],
    ["route", { routeBase: "/apps/admin" }],
  ] as const)("rejects a schedule with a forged %s binding", (_label, patch) => {
    const authority = appRunnerAuthorityForRuntime(activeRuntime());
    const schedule = appRpcScheduleAuthorityForRunner(authority);

    expect(() => appRunnerAuthorityFromRpcSchedule({
      ...schedule,
      ...patch,
    })).toThrow("Daemon schedule authority is inconsistent");
  });

  it("rejects legacy schedules without a user-Kernel generation", () => {
    const authority = {
      ...appRunnerAuthorityForRuntime(activeRuntime()),
      kernelUsername: undefined,
      kernelGeneration: undefined,
    };

    expect(() => appRpcScheduleAuthorityForRunner(authority))
      .toThrow("Daemon schedules require provisioned user-Kernel authority");
  });
});

describe("app session socket lifetime", () => {
  it("accepts only finite, unexpired session deadlines", () => {
    expect(isAppSessionCurrent({ expiresAt: 1_001 }, 1_000)).toBe(true);
    expect(isAppSessionCurrent({ expiresAt: 1_000 }, 1_000)).toBe(false);
    expect(isAppSessionCurrent({ expiresAt: 999 }, 1_000)).toBe(false);
    expect(isAppSessionCurrent({ expiresAt: Number.POSITIVE_INFINITY }, 1_000)).toBe(false);
    expect(isAppSessionCurrent({ expiresAt: Number.NaN }, 1_000)).toBe(false);
  });

  it("binds restored socket runtimes to exact Kernel and package authority", () => {
    const runtime = activeRuntime();
    const authority = appRunnerAuthorityForRuntime(runtime);

    expect(appRunnerRuntimeMatchesAuthority(runtime, authority)).toBe(true);
    expect(appRunnerRuntimeMatchesAuthority({
      ...runtime,
      appFrame: { ...runtime.appFrame, kernelGeneration: 4 },
    }, authority)).toBe(false);
    expect(appRunnerRuntimeMatchesAuthority({
      artifact: { ...runtime.artifact, hash: "sha256:chat-v2" },
      appFrame: {
        ...runtime.appFrame,
        packageUpdatedAt: runtime.appFrame.packageUpdatedAt + 1,
        packageArtifactHash: "sha256:chat-v2",
      },
    }, authority)).toBe(false);
    expect(appRunnerRuntimeMatchesAuthority({
      ...runtime,
      appFrame: { ...runtime.appFrame, entrypointName: "Admin" },
    }, authority)).toBe(false);
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
    const appRequest = vi.fn(async (_appFrame: unknown, frame: any, _runnerName?: string) => {
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
      "app-control-v3:1000:1000:pkg-chat",
    );

    expect(appRequest).toHaveBeenCalledOnce();
    expect(appRequest).toHaveBeenCalledWith(
      { uid: 1000 },
      expect.objectContaining({ type: "req", call: "proc.media.read" }),
      "app-control-v3:1000:1000:pkg-chat",
    );
    expect(response.data).toEqual({ ok: true });
    expect(response.body && await bodyToText(response.body)).toBe("response bytes");
  });

  it("cancels an accepted request body when the kernel throws", async () => {
    const { body, cancel } = cancellableBody();
    const appRequest = vi.fn(async () => {
      throw new Error("kernel unavailable");
    });

    await expect(requestAppKernelFrame(
      { appRequest },
      activeAppFrame(),
      "proc.media.write",
      { key: "media-key" },
      { body },
    )).rejects.toThrow("kernel unavailable");

    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("GSV API app authority", () => {
  const forgeries: Array<{
    label: string;
    patch: Partial<ReturnType<typeof activeAppFrame>>;
  }> = [
    { label: "uid", patch: { uid: 0 } },
    { label: "username", patch: { username: "root" } },
    { label: "Kernel owner uid", patch: { kernelOwnerUid: 1001 } },
    { label: "Kernel username", patch: { kernelUsername: "bob" } },
    { label: "Kernel generation", patch: { kernelGeneration: 4 } },
    { label: "package id", patch: { packageId: "pkg-admin" } },
    { label: "package name", patch: { packageName: "admin" } },
    { label: "package revision", patch: { packageUpdatedAt: 1 } },
    { label: "package artifact", patch: { packageArtifactHash: "sha256:admin" } },
    { label: "entrypoint", patch: { entrypointName: "Admin" } },
    { label: "package route", patch: { routeBase: "/apps/admin" } },
  ];

  it("binds Kernel authorization and requests to its exact control runner", async () => {
    const runtime = activeRuntime();
    const authority = appRunnerAuthorityForRuntime(runtime);
    const runnerName = buildAppRunnerName(
      authority.kernelOwnerUid,
      authority.ownerUid,
      authority.packageId,
    );
    const packageKernelRequestFrame = vi.fn(async () => ({ data: { ok: true } }));
    const getByName = vi.fn(() => ({ packageKernelRequestFrame }));
    const binding = new GsvApiBinding({
      props: { appRunnerName: runnerName, authority, runtimeEpoch: 7 },
      exports: { AppRunner: { getByName } },
    } as any, {} as any);

    await expect(binding.kernelRequestFrame(
      runtime.appFrame,
      "fs.read",
      { path: "/home/alice/file.txt" },
    )).resolves.toEqual({ data: { ok: true } });

    expect(getByName).toHaveBeenCalledWith(runnerName);
    expect(packageKernelRequestFrame).toHaveBeenCalledWith(
      7,
      authority,
      runtime.appFrame,
      "fs.read",
      { path: "/home/alice/file.txt" },
      {},
    );
  });

  it("stamps every package capability entry with its immutable Loader epoch", async () => {
    const runtime = activeRuntime();
    const authority = appRunnerAuthorityForRuntime({
      ...runtime,
      artifact: {
        ...runtime.artifact,
        runtimeAccess: {
          ...runtime.artifact.runtimeAccess,
          daemon: { rpcSchedules: true },
          storage: { sql: true },
        },
      },
    });
    const runnerName = buildAppRunnerName(
      authority.kernelOwnerUid,
      authority.ownerUid,
      authority.packageId,
    );
    const runner = {
      packageOutboundFetch: vi.fn(async () => new Response("ok")),
      upsertRpcSchedule: vi.fn(async () => ({ key: "daily" })),
      removeRpcSchedule: vi.fn(async () => ({ removed: true })),
      listRpcSchedules: vi.fn(async () => []),
      packageSqlExec: vi.fn(async () => []),
      emitAppEvent: vi.fn(async () => ({ delivered: 1 })),
    };
    const binding = new GsvApiBinding({
      props: { appRunnerName: runnerName, authority, runtimeEpoch: 23 },
      exports: { AppRunner: { getByName: vi.fn(() => runner) } },
    } as any, {} as any);

    await expect(binding.fetch(new Request("https://api.example.com/v1")))
      .resolves.toBeInstanceOf(Response);
    await binding.upsertRpcSchedule({ key: "daily" });
    await binding.removeRpcSchedule("daily");
    await binding.listRpcSchedules();
    await binding.packageSqlExec("SELECT 1");
    await binding.emitAppEvent("refresh");

    expect(runner.packageOutboundFetch).toHaveBeenCalledWith(
      23,
      authority,
      expect.any(Request),
    );
    expect(runner.upsertRpcSchedule).toHaveBeenCalledWith(
      23,
      authority,
      { key: "daily" },
    );
    expect(runner.removeRpcSchedule).toHaveBeenCalledWith(23, authority, "daily");
    expect(runner.listRpcSchedules).toHaveBeenCalledWith(23, authority);
    expect(runner.packageSqlExec).toHaveBeenCalledWith(
      23,
      authority,
      "SELECT 1",
      undefined,
    );
    expect(runner.emitAppEvent).toHaveBeenCalledWith(
      23,
      authority,
      "refresh",
      undefined,
      undefined,
      undefined,
    );
  });

  it.each(forgeries)("rejects a forged $label", async ({ patch }) => {
    const authorized = activeAppFrame();
    const binding = gsvApiBindingFor(authorized);

    await expect(binding.kernelRequestFrame(
      { ...authorized, ...patch },
      "fs.read",
      { path: "/secret" },
    )).rejects.toThrow("Authentication failed");
  });

  it("cancels the request body when app authority is rejected", async () => {
    const authorized = activeAppFrame();
    const binding = gsvApiBindingFor(authorized);
    const { body, cancel } = cancellableBody();

    await expect(binding.kernelRequestFrame(
      { ...authorized, packageId: "pkg-admin" },
      "proc.media.write",
      { key: "media-key" },
      { body },
    )).rejects.toThrow("Authentication failed");

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("never selects a legacy app: object from a package binding", async () => {
    const runtime = activeRuntime();
    const authority = appRunnerAuthorityForRuntime(runtime);
    const getByName = vi.fn();
    const binding = new GsvApiBinding({
      props: {
        appRunnerName: `app:${authority.ownerUid}:${authority.packageId}`,
        authority,
        runtimeEpoch: 7,
      },
      exports: { AppRunner: { getByName } },
    } as any, {} as any);

    await expect(binding.emitAppEvent("refresh"))
      .rejects.toThrow("Authentication failed");
    expect(getByName).not.toHaveBeenCalled();
    expect(buildAppRunnerName(
      authority.kernelOwnerUid,
      authority.ownerUid,
      authority.packageId,
    )).toBe("app-control-v3:1000:1000:pkg-chat");
  });
});
