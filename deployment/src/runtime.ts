import * as Effect from "effect/Effect";
import * as Cloudflare from "alchemy/Cloudflare";
import { retain } from "alchemy/RemovalPolicy";

export const GSV_WORKER_COMPATIBILITY = {
  date: "2026-07-29",
  flags: ["nodejs_compat" as const],
};

export type GsvRuntimeMode = "standalone" | "managed";

export type GsvRuntimeNames = {
  gateway: string;
  ripgit: string;
  storageBucket: string;
};

export type GsvRuntimePaths = {
  gatewayBundle: string;
  webAssets: string;
  ripgitBundle: string;
};

export type GsvAdapterBinding = {
  id: string;
  gatewayBinding: string;
  gatewayEntrypoint: string;
  gatewayBindingLogicalId?: string;
  worker: Cloudflare.Workers.Worker;
  calls?: readonly string[];
};

export type GsvRuntimeServices = {
  installationDirectory?: Cloudflare.Workers.Worker;
  inference?: Cloudflare.Workers.WorkerEntrypointBinding;
  inferenceInstallations?: Cloudflare.Workers.WorkerBindingProps[string];
  entitlements?: Cloudflare.Workers.WorkerEntrypointBinding;
  mailOutbound?: Cloudflare.Queues.Queue;
  adapters?: readonly GsvAdapterBinding[];
  extraBindings?: Cloudflare.Workers.WorkerBindingProps;
};

export type GsvRuntimeProps = {
  mode: GsvRuntimeMode;
  logicalPrefix: string;
  names: GsvRuntimeNames;
  paths: GsvRuntimePaths;
  services?: GsvRuntimeServices;
  compatibility?: typeof GSV_WORKER_COMPATIBILITY;
  gatewayWorkersDev?: boolean | Cloudflare.Workers.WorkersDevConfig;
  observability?: Cloudflare.Workers.WorkerObservability;
};

const adapterGatewayBindings = (
  adapters: readonly GsvAdapterBinding[],
): Cloudflare.Workers.WorkerBindingProps =>
  Object.fromEntries(
    adapters.map((adapter) => [
      adapter.gatewayBinding,
      Cloudflare.WorkerEntrypoint(
        adapter.worker,
        adapter.gatewayEntrypoint,
      ),
    ]),
  );

export const GsvRuntime = (props: GsvRuntimeProps) =>
  Effect.gen(function* () {
    const compatibility = props.compatibility ?? GSV_WORKER_COMPATIBILITY;
    const adapters = props.services?.adapters ?? [];
    const storageResource = Cloudflare.R2.Bucket(
      `${props.logicalPrefix}Storage`,
      { name: props.names.storageBucket },
    ).pipe(retain());
    const ripgitWorker = Cloudflare.Worker(
      `${props.logicalPrefix}Ripgit`,
      {
        name: props.names.ripgit,
        main: props.paths.ripgitBundle,
        bundle: false,
        compatibility: { date: compatibility.date },
        workersDev: false,
        observability: props.observability ?? {
          enabled: true,
          logs: { enabled: true, invocationLogs: true },
        },
        env: {
          REPOSITORY: Cloudflare.DurableObject("REPOSITORY", {
            className: "Repository",
          }),
        },
      },
    ).pipe(retain());

    const managedBindings: Cloudflare.Workers.WorkerBindingProps = {};
    if (props.services?.installationDirectory) {
      managedBindings.INSTALLATION_DIRECTORY =
        props.services.installationDirectory;
    }
    if (props.services?.inference) {
      managedBindings.MANAGED_INFERENCE = props.services.inference;
    }
    if (props.services?.inferenceInstallations) {
      managedBindings.MANAGED_INFERENCE_INSTALLATIONS =
        props.services.inferenceInstallations;
    }
    if (props.services?.entitlements) {
      managedBindings.ENTITLEMENTS = props.services.entitlements;
    }
    if (props.services?.mailOutbound) {
      managedBindings.MANAGED_MAIL_OUTBOUND = props.services.mailOutbound;
    }
    const gatewayWorker = Cloudflare.Worker(
      `${props.logicalPrefix}Gateway`,
      {
        name: props.names.gateway,
        main: props.paths.gatewayBundle,
        bundle: false,
        compatibility,
        workersDev: props.gatewayWorkersDev ?? false,
        observability: props.observability ?? { enabled: true },
        assets: {
          directory: props.paths.webAssets,
          notFoundHandling: "single-page-application",
          runWorkerFirst: ["/*"],
        },
        env: {
          KERNEL: Cloudflare.DurableObject("KERNEL", {
            className: "Kernel",
          }),
          PROCESS: Cloudflare.DurableObject("PROCESS", {
            className: "Process",
          }),
          CONVERSATION: Cloudflare.DurableObject("CONVERSATION", {
            className: "Conversation",
          }),
          STORAGE: storageResource,
          AI: Cloudflare.Workers.AI(),
          RIPGIT: ripgitWorker,
          LOADER: Cloudflare.WorkerLoader(),
          ...managedBindings,
          ...adapterGatewayBindings(adapters),
          ...props.services?.extraBindings,
        },
      },
    ).pipe(retain());

    for (const adapter of adapters) {
      yield* adapter.worker.bind(
        adapter.gatewayBindingLogicalId ??
          `${props.logicalPrefix}${adapter.id}GatewayBinding`,
        {
          bindings: [{
            type: "service",
            name: "GATEWAY",
            service: props.names.gateway,
            entrypoint: "AdapterGatewayEntrypoint",
            props: {
              id: adapter.id,
              calls: [...(adapter.calls ?? [
                "adapter.inbound",
                "adapter.state.update",
              ])],
            },
          }],
        },
      );
    }

    const storage = yield* storageResource;
    const ripgit = yield* ripgitWorker;
    const gateway = yield* gatewayWorker;
    return { mode: props.mode, storage, ripgit, gateway };
  });

export type StandaloneGsvProps = Omit<GsvRuntimeProps, "mode" | "services"> & {
  adapters?: readonly GsvAdapterBinding[];
  extraBindings?: Cloudflare.Workers.WorkerBindingProps;
};

export const StandaloneGsv = (props: StandaloneGsvProps) =>
  GsvRuntime({
    ...props,
    mode: "standalone",
    services: {
      adapters: props.adapters,
      extraBindings: props.extraBindings,
    },
  });
