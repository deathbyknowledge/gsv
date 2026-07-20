import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { getAgentByName } from "agents";
import {
  loadPackageArtifact,
  isPackageOutboundAllowed,
  packageArtifactPublicBase,
  packageArtifactToWorkerCode,
  resolveAppKernelForFrame,
  type PackageRuntimeAccess,
} from "./kernel/packages";
import { encodeBase64Bytes } from "./shared/base64";
import {
  DEFAULT_APP_FRAME_TTL_MS,
  isAppFrameContextExpired,
  type AppFrameContext,
  type PackageAppSignalWatchInfo,
} from "./protocol/app-frame";
import {
  buildAppDataRunnerName as buildScopedAppDataRunnerName,
  buildAppRunnerName,
  isAppRunnerControlName,
  isAppRunnerDataName,
} from "./protocol/app-session";
import type { RequestFrame, ResponseFrame } from "./protocol/frames";
import {
  AppRpcScheduleStore,
  type AppRpcScheduleAuthority,
  type AppRpcSchedule,
  type AppRpcScheduleRecord,
  type AppRpcScheduleUpsertInput,
} from "./app-daemons";
import {
  appRunnerControlSchemaIsCurrent,
  initializeAppRunnerControlSchema,
} from "./app-runner/schema/control-schema";
import {
  AppRunnerPackageRuntimeFenceGate,
  type AppRunnerPackageRuntimeOperation,
  type AppRunnerRuntimeFenceAck,
  type AppRunnerRuntimeFenceAuthorizationInput,
  type AppRunnerRuntimeFenceInput,
} from "./app-runner/package-runtime-fence";
import {
  BinaryBodyChannel,
  type BinaryBody,
  type BinaryFrameDescriptor,
} from "@humansandmachines/gsv/protocol";

export type AppRunnerArtifactAuthority = {
  hash: string;
  runtimeAccess?: PackageRuntimeAccess;
};

export type AppRunnerRuntimeProps = {
  artifact: AppRunnerArtifactAuthority;
  appFrame: AppFrameContext;
};

export type AppRunnerAuthority = {
  kernelOwnerUid: number;
  ownerUid: number;
  ownerUsername: string;
  kernelUsername?: string;
  kernelGeneration?: number;
  packageId: string;
  packageName: string;
  packageUpdatedAt: number;
  artifactHash: string;
  entrypointName: string;
  routeBase: string;
  artifact: AppRunnerArtifactAuthority;
};

type AppRunnerSignalInput = {
  runtime: AppRunnerRuntimeProps;
  signal: string;
  payload?: unknown;
  sourcePid?: string | null;
  watch: PackageAppSignalWatchInfo;
  appSession?: AppSessionInfo;
};

type AppSessionInfo = {
  sessionId: string;
  clientId: string;
  rpcBase: string;
  expiresAt: number;
};

export function isAppSessionCurrent(
  session: Pick<AppSessionInfo, "expiresAt">,
  now = Date.now(),
): boolean {
  return Number.isFinite(session.expiresAt) && session.expiresAt > now;
}

type AppSocketContext = {
  session: AppSessionInfo;
  runtime: AppRunnerRuntimeProps;
};

type AppSocketAttachment = {
  kind: "app-client";
  connected: boolean;
  session?: AppSessionInfo;
  runtime?: AppRunnerRuntimeProps;
  connectedAt?: number;
};

type AppRequestFrame = {
  type: "req";
  id: string;
  call: string;
  args?: unknown;
  body?: BinaryFrameDescriptor;
};

type AppResponseFrame =
  | {
      type: "res";
      id: string;
      ok: true;
      data?: unknown;
      body?: BinaryFrameDescriptor;
    }
  | {
      type: "res";
      id: string;
      ok: false;
      error: {
        code: number;
        message: string;
        details?: unknown;
      };
    };

type AppSignalFrame = {
  type: "sig";
  signal: string;
  payload?: unknown;
};

type AppSocketFrame = AppRequestFrame | AppResponseFrame | AppSignalFrame;

type AppSocketResult = {
  data?: unknown;
  body?: BinaryBody;
};

type AppRuntimeContext = {
  runtime: AppRunnerRuntimeProps;
  appSession?: AppSessionInfo;
  daemonTrigger?: {
    kind: "schedule";
    key: string;
    scheduledAt: number;
    firedAt: number;
  };
};

export type AppRunnerCommandInput = {
  runtime: AppRunnerRuntimeProps;
  commandName: string;
  args: string[];
  cwd: string;
  gid: number;
};

type KernelAppStub = {
  appRequest(
    appFrame: AppFrameContext,
    frame: RequestFrame,
    runnerName?: string,
  ): Promise<ResponseFrame>;
};

type KernelPackageRuntimeFenceAuthorizationStub = {
  consumeAppRunnerRuntimeFenceAuthorization(
    input: AppRunnerRuntimeFenceAuthorizationInput,
  ): Promise<boolean>;
};

type AppFetchEntrypointStub = Rpc.WorkerEntrypointBranded & {
  fetch(request: Request): Promise<Response>;
};

type AppCommandEntrypointStub = Rpc.WorkerEntrypointBranded & {
  run(input?: unknown): Promise<unknown>;
};

type AppRpcEntrypointStub = Rpc.WorkerEntrypointBranded & {
  invoke(method: string, args: unknown): Promise<unknown>;
};

type AppSignalEntrypointStub = Rpc.WorkerEntrypointBranded & {
  run(signalName?: string): Promise<void>;
};

type AppRunnerDaemonStub = Rpc.RpcTargetBranded & {
  packageKernelRequestFrame(
    runtimeEpoch: number,
    authority: AppRunnerAuthority,
    appFrame: AppFrameContext,
    call: string,
    args?: unknown,
    options?: { body?: BinaryBody },
  ): Promise<{ data: unknown; body?: BinaryBody }>;
  upsertRpcSchedule(
    runtimeEpoch: number,
    authority: AppRunnerAuthority,
    input: unknown,
  ): Promise<unknown>;
  removeRpcSchedule(
    runtimeEpoch: number,
    authority: AppRunnerAuthority,
    key: string,
  ): Promise<{ removed: boolean }>;
  listRpcSchedules(runtimeEpoch: number, authority: AppRunnerAuthority): Promise<unknown[]>;
  packageSqlExec(
    runtimeEpoch: number,
    authority: AppRunnerAuthority,
    statement: string,
    bindings?: unknown[],
  ): Promise<unknown[]>;
  packageOutboundFetch(
    runtimeEpoch: number,
    authority: AppRunnerAuthority,
    request: Request,
  ): Promise<Response>;
  emitAppEvent(
    runtimeEpoch: number,
    authority: AppRunnerAuthority,
    event: string,
    payload?: unknown,
    clientId?: string,
    sessionId?: string,
  ): Promise<{ delivered: number }>;
};

type AppRunnerDataStub = Rpc.RpcTargetBranded & {
  packageSqlExecIsolated(
    expectedRunnerName: string,
    authority: AppRunnerAuthority,
    statement: string,
    bindings?: unknown[],
  ): Promise<unknown[]>;
};

type GsvApiBindingProps = {
  appRunnerName: string;
  authority: AppRunnerAuthority;
  runtimeEpoch: number;
};

type RegisteredAppClient = {
  socket: WebSocket;
  session: AppSessionInfo;
  runtime: AppRunnerRuntimeProps;
  registeredAt: number;
};

function appClientKey(session: AppSessionInfo): string {
  return appClientKeyFor(session.sessionId, session.clientId);
}

function appClientKeyFor(sessionId: string, clientId: string): string {
  return `${sessionId}:${clientId}`;
}

const APP_SOCKET_TAG = "app-client";

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .flatMap((key) => {
          const normalized = stableJsonValue(record[key]);
          return normalized === undefined ? [] : [[key, normalized]];
        }),
    );
  }
  return value;
}

export function bindAppRunnerGlobalOutbound(
  code: WorkerLoaderWorkerCode,
  access: PackageRuntimeAccess | undefined,
  outbound: Fetcher,
): WorkerLoaderWorkerCode {
  return {
    ...code,
    globalOutbound: access?.egress && access.egress.mode !== "none"
      ? outbound
      : null,
  };
}

type AppRunnerForwardedRequest = {
  request: Request;
  settle(reason?: unknown): Promise<void>;
};

type AppRunnerResponseOperationCleanup = (
  reason?: unknown,
) => void | Promise<void>;

function appRunnerBodyCancellationReason(reason: unknown): unknown {
  return reason ?? new Error("AppRunner request body was cancelled");
}

async function createAppRunnerForwardedRequest(
  request: Request,
  operation: AppRunnerPackageRuntimeOperation,
  init: Pick<RequestInit, "redirect"> = {},
): Promise<AppRunnerForwardedRequest> {
  const signal = AbortSignal.any([request.signal, operation.signal]);
  const sourceBody = request.body;
  if (!sourceBody) {
    return {
      request: new Request(request, { ...init, signal }),
      settle: async () => {},
    };
  }

  let sourceReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let settlement: Promise<void> | null = null;
  const complete = () => {
    if (settlement) return settlement;
    signal.removeEventListener("abort", onAbort);
    settlement = Promise.resolve();
    return settlement;
  };
  const settle = (reason?: unknown) => {
    if (settlement) return settlement;
    signal.removeEventListener("abort", onAbort);
    const cancellationReason = appRunnerBodyCancellationReason(reason);
    try {
      controller?.error(cancellationReason);
    } catch {
    }
    settlement = Promise.resolve();
    try {
      // The forwarded controller is terminal and no longer grants the
      // receiver access to source bytes. Source cancellation is best-effort
      // cleanup and cannot be allowed to pin the authority fence.
      const cancellation = sourceReader
        ? sourceReader.cancel(cancellationReason)
        : !sourceBody.locked
          ? sourceBody.cancel(cancellationReason)
          : null;
      if (cancellation) {
        void cancellation.catch(() => {});
      }
    } catch {
    }
    return settlement;
  };
  const onAbort = () => {
    void settle(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      if (signal.aborted) onAbort();
    },
    async pull(streamController) {
      if (signal.aborted) {
        await settle(signal.reason);
        return;
      }
      try {
        sourceReader ??= sourceBody.getReader();
        const next = await sourceReader.read();
        if (settlement) {
          await settlement;
          return;
        }
        if (next.done) {
          streamController.close();
          await complete();
          return;
        }
        streamController.enqueue(next.value);
      } catch (error) {
        if (settlement) {
          await settlement;
          return;
        }
        try {
          streamController.error(error);
        } finally {
          await complete();
        }
      }
    },
    async cancel(reason) {
      await settle(reason);
    },
  }, {
    highWaterMark: 0,
  });

  try {
    return {
      request: new Request(request, { ...init, body, signal }),
      settle,
    };
  } catch (error) {
    await settle(error);
    throw error;
  }
}

