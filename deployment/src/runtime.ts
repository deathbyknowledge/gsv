import * as Effect from "effect/Effect";
import * as Cloudflare from "alchemy/Cloudflare";
import { retain } from "alchemy/RemovalPolicy";
import type { AdapterWorkerDeploymentManifest } from "./manifest.ts";

export const GSV_WORKER_COMPATIBILITY = {
  date: "2026-07-29",
  flags: ["nodejs_compat" as const],
};

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
  lifecycle?: AdapterWorkerDeploymentManifest["lifecycle"];
  calls?: readonly string[];
};

export type GsvRuntimeServices = {
  installationDirectory: Cloudflare.Workers.Worker;
  inferenceExecution: Cloudflare.Workers.WorkerBindingProps[string];
  entitlements?: Cloudflare.Workers.WorkerEntrypointBinding;
  mailOutbound?: Cloudflare.Queues.Queue;
  webSearch?: Cloudflare.Workers.WorkerBindingProps[string];
  instances?: Cloudflare.Workers.WorkerBindingProps[string];
  feedback?: Cloudflare.Workers.WorkerBindingProps[string];
  adapters?: readonly GsvAdapterBinding[];
  extraBindings?: Cloudflare.Workers.WorkerBindingProps;
};

/** The ATProto host that holds each Ship's DID and public repository. */
export type GsvPdsProps = {
  workerName: string;
  bucketName: string;
  workerBundle: string;
  /** The PDS's public origin, which every Ship's DID names as its repository host. */
  origin: string;
  /** The did:plc directory the PDS registers Ships' DIDs with and the Gateway reads every DID from. */
  plcUrl: string;
  /** Hex secp256k1 key that signs the PDS's directory operations. */
  rotationKey: Cloudflare.Workers.WorkerBindingProps[string];
  /** did:key of an offline key that outranks the rotation key in every new DID. */
  recoveryKey?: Cloudflare.Workers.WorkerBindingProps[string];
  /** Public address where relays and other services can reach the operator. */
  contactEmail?: string;
  /** The operator's privacy policy and terms of service, as HTTPS URLs. */
  privacyPolicyUrl?: string;
  termsOfServiceUrl?: string;
};

