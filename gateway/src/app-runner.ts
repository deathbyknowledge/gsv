import { DurableObject, RpcTarget } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { packageArtifactToWorkerCode, type PackageArtifact } from "./kernel/packages";
import type { AppFrameContext, PackageAppSignalWatchInfo } from "./protocol/app-frame";
import type { RequestFrame, ResponseFrame } from "./protocol/frames";

type AppRunnerProps = {
  packageId: string;
  packageName: string;
  routeBase: string;
  entrypointName: string;
  artifact: PackageArtifact;
  appFrame: AppFrameContext;
};

type AppRunnerSignalInput = {
  signal: string;
  payload?: unknown;
  sourcePid?: string | null;
  watch: PackageAppSignalWatchInfo;
};

type AppSessionInfo = {
  sessionId: string;
  clientId: string;
  rpcBase: string;
  expiresAt: number;
};

type AppFacetRuntime = {
  appFrame: AppFrameContext;
  appSession?: AppSessionInfo;
};

export type AppHttpRequest = {
  url: string;
  method: string;
  headers: Array<[string, string]>;
  body?: ArrayBuffer | null;
};

export type AppHttpResponse = {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body?: ArrayBuffer | null;
};

type KernelAppStub = {
  appRequest(appFrame: AppFrameContext, frame: RequestFrame): Promise<ResponseFrame>;
};

type KernelBridgeStub = Rpc.RpcTargetBranded & {
  request(call: string, args?: unknown): Promise<unknown>;
};

type SignalSinkStub = Rpc.RpcTargetBranded & {
  onSignal(signal: string, envelope: unknown): Promise<void>;
  dup?: () => SignalSinkStub;
  [Symbol.dispose]?: () => void;
};

type AppFacetStub = Rpc.DurableObjectBranded & {
  gsvFetch(request: AppHttpRequest, runtime?: AppFacetRuntime): Promise<AppHttpResponse>;
  gsvInvoke(method: string, args: unknown, runtime?: AppFacetRuntime, kernel?: KernelBridgeStub): Promise<unknown>;
  gsvSubscribeSignal(args: unknown, runtime?: AppFacetRuntime, kernel?: KernelBridgeStub): Promise<unknown>;
  gsvUnsubscribeSignal(args: unknown, runtime?: AppFacetRuntime, kernel?: KernelBridgeStub): Promise<unknown>;
  gsvHandleSignal(
    signalName: string,
    payload?: unknown,
    sourcePid?: string | null,
    watch?: PackageAppSignalWatchInfo,
    runtime?: AppFacetRuntime,
    kernel?: KernelBridgeStub,
  ): Promise<void>;
};

const PROPS_KEY = "app-runner:props";
const RUNTIME_TTL_MS = 365 * 24 * 60 * 60 * 1000;

type LiveSignalSubscription = {
  sink: SignalSinkStub;
  watchKeys: string[];
  processId: string | null;
  signals: string[];
};

class KernelBridge extends RpcTarget {
  constructor(
    private readonly kernel: KernelAppStub,
    private readonly appFrame: AppFrameContext,
  ) {
    super();
  }

  async request(call: string, args?: unknown): Promise<unknown> {
    const frame: RequestFrame = {
      type: "req",
      id: crypto.randomUUID(),
      call,
      args,
    } as RequestFrame;
    const response = await this.kernel.appRequest(this.appFrame, frame);
    if (!response.ok) {
      throw new Error(response.error.message);
    }
    return response.data;
  }
}

class AppRunnerBackendTarget extends RpcTarget {
  constructor(
    private readonly runner: AppRunner,
    private readonly runtime: AppFacetRuntime,
  ) {
    super();
  }

  async invoke(method: string, args?: unknown): Promise<unknown> {
    if (method === "gsvSubscribeSignal") {
      return this.runner.subscribeSignal(args, this.runtime);
    }
    if (method === "gsvUnsubscribeSignal") {
      return this.runner.unsubscribeSignal(args, this.runtime);
    }
    return this.runner.invokeAppRpc(method, args, this.runtime);
  }
}

export async function serializeAppHttpRequest(request: Request): Promise<AppHttpRequest> {
  let body: ArrayBuffer | null = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.clone().arrayBuffer();
  }
  return {
    url: request.url,
    method: request.method,
    headers: Array.from(request.headers.entries()),
    body,
  };
}

