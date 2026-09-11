import type * as Cloudflare from "alchemy/Cloudflare";
import { GsvRuntime, gsvRuntimeDependencies, type GsvRuntimeProps, type GsvRuntimeServices } from "./runtime.ts";
import { GsvDeletionDiscoveryBindings, gsvAdapterDeletionNamespaces } from "./deletion-bindings.ts";

export type GsvOperatorAccess = { kind: "operator" } | {
  kind: "cloudflare-access"; teamDomain: string; audience: string;
};

export type GsvDeploymentProps = Omit<GsvRuntimeProps, "mode" | "services"> & {
  domain: string;
  adminOrigin: string;
  access: GsvOperatorAccess;
  services?: GsvRuntimeServices;
  installations: {
    workerName: string;
    databaseName: string;
    workerBundle: string;
    migrationsDirectory: string;
    ownerIdentity?: { issuer: string; clientId: string; clientSecret?: Cloudflare.Workers.WorkerBindingProps[string] };
  };
  inference: {
    workerName: string;
    workerBundle: string;
    defaultProvider: string;
    defaultModel: string;
    monthlyRequests: number;
    monthlyOutputTokens: number;
    maxOutputTokens: number;
    maxDurationMs: number;
    apiKey?: Cloudflare.Workers.WorkerBindingProps[string];
    baseUrl?: string;
  };
  /** Omit when the operator overlay already owns DNS/routes. */
  routing?: { zoneId: string };
};