export function trackAppRunnerResponseOperation(
  response: Response,
  operation: AppRunnerPackageRuntimeOperation,
  cleanup: AppRunnerResponseOperationCleanup = () => {},
): Response {
  if (!response.body) {
    operation.release();
    return response;
  }
  const reader = response.body.getReader();
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let settlement: Promise<void> | null = null;
  let fenceCancellation: Promise<void> | null = null;
  const settle = (reason?: unknown) => {
    if (settlement) return settlement;
    operation.signal.removeEventListener("abort", onFence);
    settlement = (async () => {
      try {
        await cleanup(reason);
      } catch {
        // Cleanup failures are observed so they cannot become detached
        // rejections; the fence still waits until cleanup has settled.
      } finally {
        operation.release();
      }
    })();
    return settlement;
  };
  const cancelForFence = async () => {
    const reason = operation.signal.reason ?? new Error("Package runtime authority is fenced");
    try {
      streamController?.error(reason);
    } catch {
    }
    try {
      // The outward stream is already terminal. A package-controlled cancel
      // hook is best-effort cleanup and must not pin the authority fence.
      const cancellation = reader.cancel(reason);
      void cancellation.catch(() => {});
    } catch {
    }
    await settle(reason);
  };
  const onFence = () => {
    fenceCancellation ??= cancelForFence();
  };
  operation.signal.addEventListener("abort", onFence, { once: true });

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      if (operation.signal.aborted) onFence();
    },
    async pull(controller) {
      if (operation.signal.aborted) {
        onFence();
        await fenceCancellation;
        return;
      }
      try {
        const next = await reader.read();
        if (operation.signal.aborted) {
          onFence();
          await fenceCancellation;
          return;
        }
        if (next.done) {
          controller.close();
          await settle(new Error("AppRunner response completed"));
          return;
        }
        operation.assertCurrent();
        controller.enqueue(next.value);
      } catch (error) {
        if (operation.signal.aborted) {
          onFence();
          await fenceCancellation;
          return;
        }
        try {
          controller.error(error);
        } finally {
          await settle(error);
        }
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await settle(reason);
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function forwardAppRunnerFetchOperation(
  request: Request,
  operation: AppRunnerPackageRuntimeOperation,
  fetcher: (request: Request) => Promise<Response>,
  init: Pick<RequestInit, "redirect"> = {},
): Promise<Response> {
  let forwarded: AppRunnerForwardedRequest | null = null;
  let response: Response | null = null;
  let responseOwnsOperation = false;
  try {
    operation.assertCurrent();
    forwarded = await createAppRunnerForwardedRequest(request, operation, init);
    response = await fetcher(forwarded.request);
    operation.assertCurrent();
    if (!response.body) return response;
    const tracked = trackAppRunnerResponseOperation(
      response,
      operation,
      forwarded.settle,
    );
    responseOwnsOperation = true;
    return tracked;
  } finally {
    if (!responseOwnsOperation) {
      await forwarded?.settle("AppRunner fetch completed");
      await response?.body?.cancel("AppRunner response was not admitted").catch(() => {});
      operation.release();
    }
  }
}

export function appRunnerWorkerCodeKey(props: {
  artifact: { hash: string; runtimeAccess?: PackageRuntimeAccess };
  appFrame: Pick<
    AppFrameContext,
    | "uid"
    | "username"
    | "kernelOwnerUid"
    | "kernelUsername"
    | "kernelGeneration"
    | "packageId"
    | "packageUpdatedAt"
    | "entrypointName"
    | "routeBase"
  >;
}, runtimeEpoch: number): string {
  return [
    "app-runtime",
    String(captureAppRunnerRuntimeEpoch(runtimeEpoch)),
    String(props.appFrame.kernelOwnerUid),
    String(props.appFrame.uid),
    encodeURIComponent(props.appFrame.username),
    encodeURIComponent(props.appFrame.kernelUsername ?? "legacy"),
    String(props.appFrame.kernelGeneration ?? 0),
    String(props.appFrame.packageUpdatedAt),
    props.appFrame.packageId,
    encodeURIComponent(props.appFrame.entrypointName),
    encodeURIComponent(props.appFrame.routeBase),
    props.artifact.hash,
    encodeURIComponent(JSON.stringify(stableJsonValue(props.artifact.runtimeAccess ?? null))),
  ].join(":");
}

export function captureAppRunnerRuntime(input: unknown): AppRunnerRuntimeProps {
  if (!isRecord(input) || !isRecord(input.appFrame) || !isRecord(input.artifact)) {
    throw new Error("AppRunner runtime authority is missing");
  }
  const appFrame = input.appFrame as unknown as AppFrameContext;
  const artifact = input.artifact as unknown as AppRunnerArtifactAuthority;
  if (
    !Number.isSafeInteger(appFrame.uid)
    || appFrame.uid < 0
    || !Number.isSafeInteger(appFrame.kernelOwnerUid)
    || appFrame.kernelOwnerUid < 0
    || typeof appFrame.username !== "string"
    || !appFrame.username
    || (appFrame.kernelUsername !== undefined && typeof appFrame.kernelUsername !== "string")
    || (appFrame.kernelGeneration !== undefined
      && (!Number.isSafeInteger(appFrame.kernelGeneration) || appFrame.kernelGeneration <= 0))
    || typeof appFrame.packageId !== "string"
    || !appFrame.packageId
    || typeof appFrame.packageName !== "string"
    || !appFrame.packageName
    || !Number.isSafeInteger(appFrame.packageUpdatedAt)
    || appFrame.packageUpdatedAt <= 0
    || typeof appFrame.packageArtifactHash !== "string"
    || !appFrame.packageArtifactHash
    || typeof appFrame.entrypointName !== "string"
    || !appFrame.entrypointName
    || typeof appFrame.routeBase !== "string"
    || !appFrame.routeBase
    || !Number.isSafeInteger(appFrame.issuedAt)
    || !Number.isSafeInteger(appFrame.expiresAt)
    || typeof artifact.hash !== "string"
    || !artifact.hash
    || artifact.hash !== appFrame.packageArtifactHash
  ) {
    throw new Error("AppRunner runtime authority is invalid");
  }
  return structuredClone({
    artifact: {
      hash: artifact.hash,
      ...(artifact.runtimeAccess ? { runtimeAccess: artifact.runtimeAccess } : {}),
    },
    appFrame: {
      uid: appFrame.uid,
      username: appFrame.username,
      kernelOwnerUid: appFrame.kernelOwnerUid,
      ...(appFrame.kernelUsername ? { kernelUsername: appFrame.kernelUsername } : {}),
      ...(appFrame.kernelGeneration !== undefined
        ? { kernelGeneration: appFrame.kernelGeneration }
        : {}),
      ...(appFrame.sessionId ? { sessionId: appFrame.sessionId } : {}),
      ...(appFrame.clientId ? { clientId: appFrame.clientId } : {}),
      packageId: appFrame.packageId,
      packageName: appFrame.packageName,
      packageUpdatedAt: appFrame.packageUpdatedAt,
      packageArtifactHash: appFrame.packageArtifactHash,
      entrypointName: appFrame.entrypointName,
      routeBase: appFrame.routeBase,
      issuedAt: appFrame.issuedAt,
      expiresAt: appFrame.expiresAt,
    },
  });
}

export function appRunnerAuthorityForRuntime(input: unknown): AppRunnerAuthority {
  const runtime = captureAppRunnerRuntime(input);
  return {
    kernelOwnerUid: runtime.appFrame.kernelOwnerUid,
    ownerUid: runtime.appFrame.uid,
    ownerUsername: runtime.appFrame.username,
    ...(runtime.appFrame.kernelUsername
      ? { kernelUsername: runtime.appFrame.kernelUsername }
      : {}),
    ...(runtime.appFrame.kernelGeneration !== undefined
      ? { kernelGeneration: runtime.appFrame.kernelGeneration }
      : {}),
    packageId: runtime.appFrame.packageId,
    packageName: runtime.appFrame.packageName,
    packageUpdatedAt: runtime.appFrame.packageUpdatedAt,
    artifactHash: runtime.appFrame.packageArtifactHash,
    entrypointName: runtime.appFrame.entrypointName,
    routeBase: runtime.appFrame.routeBase,
    artifact: runtime.artifact,
  };
}

export function appRunnerAuthorityKey(authority: AppRunnerAuthority): string {
  const normalized = captureAppRunnerAuthority(authority);
  return JSON.stringify([
    normalized.kernelOwnerUid,
    normalized.ownerUid,
    normalized.ownerUsername,
    normalized.kernelUsername ?? null,
    normalized.kernelGeneration ?? null,
    normalized.packageId,
    normalized.packageName,
    normalized.packageUpdatedAt,
    normalized.artifactHash,
    normalized.entrypointName,
    normalized.routeBase,
    stableJsonValue(normalized.artifact.runtimeAccess ?? null),
  ]);
}

export function buildAppDataRunnerName(
  kernelOwnerUid: number,
  actorUid: number,
  packageId: string,
): string {
  return buildScopedAppDataRunnerName(kernelOwnerUid, actorUid, packageId);
}

export function isAppDataRunnerName(value: unknown): value is string {
  return isAppRunnerDataName(value);
}

export async function forwardPackageSqlToDataRunner(
  getRunner: (name: string) => AppRunnerDataStub,
  authorityInput: AppRunnerAuthority,
  statement: string,
  bindings?: unknown[],
): Promise<unknown[]> {
  const authority = captureAppRunnerAuthority(authorityInput);
  const dataRunnerName = buildAppDataRunnerName(
    authority.kernelOwnerUid,
    authority.ownerUid,
    authority.packageId,
  );
  return getRunner(dataRunnerName).packageSqlExecIsolated(
    dataRunnerName,
    authority,
    statement,
    bindings,
  );
}

export function appRpcScheduleAuthorityForRunner(
  authorityInput: AppRunnerAuthority,
): AppRpcScheduleAuthority {
  const authority = captureAppRunnerAuthority(authorityInput);
  if (!authority.kernelUsername || authority.kernelGeneration === undefined) {
    throw new Error("Daemon schedules require provisioned user-Kernel authority");
  }
  const key = appRunnerAuthorityKey(authority);
  return {
    key,
    ownerUid: authority.ownerUid,
    ownerUsername: authority.ownerUsername,
    kernelUsername: authority.kernelUsername,
    kernelGeneration: authority.kernelGeneration,
    packageId: authority.packageId,
    packageName: authority.packageName,
    packageUpdatedAt: authority.packageUpdatedAt,
    artifactHash: authority.artifactHash,
    entrypointName: authority.entrypointName,
    routeBase: authority.routeBase,
    runtime: authority,
  };
}

export function appRunnerAuthorityFromRpcSchedule(
  schedule: AppRpcScheduleAuthority,
): AppRunnerAuthority {
  const authority = captureAppRunnerAuthority(schedule.runtime);
  const expected = appRpcScheduleAuthorityForRunner(authority);
  if (
    expected.key !== schedule.key
    || expected.ownerUid !== schedule.ownerUid
    || expected.ownerUsername !== schedule.ownerUsername
    || expected.kernelUsername !== schedule.kernelUsername
    || expected.kernelGeneration !== schedule.kernelGeneration
    || expected.packageId !== schedule.packageId
    || expected.packageName !== schedule.packageName
    || expected.packageUpdatedAt !== schedule.packageUpdatedAt
    || expected.artifactHash !== schedule.artifactHash
    || expected.entrypointName !== schedule.entrypointName
    || expected.routeBase !== schedule.routeBase
  ) {
    throw new Error("Daemon schedule authority is inconsistent");
  }
  return authority;
}

function captureAppRunnerAuthority(input: unknown): AppRunnerAuthority {
  if (!isRecord(input) || !isRecord(input.artifact)) {
    throw new Error("AppRunner authority is missing");
  }
  const authority = input as unknown as AppRunnerAuthority;
  if (
    !Number.isSafeInteger(authority.kernelOwnerUid)
    || authority.kernelOwnerUid < 0
    || !Number.isSafeInteger(authority.ownerUid)
    || authority.ownerUid < 0
    || typeof authority.ownerUsername !== "string"
    || !authority.ownerUsername
    || (authority.kernelUsername !== undefined && typeof authority.kernelUsername !== "string")
    || (authority.kernelGeneration !== undefined
      && (!Number.isSafeInteger(authority.kernelGeneration) || authority.kernelGeneration <= 0))
    || typeof authority.packageId !== "string"
    || !authority.packageId
    || typeof authority.packageName !== "string"
    || !authority.packageName
    || !Number.isSafeInteger(authority.packageUpdatedAt)
    || authority.packageUpdatedAt <= 0
    || typeof authority.artifactHash !== "string"
    || !authority.artifactHash
    || typeof authority.entrypointName !== "string"
    || !authority.entrypointName
    || typeof authority.routeBase !== "string"
    || !authority.routeBase
    || typeof authority.artifact.hash !== "string"
    || authority.artifact.hash !== authority.artifactHash
  ) {
    throw new Error("AppRunner authority is invalid");
  }
  return structuredClone({
    ...authority,
    artifact: {
      hash: authority.artifact.hash,
      ...(authority.artifact.runtimeAccess
        ? { runtimeAccess: authority.artifact.runtimeAccess }
        : {}),
    },
  });
}

function captureAppRunnerRuntimeEpoch(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) <= 0) {
    throw new Error("Authentication failed");
  }
  return input as number;
}