export function deserializeAppHttpResponse(response: AppHttpResponse): Response {
  return new Response(response.body ?? null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export class AppRunner extends DurableObject<Env> {
  private readonly liveSignalSubscriptions = new Map<string, LiveSignalSubscription>();

  async ensureRuntime(props: AppRunnerProps): Promise<void> {
    const previous = this.ctx.storage.kv.get<AppRunnerProps>(PROPS_KEY);
    if (
      previous
      && previous.packageId === props.packageId
      && previous.packageName === props.packageName
      && previous.routeBase === props.routeBase
      && previous.entrypointName === props.entrypointName
      && previous.artifact.hash === props.artifact.hash
      && previous.appFrame.uid === props.appFrame.uid
      && previous.appFrame.routeBase === props.appFrame.routeBase
      && previous.appFrame.entrypointName === props.appFrame.entrypointName
    ) {
      return;
    }
    this.ctx.storage.kv.put(PROPS_KEY, props);
  }

  async gsvFetch(request: AppHttpRequest): Promise<AppHttpResponse> {
    return this.#gsvFetch(request, this.#defaultRuntime());
  }

  async fetch(request: Request): Promise<Response> {
    const response = await this.gsvFetch(await serializeAppHttpRequest(request));
    return deserializeAppHttpResponse(response);
  }

  async getBackend(appSession: AppSessionInfo): Promise<AppRunnerBackendTarget> {
    return new AppRunnerBackendTarget(this, this.#defaultRuntime(appSession));
  }

  async deliverSignal(input: AppRunnerSignalInput): Promise<void> {
    const runtime = this.#defaultRuntime();
    await this.#getFacet().gsvHandleSignal(
      input.signal,
      input.payload,
      input.sourcePid ?? null,
      input.watch,
      runtime,
      this.#createKernelBridge(runtime.appFrame),
    );
    await this.#forwardSignalToLiveSubscriber(input, runtime);
  }

  async invokeAppRpc(method: string, args: unknown, runtime: AppFacetRuntime): Promise<unknown> {
    return this.#getFacet().gsvInvoke(method, args, runtime, this.#createKernelBridge(runtime.appFrame));
  }

  async subscribeSignal(args: unknown, runtime: AppFacetRuntime): Promise<unknown> {
    const input = this.#normalizeSignalSubscriptionArgs(args);
    if (!input.sink) {
      throw new Error("signal sink must implement onSignal()");
    }
    if (input.signals.length === 0) {
      throw new Error("signal subscription requires at least one signal");
    }
    const kernel = this.#createKernelBridge(runtime.appFrame);
    const subscriptionId = crypto.randomUUID();
    const watchKeys: string[] = [];
    for (const signal of input.signals) {
      const key = `live:${subscriptionId}:${signal}`;
      await kernel.request("signal.watch", {
        signal,
        ...(input.processId ? { processId: input.processId } : {}),
        key,
        state: { subscriptionId },
        once: false,
      });
      watchKeys.push(key);
    }
    const retainedSink = typeof input.sink.dup === "function"
      ? input.sink.dup()
      : input.sink;
    this.liveSignalSubscriptions.set(subscriptionId, {
      sink: retainedSink,
      watchKeys,
      processId: input.processId,
      signals: input.signals,
    });
    console.debug("[app-runner] subscribe signal", {
      subscriptionId,
      processId: input.processId,
      signals: input.signals,
    });
    return { subscriptionId };
  }

  async unsubscribeSignal(args: unknown, runtime: AppFacetRuntime): Promise<unknown> {
    const subscriptionId =
      typeof (args as { subscriptionId?: unknown } | null)?.subscriptionId === "string"
        ? ((args as { subscriptionId: string }).subscriptionId.trim() || null)
        : null;
    if (!subscriptionId) {
      throw new Error("signal unsubscription requires subscriptionId");
    }
    const removed = await this.#removeLiveSignalSubscription(subscriptionId, this.#createKernelBridge(runtime.appFrame));
    console.debug("[app-runner] unsubscribe signal", {
      subscriptionId,
      removed,
    });
    return { removed };
  }

  async #gsvFetch(request: AppHttpRequest, runtime: AppFacetRuntime): Promise<AppHttpResponse> {
    return this.#getFacet().gsvFetch(request, runtime);
  }

  #defaultRuntime(appSession?: AppSessionInfo): AppFacetRuntime {
    const props = this.#getProps();
    return {
      appFrame: this.#runtimeAppFrame(props),
      ...(appSession ? { appSession } : {}),
    };
  }

  #runtimeAppFrame(props: AppRunnerProps): AppFrameContext {
    const now = Date.now();
    return {
      ...props.appFrame,
      issuedAt: now,
      expiresAt: now + RUNTIME_TTL_MS,
    };
  }

  #kernelStub(): KernelAppStub {
    return this.env.KERNEL.getByName("singleton") as unknown as KernelAppStub;
  }

  #createKernelBridge(appFrame: AppFrameContext): KernelBridge {
    return new KernelBridge(this.#kernelStub(), appFrame);
  }

  #normalizeSignalSubscriptionArgs(args: unknown): {
    processId: string | null;
    signals: string[];
    sink: SignalSinkStub | null;
  } {
    const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
    const processId = typeof record.processId === "string" && record.processId.trim().length > 0
      ? record.processId.trim()
      : null;
    const signals = Array.isArray(record.signals)
      ? Array.from(new Set(record.signals
        .map((value) => typeof value === "string" ? value.trim() : "")
        .filter((value) => value.length > 0)))
      : [];
    const sink = record.sink && (typeof record.sink === "object" || typeof record.sink === "function")
      ? record.sink as SignalSinkStub
      : null;
    return {
      processId,
      signals,
      sink,
    };
  }

  async #forwardSignalToLiveSubscriber(input: AppRunnerSignalInput, runtime: AppFacetRuntime): Promise<void> {
    const state = input.watch.state && typeof input.watch.state === "object"
      ? input.watch.state as Record<string, unknown>
      : null;
    const subscriptionId = typeof state?.subscriptionId === "string"
      ? state.subscriptionId
      : this.#parseSubscriptionIdFromKey(input.watch.key);
    if (!subscriptionId) {
      console.debug("[app-runner] deliver signal without live subscription", {
        signal: input.signal,
        watchId: input.watch.id,
        key: input.watch.key ?? null,
      });
      return;
    }
    const subscription = this.liveSignalSubscriptions.get(subscriptionId);
    console.debug("[app-runner] deliver signal", {
      signal: input.signal,
      subscriptionId,
      hasSubscription: Boolean(subscription),
      watchId: input.watch.id,
      key: input.watch.key ?? null,
      sourcePid: input.sourcePid ?? null,
    });
    if (!subscription) {
      return;
    }
    try {
      await subscription.sink.onSignal(input.signal, {
        payload: input.payload,
        sourcePid: input.sourcePid ?? null,
        watch: input.watch,
      });
      console.debug("[app-runner] forwarded signal", {
        signal: input.signal,
        subscriptionId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[app-runner] signal sink failed for ${subscriptionId}: ${message}`);
      await this.#removeLiveSignalSubscription(subscriptionId, this.#createKernelBridge(runtime.appFrame));
    }
  }

  #parseSubscriptionIdFromKey(key: string | undefined): string | null {
    if (!key || !key.startsWith("live:")) {
      return null;
    }
    const parts = key.split(":");
    return parts.length >= 3 && parts[1] ? parts[1] : null;
  }

  async #removeLiveSignalSubscription(subscriptionId: string, kernel: KernelBridge): Promise<number> {
    const subscription = this.liveSignalSubscriptions.get(subscriptionId);
    if (!subscription) {
      return 0;
    }
    this.liveSignalSubscriptions.delete(subscriptionId);
    try {
      subscription.sink[Symbol.dispose]?.();
    } catch {
    }
    let removed = 0;
    await Promise.all(subscription.watchKeys.map(async (key) => {
      try {
        await kernel.request("signal.unwatch", { key });
        removed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[app-runner] signal unwatch failed for ${subscriptionId} (${key}): ${message}`);
      }
    }));
    return removed;
  }

  #getProps(): AppRunnerProps {
    const props = this.ctx.storage.kv.get<AppRunnerProps>(PROPS_KEY);
    if (!props) {
      throw new Error("AppRunner is not initialized");
    }
    if (!props.packageId || !props.packageName || !props.routeBase || !props.entrypointName || !props.artifact || !props.appFrame) {
      throw new Error("AppRunner props are incomplete");
    }
    return props;
  }

  #facetName(props: AppRunnerProps): string {
    return `app:${props.entrypointName}`;
  }

  #loadWorker(props: AppRunnerProps): WorkerStub {
    const appFrame = this.#runtimeAppFrame(props);
    return this.env.LOADER.get(
      this.#codeKey(props),
      () => packageArtifactToWorkerCode(props.artifact, {
        PACKAGE_NAME: props.packageName,
        PACKAGE_ID: props.packageId,
        PACKAGE_ROUTE_BASE: props.routeBase,
        GSV_PACKAGE_NAME: props.packageName,
        GSV_PACKAGE_ID: props.packageId,
        GSV_ROUTE_BASE: props.routeBase,
        GSV_APP_FRAME: appFrame,
      }),
    );
  }

  #getFacet(): AppFacetStub {
    const props = this.#getProps();
    const worker = this.#loadWorker(props);
    const facetName = this.#facetName(props);
    const codeKey = this.#codeKey(props);
    const versionKey = `facet:${facetName}:code-key`;
    const facets = this.ctx.facets;
    const previousCodeKey = this.ctx.storage.kv.get<string>(versionKey);
    if (previousCodeKey && previousCodeKey !== codeKey) {
      facets.abort(facetName, new Error("App facet code updated"));
    }
    if (previousCodeKey !== codeKey) {
      this.ctx.storage.kv.put(versionKey, codeKey);
    }
    return facets.get<AppFacetStub>(facetName, (): FacetStartupOptions<AppFacetStub> => ({
      class: worker.getDurableObjectClass<AppFacetStub>("GsvAppFacet"),
    }));
  }

  #codeKey(props: AppRunnerProps): string {
    return [
      "app-facet",
      String(props.appFrame.uid),
      props.packageId,
      props.entrypointName,
      props.artifact.hash,
    ].join(":");
  }
}
