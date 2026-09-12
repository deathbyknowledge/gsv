import * as Effect from "effect/Effect";
import * as Output from "alchemy/Output";
import * as Cloudflare from "alchemy/Cloudflare";
import { retain } from "alchemy/RemovalPolicy";
import type { AdapterWorkerDeploymentManifest } from "./manifest.ts";

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
  inferenceBundle?: string;
};

export type GsvAdapterBinding = {
  id: string;
  gatewayBinding: string;
  gatewayEntrypoint: string;
  gatewayBindingLogicalId?: string;
  worker: Cloudflare.Workers.Worker;
  lifecycle?: AdapterWorkerDeploymentManifest["lifecycle"];
  calls?: readonly string[];
};

export type GsvRuntimeServices = {
  installationDirectory?: Cloudflare.Workers.Worker;
  inferenceExecution?: Cloudflare.Workers.WorkerBindingProps[string];
  /** Historical commercial-service input retained until the W7 symbol removal. */
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
  telemetry?: {
    tailConsumers: readonly (string | Cloudflare.Workers.Worker)[];
  };
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

const telemetryProducerObservability = {
  enabled: true,
  logs: {
    enabled: true,
    invocationLogs: false,
    persist: false,
  },
  traces: { enabled: false },
} satisfies Cloudflare.Workers.WorkerObservability;

export type GsvRuntimeDependencies = { Cloudflare: typeof Cloudflare; Effect: typeof Effect; retain: typeof retain };
export const gsvRuntimeDependencies: GsvRuntimeDependencies = { Cloudflare, Effect, retain };

export const GsvRuntime = (props: GsvRuntimeProps, dependencies = gsvRuntimeDependencies) => {
  const { Cloudflare, Effect, retain } = dependencies;
  return Effect.gen(function* () {
    const directory = props.services?.installationDirectory;
    let inferenceExecution = props.services?.inferenceExecution;
    if (props.mode === "managed" && (!directory || !inferenceExecution)) {
      throw new Error("GSV requires an installation directory and inference execution service. Use GsvDeployment or supply both services.");
    }
    if (props.mode === "standalone" && directory) throw new Error("Standalone Gateway must retain its singleton routing without an installation directory");
    if (props.mode === "standalone" && !inferenceExecution && !props.paths.inferenceBundle) {
      throw new Error("Standalone deployment requires the inference bundle from the current release");
    }
    const compatibility = props.compatibility ?? GSV_WORKER_COMPATIBILITY;
    const adapters = props.services?.adapters ?? [];
    for (const adapter of adapters) {
      if (!/^[a-z][a-z0-9-]*$/.test(adapter.id) || (props.mode === "managed" && !adapter.lifecycle)) {
        throw new Error(`Adapter ${adapter.id} requires an owned lifecycle before multi-space deployment`);
      }
    }
    // The legacy namespace remains fixed until W7; execution still belongs outside Gateway.
    const standaloneInference = props.mode === "standalone" && !inferenceExecution
      ? yield* Cloudflare.Worker(`${props.logicalPrefix}Inference`, {
        name: `${props.names.gateway}-inference`, main: props.paths.inferenceBundle!, bundle: false,
        compatibility: { ...compatibility, flags: [...compatibility.flags, "enable_nodejs_os_module"] },
        workersDev: false, observability: props.observability ?? { enabled: true },
        env: {
          AI: Cloudflare.Workers.AI(),
          INFERENCE_EXECUTORS: Cloudflare.DurableObject("INFERENCE_EXECUTORS", { className: "InferenceExecutor" }),
          // Preserve caller/model limits without a new shared budget; duration uses the executor's timer ceiling.
          INFERENCE_MONTHLY_REQUESTS: 0, INFERENCE_MONTHLY_OUTPUT_TOKENS: 0,
          INFERENCE_MAX_OUTPUT_TOKENS: Number.MAX_SAFE_INTEGER, INFERENCE_MAX_DURATION_MS: 2_147_483_647,
        },
      }).pipe(retain()) : undefined;
    inferenceExecution ??= standaloneInference;
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

    const managedBindings: Cloudflare.Workers.WorkerBindingProps = {
      INFERENCE_EXECUTION: inferenceExecution!,
    };
    if (directory) {
      managedBindings.INSTALLATION_DIRECTORY = directory;
      managedBindings.INSTALLATION_OWNERSHIP = Cloudflare.WorkerEntrypoint(directory, {
        entrypoint: "InstallationOwnershipEntrypoint", props: { authority: "kernel-owner-link" },
      });
    }
    if (props.services?.entitlements) {
      managedBindings.ENTITLEMENTS = props.services.entitlements;
    }
    if (props.services?.mailOutbound) {
      managedBindings.MANAGED_MAIL_OUTBOUND = props.services.mailOutbound;
    }
    const gatewayEnv: Cloudflare.Workers.WorkerBindingProps = {
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
      RIPGIT: ripgitWorker,
      LOADER: Cloudflare.WorkerLoader(),
      ...managedBindings,
      ...adapterGatewayBindings(adapters),
      ...props.services?.extraBindings,
    };
    if (props.telemetry) gatewayEnv.GSV_TELEMETRY_ENABLED = "1";
    const gatewayWorker = Cloudflare.Worker(
      `${props.logicalPrefix}Gateway`,
      {
        name: props.names.gateway,
        main: props.paths.gatewayBundle,
        bundle: false,
        compatibility,
        workersDev: props.gatewayWorkersDev ?? false,
        observability: props.observability
          ?? (props.telemetry
            ? telemetryProducerObservability
            : { enabled: true }),
        tailConsumers: props.telemetry
          ? [...props.telemetry.tailConsumers]
          : undefined,
        assets: {
          directory: props.paths.webAssets,
          notFoundHandling: "single-page-application",
          runWorkerFirst: ["/*"],
        },
        env: gatewayEnv,
      },
    ).pipe(retain());

    for (const adapter of adapters) {
      if (directory) yield* directory.bind(`${props.logicalPrefix}${adapter.id}DeletionBinding`, {
        bindings: [{ type: "service", name: `DELETION_OWNER_${adapter.id.replaceAll("-", "_").toUpperCase()}`,
          service: adapter.worker.workerName, entrypoint: adapter.lifecycle!.entrypoint,
          props: { authority: "installation-deletion" } }],
      });
      yield* adapter.worker.bind(
        adapter.gatewayBindingLogicalId ??
          `${props.logicalPrefix}${adapter.id}GatewayBinding`,
        {
          bindings: [...(directory ? [{
            type: "service" as const,
            name: "ACCOUNTS",
            service: directory.workerName,
          }] : []), {
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
    if (standaloneInference) yield* standaloneInference.bind(`${props.logicalPrefix}StandaloneInferenceDirectoryBinding`, {
      bindings: [{ type: "service", name: "INSTALLATION_DIRECTORY", service: standaloneInference.workerName,
        entrypoint: "StandaloneInferenceDirectoryEntrypoint",
        props: { authority: "standalone-inference", canonicalOrigin: Output.asOutput(gateway.url).pipe(Output.map((url) => {
          if (!url) throw new Error("Standalone inference requires a reachable Gateway origin");
          return new URL(url).origin;
        })) } }],
    });
    if (directory) yield* directory.bind(`${props.logicalPrefix}DirectoryRecoveryBinding`, {
      bindings: [{ type: "service", name: "ACCOUNTS_GATEWAY_RECOVERY", service: props.names.gateway,
        entrypoint: "GatewayRecoveryEntrypoint", props: { authority: "installation-owner-recovery" } }],
    });
    if (directory) yield* directory.bind(`${props.logicalPrefix}DirectoryGatewayDeletionBinding`, {
      bindings: [{ type: "service", name: "DELETION_OWNER_GATEWAY", service: props.names.gateway,
        entrypoint: "GatewayLifecycleEntrypoint", props: { authority: "installation-deletion" } }],
    });
    return { mode: props.mode, storage, ripgit, gateway };
  });
};

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