function runtimeForAppRunnerAuthority(
  input: unknown,
  now: number = Date.now(),
): AppRunnerRuntimeProps {
  const authority = captureAppRunnerAuthority(input);
  return captureAppRunnerRuntime({
    artifact: authority.artifact,
    appFrame: {
      uid: authority.ownerUid,
      username: authority.ownerUsername,
      kernelOwnerUid: authority.kernelOwnerUid,
      ...(authority.kernelUsername ? { kernelUsername: authority.kernelUsername } : {}),
      ...(authority.kernelGeneration !== undefined
        ? { kernelGeneration: authority.kernelGeneration }
        : {}),
      packageId: authority.packageId,
      packageName: authority.packageName,
      packageUpdatedAt: authority.packageUpdatedAt,
      packageArtifactHash: authority.artifactHash,
      entrypointName: authority.entrypointName,
      routeBase: authority.routeBase,
      issuedAt: now,
      expiresAt: now + DEFAULT_APP_FRAME_TTL_MS,
    },
  });
}

function sameAppRunnerAuthority(left: AppRunnerAuthority, right: AppRunnerAuthority): boolean {
  return appRunnerAuthorityKey(left) === appRunnerAuthorityKey(right);
}

export function appRunnerRuntimeMatchesAuthority(
  runtime: unknown,
  authority: AppRunnerAuthority,
): boolean {
  try {
    return sameAppRunnerAuthority(appRunnerAuthorityForRuntime(runtime), authority);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

class AppSocketError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "AppSocketError";
  }
}

export class AppSocketBodyTransport {
  private readonly channels = new Map<WebSocket, BinaryBodyChannel>();

  receive(socket: WebSocket, descriptor: BinaryFrameDescriptor): BinaryBody {
    return this.channel(socket).receive(descriptor);
  }

  handleBinary(socket: WebSocket, message: ArrayBuffer): boolean {
    return this.channel(socket).handleFrame(message);
  }

  async send(socket: WebSocket, frame: AppSocketFrame, body?: BinaryBody): Promise<void> {
    if (!body) {
      socket.send(JSON.stringify(frame));
      return;
    }
    const outgoing = this.channel(socket).prepare(body);
    try {
      socket.send(JSON.stringify({
        ...frame,
        body: outgoing.descriptor,
      }));
    } catch (error) {
      await outgoing.cancel(error);
      throw error;
    }
    // Once the descriptor is sent, transfer failures are reported on the binary stream.
    await outgoing.send().catch(() => {});
  }

  close(socket: WebSocket, reason = "App socket closed"): void {
    this.channels.get(socket)?.close(new Error(reason));
    this.channels.delete(socket);
  }

  private channel(socket: WebSocket): BinaryBodyChannel {
    let channel = this.channels.get(socket);
    if (!channel) {
      channel = new BinaryBodyChannel({
        sendFrame: (binary) => socket.send(binary),
      });
      this.channels.set(socket, channel);
    }
    return channel;
  }
}

export async function requestAppKernelFrame(
  kernel: KernelAppStub,
  appFrame: AppFrameContext,
  call: string,
  args?: unknown,
  options: { body?: BinaryBody } = {},
  runnerName?: string,
): Promise<{ data: unknown; body?: BinaryBody }> {
  try {
    const frame = {
      type: "req",
      id: crypto.randomUUID(),
      call,
      args,
      ...(options.body ? { body: options.body } : {}),
    } as RequestFrame;
    const response = runnerName === undefined
      ? await kernel.appRequest(appFrame, frame)
      : await kernel.appRequest(appFrame, frame, runnerName);
    if (!response.ok) {
      throw new AppSocketError(response.error.code, response.error.message);
    }
    return {
      data: response.data ?? {},
      ...(response.body ? { body: response.body } : {}),
    };
  } catch (error) {
    await cancelUnlockedBody(options.body, "App request failed");
    throw error;
  }
}

async function cancelUnlockedBody(body: BinaryBody | undefined, reason: string): Promise<void> {
  if (body && !body.stream.locked) {
    await body.stream.cancel(reason).catch(() => {});
  }
}

