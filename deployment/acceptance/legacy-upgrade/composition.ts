import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import { retain } from "alchemy/RemovalPolicy";
import { join } from "node:path";
import { upgradeFixturePlan, type UpgradeFixture, type UpgradePhase } from "./plan.ts";

type FixtureDatabaseProps = { name: string; migrationsDir?: string };

/** No production overlay, wildcard routing, adapter credentials, mail or Access resources. */
export function legacyUpgradeComposition(input: UpgradeFixture, phase: UpgradePhase) {
  const plan = upgradeFixturePlan(input);
  const current = phase === "current";
  const artifact = join(input.artifactsDirectory, current ? "current" : "legacy");
  return Effect.gen(function* () {
    const databaseProps: FixtureDatabaseProps = { name: plan.names.database };
    // Stop the legacy DDL owner before the explicit freeze/adopt/forward commands.
    if (phase === "legacy") databaseProps.migrationsDir = join(input.artifactsDirectory, "legacy", "migrations");
    const database = yield* Cloudflare.D1.Database("UpgradeAccountsDatabase", databaseProps).pipe(retain());
    const storage = yield* Cloudflare.R2.Bucket("UpgradeStorage", { name: plan.names.storage }).pipe(retain());
    const adminSecret = yield* Config.redacted("GSV_UPGRADE_ADMIN_SECRET");
    const accounts = yield* Cloudflare.Worker("UpgradeAccounts", {
      name: plan.names.accounts, main: join(artifact, "accounts/index.js"), bundle: false,
      compatibility: { date: "2026-07-29", flags: ["nodejs_compat"] },
      workersDev: false,
      // No automatic deletion/maintenance during the controlled migration snapshot.
      observability: { enabled: false },
      env: { ACCOUNT_DB: database, ENVIRONMENT: "development", GSV_ACCOUNT_ORIGIN: "http://localhost",
        GSV_BASE_DOMAIN: input.domain, FIXTURE_ADMIN_SECRET: adminSecret, FIXTURE_ADMIN_ORIGIN: plan.adminOrigin },
    }).pipe(retain());
    const inferenceBindings: Cloudflare.Workers.WorkerBindingProps = {
      ACCOUNTS: accounts, AI: Cloudflare.Workers.AI(),
      INFERENCE_INSTALLATIONS: Cloudflare.DurableObject("INFERENCE_INSTALLATIONS", { className: "InferenceInstallation" }),
      MANAGED_INFERENCE_ENABLED: false, MANAGED_INFERENCE_MONTHLY_LIMIT_NANO_USD: 0,
    };
    if (current) Object.assign(inferenceBindings, {
      INSTALLATION_DIRECTORY: accounts,
      INFERENCE_POLICY_LIFECYCLE: Cloudflare.WorkerEntrypoint(accounts, { entrypoint: "InferencePolicyLifecycleEntrypoint", props: { authority: "installation-deletion" } }),
      INFERENCE_EXECUTORS: Cloudflare.DurableObject("INFERENCE_EXECUTORS", { className: "InferenceExecutor" }),
      INFERENCE_MONTHLY_REQUESTS: 0, INFERENCE_MONTHLY_OUTPUT_TOKENS: 0,
      INFERENCE_MAX_OUTPUT_TOKENS: 32_768, INFERENCE_MAX_DURATION_MS: 180_000,
    });
    const inference = yield* Cloudflare.Worker("UpgradeInference", {
      name: plan.names.inference, main: join(artifact, "inference/index.js"), bundle: false,
      compatibility: { date: "2026-07-29", flags: current ? ["nodejs_compat", "enable_nodejs_os_module"] : ["nodejs_compat"] },
      workersDev: false, observability: { enabled: false }, env: inferenceBindings,
    }).pipe(retain());
    const ripgit = yield* Cloudflare.Worker("UpgradeRipgit", {
      name: plan.names.ripgit, main: join(artifact, "ripgit/index.js"), bundle: false,
      compatibility: { date: "2026-07-29" }, workersDev: false, observability: { enabled: false },
      env: { REPOSITORY: Cloudflare.DurableObject("REPOSITORY", { className: "Repository" }) },
    }).pipe(retain());
    const gatewayBindings: Cloudflare.Workers.WorkerBindingProps = {
      KERNEL: Cloudflare.DurableObject("KERNEL", { className: "Kernel" }),
      PROCESS: Cloudflare.DurableObject("PROCESS", { className: "Process" }),
      CONVERSATION: Cloudflare.DurableObject("CONVERSATION", { className: "Conversation" }),
      STORAGE: storage, RIPGIT: ripgit, LOADER: Cloudflare.WorkerLoader(), INSTALLATION_DIRECTORY: accounts,
    };
    if (current) Object.assign(gatewayBindings, {
      INFERENCE_EXECUTION: Cloudflare.WorkerEntrypoint(inference, "InferenceService"),
      INSTALLATION_OWNERSHIP: Cloudflare.WorkerEntrypoint(accounts, { entrypoint: "InstallationOwnershipEntrypoint", props: { authority: "kernel-owner-link" } }),
    });
    else Object.assign(gatewayBindings, { AI: Cloudflare.Workers.AI(),
      MANAGED_INFERENCE: Cloudflare.WorkerEntrypoint(inference, "InferenceService"),
      MANAGED_INFERENCE_INSTALLATIONS: Cloudflare.DurableObject("MANAGED_INFERENCE_INSTALLATIONS", {
        className: "InferenceInstallation", scriptName: inference.workerName,
      }),
    });
    const gateway = yield* Cloudflare.Worker("UpgradeGateway", {
      name: plan.names.gateway, main: join(artifact, "gateway/index.js"), bundle: false,
      compatibility: { date: "2026-07-29", flags: ["nodejs_compat"] },
      workersDev: false, observability: { enabled: false }, env: gatewayBindings,
      assets: { directory: join(artifact, "web"), notFoundHandling: "single-page-application", runWorkerFirst: ["/*"] },
    }).pipe(retain());
    if (current) {
      yield* accounts.bind("UpgradeAccountsInferenceLifecycle", { bindings: [{ type: "service", name: "DELETION_OWNER_INFERENCE",
        service: plan.names.inference, entrypoint: "InferenceLifecycleEntrypoint", props: { authority: "installation-deletion" } }] });
      yield* accounts.bind("UpgradeAccountsGatewayLifecycle", { bindings: [{ type: "service", name: "DELETION_OWNER_GATEWAY",
        service: plan.names.gateway, entrypoint: "GatewayLifecycleEntrypoint", props: { authority: "installation-deletion" } }] });
    }
    for (const [index, host] of [plan.adminHost, ...plan.gatewayHosts].entries()) {
      yield* Cloudflare.DNS.Record(`UpgradeDns${index}`, { zoneId: input.zoneId, name: host, type: "AAAA", content: "100::", proxied: true });
      yield* Cloudflare.Workers.WorkerRoute(`UpgradeRoute${index}`, {
        zoneId: input.zoneId, pattern: `${host}/*`, script: index === 0 ? accounts.workerName : gateway.workerName,
      });
    }
    return { phase, prefix: plan.prefix, databaseId: database.databaseId, storage: storage.bucketName,
      adminOrigin: plan.adminOrigin, gatewayHosts: plan.gatewayHosts, authCoverage: plan.authCoverage, adapterCoverage: plan.adapterCoverage };
  });
}
