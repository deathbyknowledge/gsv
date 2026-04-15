import { DurableObject } from "cloudflare:workers";
import { packageArtifactToWorkerCode, type PackageArtifact } from "./kernel/packages";
import type { AppFrameContext, KernelBindingProps, PackageAppSignalWatchInfo } from "./protocol/app-frame";

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

type AppFacetStub = Rpc.DurableObjectBranded & {
  fetch(request: Request): Promise<Response>;
  gsvHandleSignal(
    signalName: string,
    payload?: unknown,
    sourcePid?: string | null,
    watch?: PackageAppSignalWatchInfo,
  ): Promise<void>;
};

const PROPS_KEY = "app-runner:props";

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

  async fetch(request: Request): Promise<Response> {
    return this.#getFacet().fetch(request);
  }

  async getBackend(): Promise<AppFacetStub> {
    return this.#getFacet();
  }

  async deliverSignal(input: AppRunnerSignalInput): Promise<void> {
    await this.#getFacet().gsvHandleSignal(
      input.signal,
      input.payload,
      input.sourcePid ?? null,
      input.watch,
    );
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
    const now = Date.now();
    const runtimeAppFrame: AppFrameContext = {
      ...props.appFrame,
      issuedAt: now,
      expiresAt: now + (365 * 24 * 60 * 60 * 1000),
    };
    return this.env.LOADER.get(
      this.#codeKey(props),
      () => packageArtifactToWorkerCode(props.artifact, {
        PACKAGE_NAME: props.packageName,
        PACKAGE_ID: props.packageId,
        PACKAGE_ROUTE_BASE: props.routeBase,
        GSV_PACKAGE_NAME: props.packageName,
        GSV_PACKAGE_ID: props.packageId,
        GSV_ROUTE_BASE: props.routeBase,
        KERNEL: this.ctx.exports.KernelBinding({
          props: {
            appFrame: runtimeAppFrame,
          } satisfies KernelBindingProps,
        }),
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