export class GsvApiBinding extends WorkerEntrypoint<Env, GsvApiBindingProps> {
  async fetch(request: Request): Promise<Response> {
    const authority = this.#getAuthority();
    return this.#getRunner(authority).packageOutboundFetch(
      this.#getRuntimeEpoch(),
      authority,
      request,
    );
  }

  async kernelRequest(appFrame: AppFrameContext, call: string, args?: unknown): Promise<unknown> {
    const response = await this.kernelRequestFrame(appFrame, call, args);
    if (response.body) {
      await response.body.stream.cancel(`${call} returned a body`).catch(() => {});
      throw new Error(`${call} returned a body; use kernel.requestFrame()`);
    }
    return response.data;
  }

  async kernelRequestFrame(
    appFrame: AppFrameContext,
    call: string,
    args?: unknown,
    options: { body?: BinaryBody } = {},
  ): Promise<{ data: unknown; body?: BinaryBody }> {
    try {
      const authority = this.#assertAppFrameAuthority(appFrame);
      return await this.#getRunner(authority).packageKernelRequestFrame(
        this.#getRuntimeEpoch(),
        authority,
        appFrame,
        call,
        args,
        options,
      );
    } catch (error) {
      await cancelUnlockedBody(options.body, "App request rejected");
      throw error;
    }
  }

  async upsertRpcSchedule(input: unknown): Promise<unknown> {
    const authority = this.#getAuthority();
    this.#requireDaemonAccess(authority);
    const runner = this.#getRunner(authority);
    return runner.upsertRpcSchedule(this.#getRuntimeEpoch(), authority, input);
  }

  async removeRpcSchedule(key: string): Promise<{ removed: boolean }> {
    const authority = this.#getAuthority();
    this.#requireDaemonAccess(authority);
    const runner = this.#getRunner(authority);
    return runner.removeRpcSchedule(this.#getRuntimeEpoch(), authority, key);
  }

  async listRpcSchedules(): Promise<unknown[]> {
    const authority = this.#getAuthority();
    this.#requireDaemonAccess(authority);
    const runner = this.#getRunner(authority);
    return runner.listRpcSchedules(this.#getRuntimeEpoch(), authority);
  }

  async packageSqlExec(statement: string, bindings?: unknown[]): Promise<unknown[]> {
    const authority = this.#getAuthority();
    this.#requireStorageSqlAccess(authority);
    const runner = this.#getRunner(authority);
    return runner.packageSqlExec(
      this.#getRuntimeEpoch(),
      authority,
      statement,
      bindings,
    );
  }

  async emitAppEvent(
    event: string,
    payload?: unknown,
    clientId?: string,
    sessionId?: string,
  ): Promise<{ delivered: number }> {
    const authority = this.#getAuthority();
    const runner = this.#getRunner(authority);
    return runner.emitAppEvent(
      this.#getRuntimeEpoch(),
      authority,
      event,
      payload,
      clientId,
      sessionId,
    );
  }

  #assertAppFrameAuthority(appFrame: AppFrameContext): AppRunnerAuthority {
    const authority = this.#getAuthority();
    let requestAuthority: AppRunnerAuthority;
    try {
      requestAuthority = appRunnerAuthorityForRuntime({
        artifact: authority.artifact,
        appFrame,
      });
    } catch {
      throw new Error("Authentication failed");
    }
    if (!sameAppRunnerAuthority(requestAuthority, authority)) {
      throw new Error("Authentication failed");
    }
    return authority;
  }

  #getAuthority(): AppRunnerAuthority {
    try {
      return captureAppRunnerAuthority(this.ctx.props?.authority);
    } catch {
      throw new Error("Authentication failed");
    }
  }

  #getRuntimeEpoch(): number {
    return captureAppRunnerRuntimeEpoch(this.ctx.props?.runtimeEpoch);
  }

  #getRunner(authority: AppRunnerAuthority): AppRunnerDaemonStub {
    const runnerName = this.#getRunnerName(authority);
    return this.ctx.exports.AppRunner.getByName(runnerName) as unknown as AppRunnerDaemonStub;
  }

  #getRunnerName(authority: AppRunnerAuthority): string {
    const runnerName = this.ctx.props?.appRunnerName;
    if (runnerName !== buildAppRunnerName(
      authority.kernelOwnerUid,
      authority.ownerUid,
      authority.packageId,
    )) {
      throw new Error("Authentication failed");
    }
    return runnerName;
  }

  #requireDaemonAccess(authority: AppRunnerAuthority): void {
    if (authority.artifact.runtimeAccess?.daemon?.rpcSchedules !== true) {
      throw new Error("Package daemon capability is not approved");
    }
  }

  #requireStorageSqlAccess(authority: AppRunnerAuthority): void {
    if (authority.artifact.runtimeAccess?.storage?.sql !== true) {
      throw new Error("Package storage sql capability is not approved");
    }
  }
}