/** The shared multi-installation composition. Supplied operator services keep their identity. */
export const GsvDeployment = (props: GsvDeploymentProps, dependencies = gsvRuntimeDependencies) => {
  const { Cloudflare, Effect, retain } = dependencies;
  return Effect.gen(function* () {
  const domain = new URL(`https://${props.domain}`);
  const admin = new URL(props.adminOrigin);
  if (domain.hostname !== props.domain || domain.pathname !== "/" || admin.origin !== props.adminOrigin
    || admin.protocol !== "https:" || !admin.hostname.endsWith(`.${props.domain}`)) {
    throw new Error("Deployment requires a base domain and an HTTPS administration origin below it");
  }
  if (props.access.kind === "cloudflare-access" && (!props.access.audience.trim()
    || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(props.access.teamDomain))) {
    throw new Error("Cloudflare Access requires an explicit team origin and audience");
  }
  if (!props.services?.inferenceExecution && [props.inference.monthlyRequests, props.inference.monthlyOutputTokens,
    props.inference.maxOutputTokens, props.inference.maxDurationMs].some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("Public inference limits must be positive safe integers");
  }
  const compatibility = props.compatibility ?? { date: "2026-09-01", flags: ["nodejs_compat" as const] };
  const observability = { enabled: true, logs: { enabled: true, invocationLogs: false, persist: false }, traces: { enabled: false } };
  let directory = props.services?.installationDirectory;
  let database: Cloudflare.D1.Database | undefined;
  if (!directory) {
    // This branch creates a fresh public directory. Existing operator D1 is
    // supplied through its already-adopted directory Worker, never replayed here.
    database = yield* Cloudflare.D1.Database(`${props.logicalPrefix}InstallationsDatabase`, {
      name: props.installations.databaseName,
      migrationsDir: props.installations.migrationsDirectory,
      migrationsTable: "installation_migrations",
    }).pipe(retain());
    const bindings: Cloudflare.Workers.WorkerBindingProps = {
      INSTALLATIONS_DB: database, ENVIRONMENT: "production", GSV_BASE_DOMAIN: props.domain,
      GSV_ADMIN_ORIGIN: props.adminOrigin, GSV_OPERATOR_ACCESS_MODE: props.access.kind === "operator" ? "operator" : "access",
      GSV_ADMIN_ACCESS_TEAM_DOMAIN: props.access.kind === "cloudflare-access" ? props.access.teamDomain : "",
      GSV_ADMIN_ACCESS_AUD: props.access.kind === "cloudflare-access" ? props.access.audience : "",
      GSV_OWNER_OIDC_ISSUER: props.installations.ownerIdentity?.issuer ?? "",
      GSV_OWNER_OIDC_CLIENT_ID: props.installations.ownerIdentity?.clientId ?? "",
    };
    if (props.installations.ownerIdentity?.clientSecret) bindings.GSV_OWNER_OIDC_CLIENT_SECRET = props.installations.ownerIdentity.clientSecret;
    if (props.telemetry) bindings.GSV_TELEMETRY_ENABLED = "1";
    directory = yield* Cloudflare.Worker(`${props.logicalPrefix}Installations`, {
      name: props.installations.workerName, main: props.installations.workerBundle, bundle: false,
      crons: ["* * * * *"],
      compatibility, workersDev: false, observability,
      tailConsumers: props.telemetry ? [...props.telemetry.tailConsumers] : undefined, env: bindings,
    }).pipe(retain());
  }
  let inference = props.services?.inferenceExecution;
  let inferenceWorker: Cloudflare.Workers.Worker | undefined;
  if (!inference) {
    const bindings: Cloudflare.Workers.WorkerBindingProps = {
      INSTALLATION_DIRECTORY: directory,
      AI: Cloudflare.Workers.AI(),
      INFERENCE_EXECUTORS: Cloudflare.DurableObject("INFERENCE_EXECUTORS", { className: "InferenceExecutor" }),
      INFERENCE_DEFAULT_PROVIDER: props.inference.defaultProvider, INFERENCE_DEFAULT_MODEL: props.inference.defaultModel,
      INFERENCE_MONTHLY_REQUESTS: props.inference.monthlyRequests,
      INFERENCE_MONTHLY_OUTPUT_TOKENS: props.inference.monthlyOutputTokens,
      INFERENCE_MAX_OUTPUT_TOKENS: props.inference.maxOutputTokens, INFERENCE_MAX_DURATION_MS: props.inference.maxDurationMs,
    };
    if (props.inference.apiKey) bindings.INFERENCE_API_KEY = props.inference.apiKey;
    if (props.inference.baseUrl) bindings.INFERENCE_BASE_URL = props.inference.baseUrl;
    inferenceWorker = yield* Cloudflare.Worker(`${props.logicalPrefix}Inference`, {
      name: props.inference.workerName, main: props.inference.workerBundle, bundle: false,
      compatibility: { ...compatibility, flags: [...compatibility.flags, "enable_nodejs_os_module"] }, workersDev: false, observability,
      tailConsumers: props.telemetry ? [...props.telemetry.tailConsumers] : undefined, env: bindings,
    }).pipe(retain());
    inference = inferenceWorker;
  }
  const runtime = yield* GsvRuntime({ ...props, mode: "managed", compatibility,
    services: { ...props.services, installationDirectory: directory, inferenceExecution: inference } }, dependencies);
  if (inferenceWorker) {
    yield* directory.bind(`${props.logicalPrefix}DirectoryInferenceDeletionBinding`, {
      bindings: [{ type: "service", name: "DELETION_OWNER_INFERENCE", service: props.inference.workerName,
        entrypoint: "InferenceLifecycleEntrypoint", props: { authority: "installation-deletion" } }],
    });
    yield* GsvDeletionDiscoveryBindings(`${props.logicalPrefix}DirectoryDeletionDiscoveryBinding`, directory, [
      { ownerId: "gateway", worker: runtime.gateway, className: "Kernel", kind: "kernel" },
      { ownerId: "gateway", worker: runtime.gateway, className: "Process", kind: "process" },
      { ownerId: "gateway", worker: runtime.gateway, className: "Conversation", kind: "conversation" },
      { ownerId: "gateway", worker: runtime.ripgit, className: "Repository", kind: "ripgit" },
      { ownerId: "inference", worker: inferenceWorker, className: "InferenceExecutor", kind: "inference-executor" },
      ...gsvAdapterDeletionNamespaces(props.services?.adapters ?? []),
    ]);
  }
  if (props.routing) {
    yield* Cloudflare.DNS.Record(`${props.logicalPrefix}WildcardDns`, {
      zoneId: props.routing.zoneId, name: `*.${props.domain}`, type: "AAAA", content: "100::", proxied: true,
    });
    yield* Cloudflare.Workers.WorkerRoute(`${props.logicalPrefix}InstallationsRoute`, {
      zoneId: props.routing.zoneId, pattern: `${admin.hostname}/*`, script: directory.workerName,
    });
    yield* Cloudflare.Workers.WorkerRoute(`${props.logicalPrefix}GatewayRoute`, {
      zoneId: props.routing.zoneId, pattern: `*.${props.domain}/*`, script: runtime.gateway.workerName,
    });
  }
  return { ...runtime, directory, database, inference: inferenceWorker ?? inference };
  });
};
