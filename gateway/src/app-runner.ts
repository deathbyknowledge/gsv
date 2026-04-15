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

  async call(method: string, args?: unknown): Promise<unknown> {
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
  }

  async invokeAppRpc(method: string, args: unknown, runtime: AppFacetRuntime): Promise<unknown> {
    return this.#getFacet().gsvInvoke(method, args, runtime, this.#createKernelBridge(runtime.appFrame));
  }

  async subscribeSignal(args: unknown, runtime: AppFacetRuntime): Promise<unknown> {
    return this.#getFacet().gsvSubscribeSignal(args, runtime, this.#createKernelBridge(runtime.appFrame));
  }

  async unsubscribeSignal(args: unknown, runtime: AppFacetRuntime): Promise<unknown> {
    return this.#getFacet().gsvUnsubscribeSignal(args, runtime, this.#createKernelBridge(runtime.appFrame));
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