export type GsvRuntimeProps = {
  logicalPrefix: string;
  names: GsvRuntimeNames;
  paths: GsvRuntimePaths;
  services: GsvRuntimeServices;
  /** Without a PDS, Ships have no DID and stay off the open network. */
  pds?: GsvPdsProps;
  /** Only explicit disposable deployments may delete owned resources; omission retains them. */
  allowResourceDeletion?: boolean;
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
    const inferenceExecution = props.services?.inferenceExecution;
    if (!directory || !inferenceExecution) {
      throw new Error("GSV requires an installation directory and inference execution service. Use GsvDeployment or supply both services.");
    }
    if ("GSV_FEDERATION_LOCAL_DEVELOPMENT" in (props.services.extraBindings ?? {})) {
      throw new Error("Local federation is only available in the development configuration");
    }
    const compatibility = props.compatibility ?? GSV_WORKER_COMPATIBILITY;
    const adapters = props.services?.adapters ?? [];
    for (const adapter of adapters) {
      if (!/^[a-z][a-z0-9-]*$/.test(adapter.id) || !adapter.lifecycle) {
        throw new Error(`Adapter ${adapter.id} requires an owned lifecycle before multi-space deployment`);
      }
    }
    if (props.pds) assertGsvPds(props.pds);
    const storageResource = Cloudflare.R2.Bucket(
      `${props.logicalPrefix}Storage`,
      {
        name: props.names.storageBucket,
        lifecycleRules: props.allowResourceDeletion === true ? [{
          id: "abort-incomplete-uploads",
          abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 86_400 } },
        }] : undefined,
      },
    ).pipe(retain(props.allowResourceDeletion !== true));
    const ripgitEnv: Cloudflare.Workers.WorkerBindingProps = {
      REPOSITORY: Cloudflare.DurableObject("REPOSITORY", {
        className: "Repository",
      }),
    };
    if (props.telemetry) ripgitEnv.GSV_TELEMETRY_ENABLED = "1";
    const ripgitWorker = Cloudflare.Worker(
      `${props.logicalPrefix}Ripgit`,
      {
        name: props.names.ripgit,
        main: props.paths.ripgitBundle,
        bundle: false,
        compatibility: { date: compatibility.date },
        workersDev: false,
        observability: props.observability
          ?? (props.telemetry
            ? telemetryProducerObservability
            : { enabled: true, logs: { enabled: true, invocationLogs: true } }),
        tailConsumers: props.telemetry ? [...props.telemetry.tailConsumers] : undefined,
        env: ripgitEnv,
      },
    ).pipe(retain(props.allowResourceDeletion !== true));

    const serviceBindings: Cloudflare.Workers.WorkerBindingProps = {
      INFERENCE_EXECUTION: inferenceExecution,
    };
    serviceBindings.INSTALLATION_DIRECTORY = directory;
    serviceBindings.INSTALLATION_OWNERSHIP = Cloudflare.WorkerEntrypoint(directory, {
      entrypoint: "InstallationOwnershipEntrypoint", props: { authority: "kernel-owner-link" },
    });
    if (props.services?.entitlements) {
      serviceBindings.ENTITLEMENTS = props.services.entitlements;
    }
    if (props.services?.mailOutbound) {
      serviceBindings.MANAGED_MAIL_OUTBOUND = props.services.mailOutbound;
    }
    if (props.services.webSearch) serviceBindings.WEB_SEARCH = props.services.webSearch;
    if (props.services.instances) serviceBindings.INSTANCES = props.services.instances;
    if (props.services.feedback) serviceBindings.FEEDBACK = props.services.feedback;
    let pds: Cloudflare.Workers.Worker | undefined;
    if (props.pds) {
      const blobs = Cloudflare.R2.Bucket(`${props.logicalPrefix}PdsBlobs`, { name: props.pds.bucketName })
        .pipe(retain(props.allowResourceDeletion !== true));
      const pdsEnv: Cloudflare.Workers.WorkerBindingProps = {
        REPOS: Cloudflare.DurableObject("REPOS", { className: "HostedRepo" }),
        FIREHOSE: Cloudflare.DurableObject("FIREHOSE", { className: "HostFirehose" }),
        BLOBS: blobs,
        INSTALLATION_DIRECTORY: directory,
        PDS_ORIGIN: props.pds.origin,
        PLC_URL: props.pds.plcUrl,
        PLC_ROTATION_KEY: props.pds.rotationKey,
      };
      if (props.pds.recoveryKey) pdsEnv.PLC_RECOVERY_KEY = props.pds.recoveryKey;
      if (props.pds.contactEmail) pdsEnv.PDS_CONTACT_EMAIL = props.pds.contactEmail;
      if (props.pds.privacyPolicyUrl) pdsEnv.PDS_PRIVACY_POLICY_URL = props.pds.privacyPolicyUrl;
      if (props.pds.termsOfServiceUrl) pdsEnv.PDS_TERMS_OF_SERVICE_URL = props.pds.termsOfServiceUrl;
      pds = yield* Cloudflare.Worker(
        `${props.logicalPrefix}Pds`,
        {
          name: props.pds.workerName,
          main: props.pds.workerBundle,
          bundle: false,
          // The PDS reaches only its PLC directory, over the public internet even on the deployment's own zone.
          compatibility: { ...compatibility, flags: [...compatibility.flags, "global_fetch_strictly_public"] },
          workersDev: false,
          // Like the Gateway's, its logs go only to the operator's tail when there is one.
          observability: props.observability ?? (props.telemetry ? telemetryProducerObservability : {
            enabled: true,
            logs: { enabled: true, invocationLogs: true },
          }),
          tailConsumers: props.telemetry ? [...props.telemetry.tailConsumers] : undefined,
          env: pdsEnv,
        },
      ).pipe(retain(props.allowResourceDeletion !== true));
      // Only the Kernel's binding may publish.
      serviceBindings.PDS = Cloudflare.WorkerEntrypoint(pds, {
        entrypoint: "PdsPublisherEntrypoint", props: { authority: "kernel-publish" },
      });
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
      // The Gateway's rough budget for each source of Ship-to-Ship calls to each Ship.
      SHIP_CALLS: Cloudflare.RateLimit("SHIP_CALLS", { namespaceId: "7001", simple: { limit: 250, period: 10 } }),
      ...serviceBindings,
      ...adapterGatewayBindings(adapters),
      ...props.services?.extraBindings,
    };
    if (props.telemetry) gatewayEnv.GSV_TELEMETRY_ENABLED = "1";
    // A Ship reads every DID from the directory its PDS registers them with.
    if (props.pds) gatewayEnv.PLC_URL = props.pds.plcUrl;
    const gatewayWorker = Cloudflare.Worker(
      `${props.logicalPrefix}Gateway`,
      {
        name: props.names.gateway,
        main: props.paths.gatewayBundle,
        bundle: false,
        compatibility: { ...compatibility, flags: [...compatibility.flags, "global_fetch_strictly_public"] },
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
    ).pipe(retain(props.allowResourceDeletion !== true));

    for (const adapter of adapters) {
      yield* directory.bind(`${props.logicalPrefix}${adapter.id}DeletionBinding`, {
        bindings: [{ type: "service", name: `DELETION_OWNER_${adapter.id.replaceAll("-", "_").toUpperCase()}`,
          service: adapter.worker.workerName, entrypoint: adapter.lifecycle!.entrypoint,
          props: { authority: "installation-deletion" } }],
      });
      yield* adapter.worker.bind(
        adapter.gatewayBindingLogicalId ??
          `${props.logicalPrefix}${adapter.id}GatewayBinding`,
        {
          bindings: [{
            type: "service" as const,
            name: "ACCOUNTS",
            service: directory.workerName,
          }, {
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
    yield* directory.bind(`${props.logicalPrefix}DirectoryRecoveryBinding`, {
      bindings: [{ type: "service", name: "ACCOUNTS_GATEWAY_RECOVERY", service: props.names.gateway,
        entrypoint: "GatewayRecoveryEntrypoint", props: { authority: "installation-owner-recovery" } }],
    });
    yield* directory.bind(`${props.logicalPrefix}DirectoryGatewayDeletionBinding`, {
      bindings: [{ type: "service", name: "DELETION_OWNER_GATEWAY", service: props.names.gateway,
        entrypoint: "GatewayLifecycleEntrypoint", props: { authority: "installation-deletion" } }],
    });
    if (props.pds) {
      yield* directory.bind(`${props.logicalPrefix}DirectoryPdsDeletionBinding`, {
        bindings: [{ type: "service", name: "DELETION_OWNER_PDS", service: props.pds.workerName,
          entrypoint: "PdsLifecycleEntrypoint", props: { authority: "installation-deletion" } }],
      });
      // Only Accounts' operator pages may take down what the PDS serves, or restore it.
      yield* directory.bind(`${props.logicalPrefix}DirectoryPdsModerationBinding`, {
        bindings: [{ type: "service", name: "PDS_MODERATION", service: props.pds.workerName,
          entrypoint: "PdsModerationEntrypoint", props: { authority: "operator-moderation" } }],
      });
    }
    yield* directory.bind(`${props.logicalPrefix}DirectoryOperatorGatewayBinding`, {
      bindings: [{ type: "service", name: "OPERATOR_GATEWAY", service: props.names.gateway,
        entrypoint: "OperatorGatewayEntrypoint", props: { authority: "installation-operator" } }],
    });
    return { storage, ripgit, gateway, pds };
  });
};

/** Every Ship's DID names the PDS's origin, and other Ships read that DID from the PLC directory. */
export const assertGsvPds = (pds: GsvPdsProps): void => {
  if (!isHttpsOrigin(pds.origin) || !isHttpsOrigin(pds.plcUrl)) {
    throw new Error("The PDS requires HTTPS origins for itself and its PLC directory");
  }
  if (pds.contactEmail !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pds.contactEmail)) {
    throw new Error("The PDS contact email must be an email address");
  }
  if ([pds.privacyPolicyUrl, pds.termsOfServiceUrl].some((url) => url !== undefined && !isHttpsUrl(url))) {
    throw new Error("The PDS privacy policy and terms of service must be HTTPS URLs");
  }
};

const isHttpsUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const isHttpsOrigin = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
};