export class AppRunner extends DurableObject<Env> {
  private readonly daemonSchedules: AppRpcScheduleStore;
  private readonly appClients = new Map<string, RegisteredAppClient>();
  private readonly appSocketBodies = new AppSocketBodyTransport();
  private readonly packageRuntimeFence: AppRunnerPackageRuntimeFenceGate;
  private readonly runnerRole: "control" | "data" | "invalid";
  private controlSchemaReady: boolean;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.runnerRole = isAppRunnerControlName(ctx.id.name)
      ? "control"
      : isAppDataRunnerName(ctx.id.name)
        ? "data"
        : "invalid";
    this.controlSchemaReady = this.runnerRole === "control"
      && initializeAppRunnerControlSchema(ctx.storage);
    this.daemonSchedules = new AppRpcScheduleStore(ctx.storage.sql);
    this.packageRuntimeFence = new AppRunnerPackageRuntimeFenceGate(
      ctx.storage.kv,
      ctx.id.name ?? "",
    );
    if (this.controlSchemaReady && this.packageRuntimeFence.isAdmissionClosed()) {
      this.#closeAllAppSockets("Package runtime authority is fenced");
    } else if (this.controlSchemaReady) {
      this.#restoreAppClients();
    }
  }

  async prepareAppRunnerRuntimeFence(
    input: AppRunnerRuntimeFenceInput,
  ): Promise<AppRunnerRuntimeFenceAck> {
    return this.packageRuntimeFence.prepare(
      input,
      (authorization) => this.#authorizePackageRuntimeFence(authorization),
      async () => {
        this.#closeAllAppSockets("Package runtime authority is fenced");
        if (this.runnerRole === "control") {
          await this.ctx.storage.deleteAlarm();
        }
      },
      () => {
        if (this.runnerRole === "control" && this.controlSchemaReady) {
          this.daemonSchedules.interruptRunning(
            "Package runtime authority was fenced",
          );
        }
      },
    );
  }

  async clearAppRunnerRuntimeFence(
    input: AppRunnerRuntimeFenceInput,
  ): Promise<AppRunnerRuntimeFenceAck> {
    return this.packageRuntimeFence.clear(
      input,
      (authorization) => this.#authorizePackageRuntimeFence(authorization),
      async () => {
        if (this.runnerRole === "control" && this.controlSchemaReady) {
          await this.#syncDaemonAlarm();
        }
      },
    );
  }

  async gsvFetch(request: Request, input: AppRunnerRuntimeProps): Promise<Response> {
    const operation = this.packageRuntimeFence.acquireOperation();
    let fetchOwnsOperation = false;
    try {
      this.#assertControlSchemaReady();
      const runtime = this.#runtimeFor(captureAppRunnerRuntime(input));
      this.#assertControlRunner(appRunnerAuthorityForRuntime(runtime.runtime));
      await this.#requireCurrentRuntime(runtime.runtime.appFrame);
      operation.assertCurrent();
      const entrypoint = this.#getAppEntrypoint(runtime, operation.runtimeEpoch);
      fetchOwnsOperation = true;
      return await forwardAppRunnerFetchOperation(
        request,
        operation,
        (forwardedRequest) => entrypoint.fetch(forwardedRequest),
      );
    } finally {
      if (!fetchOwnsOperation) {
        if (request.body && !request.body.locked) {
          await request.body.cancel("App request was not admitted").catch(() => {});
        }
        operation.release();
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (this.runnerRole !== "control") {
      return new Response("Not Found", {
        status: 404,
        headers: { "cache-control": "no-store" },
      });
    }
    try {
      this.#assertControlSchemaReady();
    } catch {
      return new Response("AppRunner control migration required", {
        status: 503,
        headers: { "cache-control": "no-store" },
      });
    }
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return await this.#acceptAppSocket(request);
    }
    return new Response("AppRunner fetch requires an authorized socket context", {
      status: 400,
      headers: { "cache-control": "no-store" },
    });
  }

  async deliverSignal(input: AppRunnerSignalInput): Promise<void> {
    await this.#runPackageRuntimeOperation(async (operation) => {
      this.#assertControlSchemaReady();
      const runtime = this.#runtimeForSignal(input);
      this.#assertControlRunner(appRunnerAuthorityForRuntime(runtime.runtime));
      await this.#requireCurrentRuntime(runtime.runtime.appFrame);
      operation.assertCurrent();
      await operation.waitForOpaqueCall(
        () => this.#getSignalEntrypoint(
          runtime,
          input,
          operation.runtimeEpoch,
        ).run(input.signal),
      );
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.runnerRole !== "control") {
      this.#closeSocket(ws, 1008, "AppRunner role does not accept sockets");
      return;
    }
    try {
      this.#assertControlSchemaReady();
    } catch {
      this.#closeSocket(ws, 1011, "AppRunner control migration required");
      return;
    }
    const attachment = this.#getSocketAttachment(ws);
    if (
      !attachment?.connected
      || !attachment.session
      || !isAppSessionCurrent(attachment.session)
    ) {
      this.#closeSocket(ws, 1008, "app session expired");
      return;
    }
    let operation: AppRunnerPackageRuntimeOperation;
    try {
      operation = this.packageRuntimeFence.acquireOperation();
    } catch {
      this.#closeSocket(ws, 1012, "Package runtime authority is fenced");
      return;
    }
    try {
      if (message instanceof ArrayBuffer) {
        operation.assertCurrent();
        if (!this.appSocketBodies.handleBinary(ws, message)) {
          this.#closeSocket(ws, 1003, "Invalid binary app frame");
        }
        return;
      }

      let frame: unknown;
      try {
        frame = JSON.parse(message);
      } catch {
        this.#closeSocket(ws, 1003, "Invalid JSON frame");
        return;
      }

      if (!this.#isAppRequestFrame(frame)) {
        this.#closeSocket(ws, 1003, "Expected app request frame");
        return;
      }

      let body: BinaryBody | undefined;
      let responseBody: BinaryBody | undefined;
      try {
        body = frame.body ? this.appSocketBodies.receive(ws, frame.body) : undefined;
        operation.assertCurrent();
        const response = await this.#handleAppSocketRequest(
          ws,
          frame,
          operation,
          body,
        );
        responseBody = response.body;
        operation.assertCurrent();
        await this.appSocketBodies.send(ws, {
          type: "res",
          id: frame.id,
          ok: true,
          ...(response.data === undefined ? {} : { data: response.data }),
        }, response.body);
      } catch (error) {
        const { code, message: errorMessage } = this.#frameError(error);
        this.#sendSocketFrame(ws, {
          type: "res",
          id: frame.id,
          ok: false,
          error: {
            code,
            message: errorMessage,
          },
        });
      } finally {
        await cancelUnlockedBody(body, "App request completed");
        await cancelUnlockedBody(responseBody, "App response completed");
      }
    } finally {
      operation.release();
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.appSocketBodies.close(ws);
    this.#removeAppClientBySocket(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.appSocketBodies.close(ws, "App socket failed");
    this.#removeAppClientBySocket(ws);
  }

  async runCommand(input: AppRunnerCommandInput): Promise<unknown> {
    return this.#runPackageRuntimeOperation(async (operation) => {
      this.#assertControlSchemaReady();
      const captured = captureAppRunnerRuntime(input.runtime);
      this.#assertControlRunner(appRunnerAuthorityForRuntime(captured));
      if (captured.appFrame.entrypointName !== input.commandName) {
        throw new Error("Package command authority does not match the requested entrypoint");
      }
      const runtime = this.#runtimeFor(captured);
      await this.#requireCurrentRuntime(runtime.runtime.appFrame);
      operation.assertCurrent();
      return operation.waitForOpaqueCall(
        () => this.#getCommandEntrypoint(
          runtime,
          input.commandName,
          operation.runtimeEpoch,
        ).run({
          commandName: input.commandName,
          args: input.args,
          cwd: input.cwd,
          uid: captured.appFrame.uid,
          gid: input.gid,
          username: captured.appFrame.username,
        }),
      );
    });
  }

  async packageKernelRequestFrame(
    runtimeEpochInput: number,
    authorityInput: AppRunnerAuthority,
    appFrame: AppFrameContext,
    call: string,
    args?: unknown,
    options: { body?: BinaryBody } = {},
  ): Promise<{ data: unknown; body?: BinaryBody }> {
    try {
      const runtimeEpoch = captureAppRunnerRuntimeEpoch(runtimeEpochInput);
      return await this.#runPackageRuntimeOperation(async (operation) => {
        this.#assertControlSchemaReady();
        const authority = captureAppRunnerAuthority(authorityInput);
        this.#assertControlRunner(authority);
        let requestAuthority: AppRunnerAuthority;
        try {
          requestAuthority = appRunnerAuthorityForRuntime({
            artifact: authority.artifact,
            appFrame,
          });
        } catch {
          throw new Error("Authentication failed");
        }
        if (!sameAppRunnerAuthority(requestAuthority, authority)) {
          throw new Error("Authentication failed");
        }
        await this.#requireCurrentRuntime(appFrame);
        operation.assertCurrent();
        const kernel = await resolveAppKernelForFrame(
          this.env,
          appFrame,
          call,
          this.ctx.id.name,
        );
        if (!kernel) {
          throw new Error("Authentication failed");
        }
        return requestAppKernelFrame(
          kernel,
          appFrame,
          call,
          args,
          options,
          this.ctx.id.name,
        );
      }, runtimeEpoch);
    } catch (error) {
      await cancelUnlockedBody(options.body, "App request rejected");
      throw error;
    }
  }

  async upsertRpcSchedule(
    runtimeEpochInput: number,
    authorityInput: AppRunnerAuthority,
    input: unknown,
  ): Promise<unknown> {
    const runtimeEpoch = captureAppRunnerRuntimeEpoch(runtimeEpochInput);
    return this.#runPackageRuntimeOperation(async (operation) => {
      this.#assertControlSchemaReady();
      const authority = await this.#requireCurrentAuthority(authorityInput, true);
      operation.assertCurrent();
      const record = this.daemonSchedules.upsert(
        appRpcScheduleAuthorityForRunner(authority),
        this.#normalizeRpcScheduleInput(input),
      );
      await this.#syncDaemonAlarm();
      return this.#serializeDaemonRecord(record);
    }, runtimeEpoch);
  }

  async removeRpcSchedule(
    runtimeEpochInput: number,
    authorityInput: AppRunnerAuthority,
    key: string,
  ): Promise<{ removed: boolean }> {
    const runtimeEpoch = captureAppRunnerRuntimeEpoch(runtimeEpochInput);
    return this.#runPackageRuntimeOperation(async (operation) => {
      this.#assertControlSchemaReady();
      const authority = await this.#requireCurrentAuthority(authorityInput, true);
      operation.assertCurrent();
      const removed = this.daemonSchedules.remove(
        appRpcScheduleAuthorityForRunner(authority),
        key,
      );
      await this.#syncDaemonAlarm();
      return { removed };
    }, runtimeEpoch);
  }

  async listRpcSchedules(
    runtimeEpochInput: number,
    authorityInput: AppRunnerAuthority,
  ): Promise<unknown[]> {
    const runtimeEpoch = captureAppRunnerRuntimeEpoch(runtimeEpochInput);
    return this.#runPackageRuntimeOperation(async (operation) => {
      this.#assertControlSchemaReady();
      const authority = await this.#requireCurrentAuthority(authorityInput, true);
      operation.assertCurrent();
      return this.daemonSchedules
        .list(appRpcScheduleAuthorityForRunner(authority))
        .map((record) => this.#serializeDaemonRecord(record));
    }, runtimeEpoch);
  }

  async packageSqlExec(
    runtimeEpochInput: number,
    authorityInput: AppRunnerAuthority,
    statement: string,
    bindings?: unknown[],
  ): Promise<unknown[]> {
    const runtimeEpoch = captureAppRunnerRuntimeEpoch(runtimeEpochInput);
    return this.#runPackageRuntimeOperation(async (operation) => {
      this.#assertControlSchemaReady(true);
      const authority = await this.#requireCurrentAuthority(authorityInput);
      if (authority.artifact.runtimeAccess?.storage?.sql !== true) {
        throw new Error("Package storage sql capability is not approved");
      }
      operation.assertCurrent();
      return forwardPackageSqlToDataRunner(
        (name) => this.ctx.exports.AppRunner.getByName(name) as unknown as AppRunnerDataStub,
        authority,
        statement,
        bindings,
      );
    }, runtimeEpoch);
  }

  async packageSqlExecIsolated(
    expectedRunnerName: string,
    authorityInput: AppRunnerAuthority,
    statement: string,
    bindings?: unknown[],
  ): Promise<unknown[]> {
    if (this.runnerRole !== "data") {
      throw new Error("Package SQL is isolated from the AppRunner control database");
    }
    const authority = captureAppRunnerAuthority(authorityInput);
    const dataRunnerName = buildAppDataRunnerName(
      authority.kernelOwnerUid,
      authority.ownerUid,
      authority.packageId,
    );
    if (
      expectedRunnerName !== dataRunnerName
      || this.ctx.id.name !== dataRunnerName
    ) {
      throw new Error("Package SQL is isolated from the AppRunner control database");
    }
    if (authority.artifact.runtimeAccess?.storage?.sql !== true) {
      throw new Error("Package storage sql capability is not approved");
    }
    return this.#runPackageRuntimeOperation(async (operation) => {
      await this.#requireCurrentRuntime(runtimeForAppRunnerAuthority(authority).appFrame);
      operation.assertCurrent();
      const normalizedStatement = typeof statement === "string" ? statement.trim() : "";
      if (!normalizedStatement) {
        throw new Error("package sql statement is required");
      }
      const normalizedBindings = Array.isArray(bindings)
        ? bindings.map((value) => this.#normalizeSqlBindingValue(value))
        : [];
      const rows = this.ctx.storage.sql.exec<Record<string, SqlStorageValue>>(
        normalizedStatement,
        ...normalizedBindings,
      ).toArray();
      return rows.map((row) => this.#serializeSqlRow(row));
    });
  }

  async packageOutboundFetch(
    runtimeEpochInput: number,
    authorityInput: AppRunnerAuthority,
    request: Request,
  ): Promise<Response> {
    const runtimeEpoch = captureAppRunnerRuntimeEpoch(runtimeEpochInput);
    const operation = this.packageRuntimeFence.acquireOperation(runtimeEpoch);
    let fetchOwnsOperation = false;
    try {
      this.#assertControlSchemaReady();
      const authority = await this.#requireCurrentAuthority(authorityInput);
      operation.assertCurrent();
      const url = new URL(request.url);
      if (!isPackageOutboundAllowed(authority.artifact.runtimeAccess?.egress, url)) {
        throw new Error(`Outbound request denied: ${url.origin}`);
      }
      fetchOwnsOperation = true;
      return await forwardAppRunnerFetchOperation(
        request,
        operation,
        (outboundRequest) => fetch(outboundRequest),
        { redirect: "manual" },
      );
    } finally {
      if (!fetchOwnsOperation) {
        if (request.body && !request.body.locked) {
          await request.body.cancel("Outbound request was not admitted").catch(() => {});
        }
        operation.release();
      }
    }
  }

  async emitAppEvent(
    runtimeEpochInput: number,
    authorityInput: AppRunnerAuthority,
    event: string,
    payload?: unknown,
    clientId?: string,
    sessionId?: string,
  ): Promise<{ delivered: number }> {
    const runtimeEpoch = captureAppRunnerRuntimeEpoch(runtimeEpochInput);
    return this.#runPackageRuntimeOperation(async (operation) => {
      this.#assertControlSchemaReady();
      const authority = await this.#requireCurrentAuthority(authorityInput);
      operation.assertCurrent();
      const normalizedEvent = typeof event === "string" ? event.trim() : "";
      if (!normalizedEvent) {
        throw new Error("app event name is required");
      }
      const targetClientId = typeof clientId === "string" && clientId.trim().length > 0
        ? clientId.trim()
        : null;
      const targetSessionId = typeof sessionId === "string" && sessionId.trim().length > 0
        ? sessionId.trim()
        : null;
      const delivered = await this.#emitAppEventToClients(
        authority,
        normalizedEvent,
        payload,
        targetClientId,
        targetSessionId,
      );
      return { delivered };
    }, runtimeEpoch);
  }

  async closeAppSession(sessionId: string): Promise<{ closed: number }> {
    this.#assertControlSchemaReady();
    const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!normalizedSessionId) {
      return { closed: 0 };
    }

    this.#restoreAppClients();
    let closed = 0;
    for (const registration of [...this.appClients.values()]) {
      if (registration.session.sessionId !== normalizedSessionId) {
        continue;
      }
      this.#closeSocket(registration.socket, 1000, "app session closed");
      closed += 1;
    }
    return { closed };
  }

  async closeAppClient(sessionId: string, clientId: string): Promise<{ closed: number }> {
    this.#assertControlSchemaReady();
    const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
    const normalizedClientId = typeof clientId === "string" ? clientId.trim() : "";
    if (!normalizedSessionId || !normalizedClientId) {
      return { closed: 0 };
    }

    this.#restoreAppClients();
    const key = appClientKeyFor(normalizedSessionId, normalizedClientId);
    const registration = this.appClients.get(key);
    if (!registration) {
      return { closed: 0 };
    }
    this.#closeSocket(registration.socket, 1000, "app client detached");
    return { closed: 1 };
  }

  async #acceptAppSocket(request: Request): Promise<Response> {
    const context = this.#appSocketContextFromRequest(request);
    if (!context || !isAppSessionCurrent(context.session)) {
      return new Response("App socket context is missing or invalid", {
        status: 400,
        headers: { "cache-control": "no-store" },
      });
    }
    let runtime: AppRunnerRuntimeProps;
    try {
      runtime = captureAppRunnerRuntime(context.runtime);
    } catch {
      return new Response("App socket context is missing or invalid", {
        status: 400,
        headers: { "cache-control": "no-store" },
      });
    }
    if (
      runtime.appFrame.sessionId !== context.session.sessionId
      || runtime.appFrame.clientId !== context.session.clientId
      || runtime.appFrame.expiresAt > context.session.expiresAt
    ) {
      return new Response("App socket authority does not match its session", {
        status: 401,
        headers: { "cache-control": "no-store" },
      });
    }
    try {
      this.#assertControlRunner(appRunnerAuthorityForRuntime(runtime));
    } catch {
      return new Response("Authentication failed", {
        status: 401,
        headers: { "cache-control": "no-store" },
      });
    }
    let operation: AppRunnerPackageRuntimeOperation;
    try {
      operation = this.packageRuntimeFence.acquireOperation();
    } catch {
      return new Response("Package runtime authority is fenced", {
        status: 503,
        headers: { "cache-control": "no-store" },
      });
    }
    try {
      try {
        await this.#requireCurrentRuntime(runtime.appFrame);
        operation.assertCurrent();
      } catch {
        return new Response("Authentication failed", {
          status: 401,
          headers: { "cache-control": "no-store" },
        });
      }

      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, [APP_SOCKET_TAG]);
      this.#registerAppSocket(server, context.session, runtime);
      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    } finally {
      operation.release();
    }
  }

  async #handleAppSocketRequest(
    ws: WebSocket,
    frame: AppRequestFrame,
    operation: AppRunnerPackageRuntimeOperation,
    body?: BinaryBody,
  ): Promise<AppSocketResult> {
    const client = this.#clientForSocket(ws);
    if (!client) {
      throw new AppSocketError(401, "App socket is not connected");
    }
    try {
      this.#assertControlRunner(appRunnerAuthorityForRuntime(client.runtime));
      await this.#requireCurrentRuntime(
        this.#runtimeWithSession(client.runtime, client.session).appFrame,
      );
    } catch {
      throw new AppSocketError(401, "Authentication failed");
    }
    switch (frame.call) {
      case "backend.invoke":
        if (body) {
          throw new AppSocketError(400, "backend.invoke does not accept a body");
        }
        return {
          data: await this.#invokeBackendFromSocket(
            ws,
            frame.args,
            operation,
          ),
        };
      case "kernel.request":
        return this.#kernelRequestFromSocket(ws, frame.args, body);
      case "app.ping":
        if (body) {
          throw new AppSocketError(400, "app.ping does not accept a body");
        }
        return { data: { ok: true, timestamp: Date.now() } };
      default:
        throw new AppSocketError(404, `Unknown app call: ${frame.call}`);
    }
  }

  async #invokeBackendFromSocket(
    ws: WebSocket,
    args: unknown,
    operation: AppRunnerPackageRuntimeOperation,
  ): Promise<unknown> {
    const client = this.#clientForSocket(ws);
    if (!client) {
      throw new AppSocketError(401, "App socket is not connected");
    }
    const runtime = this.#runtimeWithSession(client.runtime, client.session);
    const appFrame = runtime.appFrame;
    const kernel = await resolveAppKernelForFrame(
      this.env,
      appFrame,
      undefined,
      this.ctx.id.name,
    );
    if (!kernel || !(await kernel.authorizeAppFrame(appFrame, this.ctx.id.name))) {
      throw new AppSocketError(401, "Authentication failed");
    }
    const record = this.#record(args);
    const method = typeof record?.method === "string" ? record.method.trim() : "";
    if (!method) {
      throw new AppSocketError(400, "backend.invoke requires method");
    }
    return operation.waitForOpaqueCall(
      () => this.#getRpcEntrypoint(
        this.#runtimeFor(runtime, client.session),
        operation.runtimeEpoch,
      ).invoke(
        method,
        record?.args,
      ),
    );
  }

  async #kernelRequestFromSocket(
    ws: WebSocket,
    args: unknown,
    body?: BinaryBody,
  ): Promise<AppSocketResult> {
    const client = this.#clientForSocket(ws);
    if (!client) {
      throw new AppSocketError(401, "App socket is not connected");
    }
    const record = this.#record(args);
    const call = typeof record?.call === "string" ? record.call.trim() : "";
    if (!call) {
      throw new AppSocketError(400, "kernel.request requires call");
    }
    const appFrame = this.#runtimeWithSession(client.runtime, client.session).appFrame;
    const kernel = await resolveAppKernelForFrame(
      this.env,
      appFrame,
      call,
      this.ctx.id.name,
    );
    if (!kernel) {
      throw new AppSocketError(401, "Authentication failed");
    }
    return await requestAppKernelFrame(
      kernel,
      appFrame,
      call,
      record?.args,
      { body },
      this.ctx.id.name,
    );
  }

  async alarm(): Promise<void> {
    this.#assertControlSchemaReady();
    if (this.packageRuntimeFence.isAdmissionClosed()) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const due = this.daemonSchedules.due(Date.now());
    for (const record of due) {
      if (this.packageRuntimeFence.isAdmissionClosed()) break;
      await this.#runDueRpcSchedule(record);
    }
    if (this.packageRuntimeFence.isAdmissionClosed()) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.#syncDaemonAlarm();
    }
  }

  #runtimeFor(
    runtime: AppRunnerRuntimeProps,
    appSession?: AppSessionInfo,
    daemonTrigger?: AppRuntimeContext["daemonTrigger"],
  ): AppRuntimeContext {
    return {
      runtime: appSession ? this.#runtimeWithSession(runtime, appSession) : runtime,
      ...(appSession ? { appSession } : {}),
      ...(daemonTrigger ? { daemonTrigger } : {}),
    };
  }

  #runtimeWithSession(
    runtime: AppRunnerRuntimeProps,
    appSession: AppSessionInfo,
  ): AppRunnerRuntimeProps {
    if (
      !isAppSessionCurrent(appSession)
      || (runtime.appFrame.sessionId !== undefined
        && runtime.appFrame.sessionId !== appSession.sessionId)
      || (runtime.appFrame.clientId !== undefined
        && runtime.appFrame.clientId !== appSession.clientId)
    ) {
      throw new Error("App session does not match runtime authority");
    }
    return captureAppRunnerRuntime({
      artifact: runtime.artifact,
      appFrame: {
        ...runtime.appFrame,
        sessionId: appSession.sessionId,
        clientId: appSession.clientId,
        expiresAt: Math.min(runtime.appFrame.expiresAt, appSession.expiresAt),
      },
    });
  }

  #runtimeForSignal(input: AppRunnerSignalInput): AppRuntimeContext {
    const runtime = captureAppRunnerRuntime(input.runtime);
    if (this.#isAppSessionInfo(input.appSession)) {
      return this.#runtimeFor(runtime, input.appSession);
    }

    const state = input.watch.state && typeof input.watch.state === "object"
      ? input.watch.state as Record<string, unknown>
      : null;
    const sessionId = typeof state?.appSessionId === "string" && state.appSessionId.trim().length > 0
      ? state.appSessionId.trim()
      : null;
    const clientId = typeof state?.clientId === "string" && state.clientId.trim().length > 0
      ? state.clientId.trim()
      : null;
    if (clientId) {
      this.#restoreAppClients();
    }
    const authority = appRunnerAuthorityForRuntime(runtime);
    const appSession = clientId
      ? this.#appSessionForClientId(clientId, sessionId, authority)
      : undefined;
    return this.#runtimeFor(runtime, appSession);
  }

  async #authorizePackageRuntimeFence(
    input: AppRunnerRuntimeFenceAuthorizationInput,
  ): Promise<boolean> {
    const kernel = await getAgentByName(
      this.env.KERNEL,
      input.sourceKernelName,
    ) as unknown as KernelPackageRuntimeFenceAuthorizationStub;
    return await kernel.consumeAppRunnerRuntimeFenceAuthorization(input);
  }

  async #runPackageRuntimeOperation<T>(
    run: (operation: AppRunnerPackageRuntimeOperation) => Promise<T>,
    expectedRuntimeEpoch?: number,
  ): Promise<T> {
    const operation = this.packageRuntimeFence.acquireOperation(expectedRuntimeEpoch);
    try {
      const result = await run(operation);
      operation.assertCurrent();
      return result;
    } finally {
      operation.release();
    }
  }

  async #requireCurrentRuntime(appFrame: AppFrameContext): Promise<void> {
    if (isAppFrameContextExpired(appFrame)) {
      throw new Error("Package runtime authorization expired");
    }
    if (!(await resolveAppKernelForFrame(
      this.env,
      appFrame,
      undefined,
      this.ctx.id.name,
    ))) {
      throw new Error("Package runtime authorization expired");
    }
  }

  async #requireCurrentAuthority(
    input: AppRunnerAuthority,
    requireDaemon = false,
  ): Promise<AppRunnerAuthority> {
    const authority = captureAppRunnerAuthority(input);
    this.#assertControlRunner(authority);
    if (requireDaemon && authority.artifact.runtimeAccess?.daemon?.rpcSchedules !== true) {
      throw new Error("Package daemon capability is not approved");
    }
    await this.#requireCurrentRuntime(runtimeForAppRunnerAuthority(authority).appFrame);
    return authority;
  }

  #assertControlRunner(authority: AppRunnerAuthority): void {
    const expected = buildAppRunnerName(
      authority.kernelOwnerUid,
      authority.ownerUid,
      authority.packageId,
    );
    if (this.ctx.id.name !== expected) {
      throw new Error("AppRunner authority does not match the selected object");
    }
  }

  #assertControlSchemaReady(packageStorage = false): void {
    if (
      this.runnerRole === "control"
      &&
      this.controlSchemaReady
      && appRunnerControlSchemaIsCurrent(this.ctx.storage.sql)
    ) {
      return;
    }
    this.controlSchemaReady = false;
    throw new Error(packageStorage
      ? "Package storage migration required"
      : "AppRunner control migration required");
  }

  #registerAppSocket(
    ws: WebSocket,
    session: AppSessionInfo,
    runtime: AppRunnerRuntimeProps,
  ): void {
    const key = appClientKey(session);
    const previous = this.appClients.get(key);
    if (previous && previous.socket !== ws) {
      this.#closeSocket(previous.socket, 1000, "Replaced by newer app connection");
    }
    ws.serializeAttachment({
      kind: "app-client",
      connected: true,
      session,
      runtime,
      connectedAt: Date.now(),
    } satisfies AppSocketAttachment);
    this.appClients.set(key, {
      socket: ws,
      session,
      runtime,
      registeredAt: Date.now(),
    });
  }

  #restoreAppClients(): void {
    this.appClients.clear();
    for (const socket of this.ctx.getWebSockets(APP_SOCKET_TAG)) {
      const attachment = this.#getSocketAttachment(socket);
      if (!attachment?.connected || !attachment.session || !attachment.runtime) {
        continue;
      }
      if (!isAppSessionCurrent(attachment.session)) {
        this.#closeSocket(socket, 1008, "app session expired");
        continue;
      }
      try {
        this.#assertControlRunner(appRunnerAuthorityForRuntime(attachment.runtime));
      } catch {
        this.#closeSocket(socket, 1008, "App socket authority is invalid");
        continue;
      }
      this.appClients.set(appClientKey(attachment.session), {
        socket,
        session: attachment.session,
        runtime: attachment.runtime,
        registeredAt: attachment.connectedAt ?? Date.now(),
      });
    }
  }

  async #emitAppEventToClients(
    authority: AppRunnerAuthority,
    event: string,
    payload: unknown,
    clientId: string | null,
    sessionId: string | null,
  ): Promise<number> {
    this.#restoreAppClients();
    let targets: Array<[string, RegisteredAppClient]>;
    if (clientId) {
      if (!sessionId) {
        throw new Error("targeted app events require an app session id");
      }
      const key = appClientKeyFor(sessionId, clientId);
      const registration = this.appClients.get(key);
      targets = registration ? [[key, registration]] : [];
    } else {
      targets = sessionId
        ? [...this.appClients.entries()].filter(([, registration]) => (
            registration.session.sessionId === sessionId
            && this.#clientHasAuthority(registration, authority)
          ))
        : [...this.appClients.entries()].filter(([, registration]) => (
            this.#clientHasAuthority(registration, authority)
          ));
    }
    if (clientId) {
      targets = targets.filter(([, registration]) => this.#clientHasAuthority(registration, authority));
    }
    let delivered = 0;
    for (const [key, registration] of targets) {
      try {
        this.#sendSocketFrame(registration.socket, {
          type: "sig",
          signal: event,
          payload,
        });
        delivered += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[app-runner] app event delivery failed for ${registration.session.clientId}: ${message}`);
        this.#removeAppClient(key);
      }
    }
    return delivered;
  }

  #removeAppClient(key: string): void {
    const registration = this.appClients.get(key);
    if (!registration) {
      return;
    }
    this.#closeSocket(registration.socket, 1011, "app client removed");
  }

  #removeAppClientBySocket(socket: WebSocket): void {
    for (const [key, registration] of this.appClients) {
      if (registration.socket === socket) {
        this.appClients.delete(key);
      }
    }
  }

  #clientForSocket(socket: WebSocket): RegisteredAppClient | null {
    const attachment = this.#getSocketAttachment(socket);
    if (!attachment?.connected || !attachment.session || !attachment.runtime) {
      return null;
    }
    if (!isAppSessionCurrent(attachment.session)) {
      this.#closeSocket(socket, 1008, "app session expired");
      return null;
    }
    const key = appClientKey(attachment.session);
    const existing = this.appClients.get(key);
    if (existing?.socket === socket) {
      return existing;
    }
    const restored = {
      socket,
      session: attachment.session,
      runtime: attachment.runtime,
      registeredAt: attachment.connectedAt ?? Date.now(),
    };
    try {
      this.#assertControlRunner(appRunnerAuthorityForRuntime(restored.runtime));
    } catch {
      this.#closeSocket(socket, 1008, "App socket authority is invalid");
      return null;
    }
    this.appClients.set(key, restored);
    return restored;
  }

  #appSessionForClientId(
    clientId: string,
    sessionId: string | null | undefined,
    authority: AppRunnerAuthority,
  ): AppSessionInfo | undefined {
    for (const registration of this.appClients.values()) {
      if (
        registration.session.clientId === clientId &&
        (!sessionId || registration.session.sessionId === sessionId) &&
        this.#clientHasAuthority(registration, authority)
      ) {
        return registration.session;
      }
    }
    return undefined;
  }

  #clientHasAuthority(
    registration: RegisteredAppClient,
    authority: AppRunnerAuthority,
  ): boolean {
    return appRunnerRuntimeMatchesAuthority(registration.runtime, authority);
  }

  #sendSocketFrame(socket: WebSocket, frame: AppSocketFrame): void {
    socket.send(JSON.stringify(frame));
  }

  #closeSocket(socket: WebSocket, code: number, reason: string): void {
    this.appSocketBodies.close(socket, reason);
    this.#removeAppClientBySocket(socket);
    try {
      socket.serializeAttachment({
        kind: "app-client",
        connected: false,
      } satisfies AppSocketAttachment);
    } catch {
    }
    try {
      socket.close(code, reason);
    } catch {
    }
  }

  #closeAllAppSockets(reason: string): void {
    for (const socket of this.ctx.getWebSockets(APP_SOCKET_TAG)) {
      this.#closeSocket(socket, 1012, reason);
    }
    this.appClients.clear();
  }

  #getSocketAttachment(socket: WebSocket): AppSocketAttachment | null {
    const attachment = socket.deserializeAttachment();
    return this.#isAppSocketAttachment(attachment) ? attachment : null;
  }

  #appSocketContextFromRequest(request: Request): AppSocketContext | null {
    const raw = request.headers.get("x-gsv-app-socket-context");
    if (!raw) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeURIComponent(raw));
    } catch {
      return null;
    }
    return this.#isAppSocketContext(parsed) ? parsed : null;
  }

  #isAppRequestFrame(value: unknown): value is AppRequestFrame {
    const record = this.#record(value);
    return record?.type === "req" &&
      typeof record.id === "string" &&
      record.id.trim().length > 0 &&
      typeof record.call === "string" &&
      record.call.trim().length > 0;
  }

  #isAppSocketAttachment(value: unknown): value is AppSocketAttachment {
    const record = this.#record(value);
    if (record?.kind !== "app-client" || typeof record.connected !== "boolean") {
      return false;
    }
    if (!record.connected) {
      return true;
    }
    return this.#isAppSessionInfo(record.session) && this.#isAppRunnerRuntime(record.runtime);
  }

  #isAppSocketContext(value: unknown): value is AppSocketContext {
    const record = this.#record(value);
    return Boolean(
      record &&
      this.#isAppSessionInfo(record.session) &&
      this.#isAppRunnerRuntime(record.runtime),
    );
  }

  #isAppSessionInfo(value: unknown): value is AppSessionInfo {
    const session = this.#record(value);
    return Boolean(
      session &&
      typeof session.sessionId === "string" &&
      typeof session.clientId === "string" &&
      typeof session.rpcBase === "string" &&
      typeof session.expiresAt === "number",
    );
  }

  #isAppFrameContext(value: unknown): value is AppFrameContext {
    const appFrame = this.#record(value);
    return Boolean(
      appFrame &&
      typeof appFrame.uid === "number" &&
      typeof appFrame.username === "string" &&
      typeof appFrame.kernelOwnerUid === "number" &&
      (appFrame.kernelUsername === undefined || typeof appFrame.kernelUsername === "string") &&
      (appFrame.kernelGeneration === undefined || typeof appFrame.kernelGeneration === "number") &&
      (appFrame.sessionId === undefined || typeof appFrame.sessionId === "string") &&
      (appFrame.clientId === undefined || typeof appFrame.clientId === "string") &&
      typeof appFrame.packageId === "string" &&
      typeof appFrame.packageName === "string" &&
      typeof appFrame.packageUpdatedAt === "number" &&
      typeof appFrame.packageArtifactHash === "string" &&
      typeof appFrame.entrypointName === "string" &&
      typeof appFrame.routeBase === "string" &&
      typeof appFrame.issuedAt === "number" &&
      typeof appFrame.expiresAt === "number",
    );
  }

  #isAppRunnerRuntime(value: unknown): value is AppRunnerRuntimeProps {
    try {
      captureAppRunnerRuntime(value);
      return true;
    } catch {
      return false;
    }
  }

  #record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  }

  #frameError(error: unknown): { code: number; message: string } {
    if (error instanceof AppSocketError) {
      return { code: error.code, message: error.message };
    }
    return {
      code: 500,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  #loadWorker(runtime: AppRunnerRuntimeProps, runtimeEpoch: number): WorkerStub {
    const authority = appRunnerAuthorityForRuntime(runtime);
    const gsvApi = this.ctx.exports.GsvApiBinding({
      props: {
        appRunnerName: buildAppRunnerName(
          authority.kernelOwnerUid,
          authority.ownerUid,
          authority.packageId,
        ),
        authority,
        runtimeEpoch,
      },
    });
    return this.env.LOADER.get(
      this.#codeKey(runtime, runtimeEpoch),
      async () => bindAppRunnerGlobalOutbound(
        packageArtifactToWorkerCode(
          await loadPackageArtifact(this.env.STORAGE, runtime.artifact.hash),
          {
            PACKAGE_NAME: authority.packageName,
            PACKAGE_ID: authority.packageId,
            PACKAGE_ROUTE_BASE: authority.routeBase,
            GSV_API: gsvApi,
            GSV_PACKAGE_NAME: authority.packageName,
            GSV_PACKAGE_ID: authority.packageId,
            GSV_ROUTE_BASE: authority.routeBase,
            GSV_PACKAGE_PUBLIC_BASE: packageArtifactPublicBase(runtime.artifact.hash),
          },
          runtime.artifact.runtimeAccess,
        ),
        runtime.artifact.runtimeAccess,
        gsvApi,
      ),
    );
  }

  #entrypointProps(
    runtime: AppRuntimeContext,
    runtimeEpoch: number,
    extras?: Record<string, unknown>,
  ): Record<string, unknown> {
    const props = runtime.runtime;
    return {
      packageId: props.appFrame.packageId,
      packageName: props.appFrame.packageName,
      routeBase: props.appFrame.routeBase,
      runtimeEpoch,
      appFrame: props.appFrame,
      ...(props.artifact.runtimeAccess ? { runtimeAccess: props.artifact.runtimeAccess } : {}),
      ...(runtime.appSession ? { appSession: runtime.appSession } : {}),
      ...(runtime.daemonTrigger ? { daemonTrigger: runtime.daemonTrigger } : {}),
      ...(extras ?? {}),
    };
  }

  #getAppEntrypoint(
    runtime: AppRuntimeContext,
    runtimeEpoch: number,
  ): AppFetchEntrypointStub {
    const worker = this.#loadWorker(runtime.runtime, runtimeEpoch);
    return worker.getEntrypoint<AppFetchEntrypointStub>(undefined, {
      props: this.#entrypointProps(runtime, runtimeEpoch),
    });
  }

  #getCommandEntrypoint(
    runtime: AppRuntimeContext,
    commandName: string,
    runtimeEpoch: number,
  ): AppCommandEntrypointStub {
    const worker = this.#loadWorker(runtime.runtime, runtimeEpoch);
    return worker.getEntrypoint<AppCommandEntrypointStub>("GsvCommandEntrypoint", {
      props: this.#entrypointProps(runtime, runtimeEpoch, {
        commandName,
      }),
    });
  }

  #getRpcEntrypoint(
    runtime: AppRuntimeContext,
    runtimeEpoch: number,
  ): AppRpcEntrypointStub {
    const worker = this.#loadWorker(runtime.runtime, runtimeEpoch);
    return worker.getEntrypoint<AppRpcEntrypointStub>("GsvAppRpcEntrypoint", {
      props: this.#entrypointProps(runtime, runtimeEpoch),
    });
  }

  #getSignalEntrypoint(
    runtime: AppRuntimeContext,
    input: AppRunnerSignalInput,
    runtimeEpoch: number,
  ): AppSignalEntrypointStub {
    const worker = this.#loadWorker(runtime.runtime, runtimeEpoch);
    return worker.getEntrypoint<AppSignalEntrypointStub>("GsvAppSignalEntrypoint", {
      props: this.#entrypointProps(runtime, runtimeEpoch, {
        signal: input.signal,
        payload: input.payload,
        sourcePid: input.sourcePid ?? null,
        watch: input.watch,
      }),
    });
  }

  #codeKey(runtime: AppRunnerRuntimeProps, runtimeEpoch: number): string {
    return appRunnerWorkerCodeKey(runtime, runtimeEpoch);
  }

  async #runDueRpcSchedule(record: AppRpcScheduleRecord): Promise<void> {
    if (!record.authority) {
      return;
    }
    let operation: AppRunnerPackageRuntimeOperation;
    try {
      operation = this.packageRuntimeFence.acquireOperation();
    } catch {
      return;
    }
    try {
      const scheduleAuthority = record.authority;
      const firedAt = Date.now();
      const trigger = {
        kind: "schedule" as const,
        key: record.key,
        scheduledAt: record.nextRunAt ?? firedAt,
        firedAt,
      };
      const startedAt = Date.now();
      let status: "ok" | "error" = "ok";
      let errorMessage: string | null = null;
      let disable = false;
      let runtime: AppRuntimeContext | null = null;
      try {
        const authority = appRunnerAuthorityFromRpcSchedule(scheduleAuthority);
        this.#assertControlRunner(authority);
        runtime = this.#runtimeFor(
          runtimeForAppRunnerAuthority(authority, firedAt),
          undefined,
          trigger,
        );
        await this.#requireCurrentRuntime(runtime.runtime.appFrame);
      } catch (error) {
        status = "error";
        disable = true;
        errorMessage = error instanceof Error ? error.message : String(error);
      }
      operation.assertCurrent();
      const running = this.daemonSchedules.markRunning(
        scheduleAuthority,
        record.key,
        record.version,
        firedAt,
      );
      if (!running) return;
      if (runtime) {
        try {
          await operation.waitForOpaqueCall(
            () => this.#getRpcEntrypoint(runtime, operation.runtimeEpoch).invoke(
              record.rpcMethod,
              record.payload,
            ),
          );
        } catch (error) {
          status = "error";
          errorMessage = error instanceof Error ? error.message : String(error);
        }
      }
      operation.assertCurrent();
      if (errorMessage) {
        console.warn(
          `[app-runner] daemon rpc ${record.rpcMethod} (${record.key}) failed: ${errorMessage}`,
        );
      }
      this.daemonSchedules.finishRun({
        authority: scheduleAuthority,
        key: record.key,
        version: record.version,
        finishedAt: Date.now(),
        status,
        error: errorMessage,
        durationMs: Date.now() - startedAt,
        disable,
      });
    } catch (error) {
      if (!operation.signal.aborted) throw error;
    } finally {
      operation.release();
    }
  }

  async #syncDaemonAlarm(): Promise<void> {
    const nextAlarmAt = this.daemonSchedules.nextAlarmAt();
    if (nextAlarmAt === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(nextAlarmAt);
  }

  #normalizeRpcScheduleInput(input: unknown): AppRpcScheduleUpsertInput {
    const record = input && typeof input === "object" ? input as Record<string, unknown> : null;
    const key = typeof record?.key === "string" ? record.key.trim() : "";
    if (!key) {
      throw new Error("daemon schedule key is required");
    }
    const rpcMethod = typeof record?.rpcMethod === "string" ? record.rpcMethod.trim() : "";
    if (!rpcMethod) {
      throw new Error("daemon schedule rpcMethod is required");
    }
    if (!record?.schedule || typeof record.schedule !== "object") {
      throw new Error("daemon schedule is required");
    }
    const enabled = record.enabled === undefined
      ? undefined
      : Boolean(record.enabled);
    return {
      key,
      rpcMethod,
      schedule: record.schedule as AppRpcSchedule,
      payload: record.payload,
      ...(enabled === undefined ? {} : { enabled }),
    };
  }

  #serializeDaemonRecord(record: AppRpcScheduleRecord): Record<string, unknown> {
    return {
      key: record.key,
      rpcMethod: record.rpcMethod,
      schedule: record.schedule,
      ...(record.payload === undefined ? {} : { payload: record.payload }),
      enabled: record.enabled,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      nextRunAt: record.nextRunAt,
      runningAt: record.runningAt,
      lastRunAt: record.lastRunAt,
      lastStatus: record.lastStatus,
      lastError: record.lastError,
      lastDurationMs: record.lastDurationMs,
    };
  }

  #normalizeSqlBindingValue(value: unknown): string | number | null {
    if (
      value === null
      || typeof value === "string"
      || typeof value === "number"
    ) {
      return value;
    }
    if (typeof value === "boolean") {
      return value ? 1 : 0;
    }
    throw new Error("package sql bindings must be string, number, boolean, or null");
  }

  #serializeSqlRow(row: Record<string, SqlStorageValue>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, this.#serializeSqlValue(value)]),
    );
  }

  #serializeSqlValue(value: unknown): unknown {
    if (
      value === null
      || typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean"
    ) {
      return value;
    }
    if (value instanceof ArrayBuffer) {
      return encodeBase64Bytes(value);
    }
    if (ArrayBuffer.isView(value)) {
      return encodeBase64Bytes(value);
    }
    return String(value);
  }
}
