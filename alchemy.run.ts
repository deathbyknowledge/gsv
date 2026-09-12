import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { readFileSync } from "node:fs";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { GsvAdapterWorker, GsvDeployment, gsvDeploymentManifestSchema, type GsvAdapterBinding } from "./deployment/src/index.ts";
import { operatorResourceCatalogSchema } from "./workers/installations/src/operator-resource-contracts.ts";

const manifest = gsvDeploymentManifestSchema.parse(JSON.parse(readFileSync("./dist/cloudflare/deployment-manifest.json", "utf8")));

export default Alchemy.Stack("gsv", {
  providers: Layer.mergeAll(Cloudflare.providers()), state: Cloudflare.state(),
}, Effect.gen(function* () {
  const domain = yield* Config.string("GSV_DOMAIN");
  const zoneId = yield* Config.string("GSV_ZONE_ID");
  const adminOrigin = yield* Config.string("GSV_ADMIN_ORIGIN").pipe(Config.withDefault(`https://accounts.${domain}`));
  const prefix = yield* Config.string("GSV_WORKER_PREFIX").pipe(Config.withDefault("gsv"));
  const accessMode = yield* Config.string("GSV_ACCESS_MODE").pipe(Config.withDefault("operator"));
  if (accessMode !== "operator" && accessMode !== "access") throw new Error("GSV_ACCESS_MODE must be operator or access");
  const access = accessMode === "access" ? { kind: "cloudflare-access" as const,
    teamDomain: yield* Config.string("GSV_ACCESS_TEAM_DOMAIN"), audience: yield* Config.string("GSV_ACCESS_AUDIENCE") }
    : { kind: "operator" as const };
  const ownerIssuer = Option.getOrUndefined(yield* Config.string("GSV_OWNER_OIDC_ISSUER").pipe(Config.option));
  const ownerClientId = Option.getOrUndefined(yield* Config.string("GSV_OWNER_OIDC_CLIENT_ID").pipe(Config.option));
  const ownerClientSecret = Option.getOrUndefined(yield* Config.redacted("GSV_OWNER_OIDC_CLIENT_SECRET").pipe(Config.option));
  if (Boolean(ownerIssuer) !== Boolean(ownerClientId)) throw new Error("Owner identity requires both OIDC issuer and client ID");
  const ownerIdentity = ownerIssuer && ownerClientId
    ? { issuer: ownerIssuer, clientId: ownerClientId, clientSecret: ownerClientSecret } : undefined;
  const ownerEmailFrom = Option.getOrUndefined(yield* Config.nonEmptyString("GSV_OWNER_EMAIL_FROM").pipe(Config.option));
  const ownerEmailRecipients = Option.getOrUndefined(yield* Config.nonEmptyString("GSV_OWNER_EMAIL_ALLOWED_RECIPIENTS").pipe(Config.option));
  if (ownerEmailRecipients && !ownerEmailFrom) throw new Error("Owner email recipients require GSV_OWNER_EMAIL_FROM");
  const allowedRecipients = ownerEmailRecipients?.split(",").map((email) => email.trim()).filter(Boolean);
  if (allowedRecipients?.length === 0) throw new Error("Owner email recipient restriction must not be empty");
  const ownerEmail = ownerEmailFrom ? { from: ownerEmailFrom, allowedRecipients,
    authSecret: yield* Alchemy.makeRandom("GsvOwnerAuthSecret", { bytes: 32 }),
  } : undefined;
  const configured = yield* Config.string("GSV_ADAPTERS").pipe(Config.withDefault(""));
  const requested = [...new Set(configured.split(",").map((id) => id.trim()).filter(Boolean))];
  const adapters: GsvAdapterBinding[] = [];
  for (const id of requested) {
    const adapter = manifest.adapters.find((candidate) => candidate.id === id);
    if (!adapter?.managed) throw new Error(`No operator adapter deployment is available for ${id}`);
    const adapterEnvironment: Cloudflare.Workers.WorkerBindingProps = { GSV_ACCOUNT_ORIGIN: adminOrigin };
    for (const variable of adapter.managed.requiredVariables ?? []) adapterEnvironment[variable] = yield* Config.string(variable);
    const worker = yield* GsvAdapterWorker({ logicalId: `GsvAdapter-${id}`, workerName: `${prefix}-channel-${id}`,
      adapter, deployment: adapter.managed,
      env: adapterEnvironment,
      secrets: Object.fromEntries(adapter.managed.requiredSecrets.map((secret) => [secret, { env: secret }])),
    });
    adapters.push({ id, gatewayBinding: adapter.gatewayBinding, gatewayEntrypoint: adapter.managed.gatewayEntrypoint,
      lifecycle: adapter.managed.lifecycle, worker });
  }
  const apiKey = Option.getOrUndefined(yield* Config.redacted("GSV_INFERENCE_API_KEY").pipe(Config.option));
  const catalogPath = Option.getOrUndefined(yield* Config.string("GSV_DELETION_CATALOG_FILE").pipe(Config.option));
  const deletion = catalogPath ? { operatorResources: operatorResourceCatalogSchema.parse(JSON.parse(readFileSync(catalogPath, "utf8"))) } : undefined;
  const deployment = yield* GsvDeployment({ logicalPrefix: "Gsv", domain, adminOrigin, access, routing: { zoneId },
    deletion,
    names: { gateway: prefix, ripgit: `${prefix}-ripgit`, storageBucket: `${prefix}-storage` }, paths: manifest.runtime,
    services: { adapters },
    installations: { workerName: `${prefix}-installations`, databaseName: `${prefix}-installations`,
      workerBundle: manifest.runtime.installationsBundle, migrationsDirectory: manifest.runtime.installationsMigrations, ownerIdentity, ownerEmail },
    inference: { workerName: `${prefix}-inference`, workerBundle: manifest.runtime.inferenceBundle,
      defaultProvider: yield* Config.string("GSV_INFERENCE_PROVIDER").pipe(Config.withDefault("workers-ai")),
      defaultModel: yield* Config.string("GSV_INFERENCE_MODEL").pipe(Config.withDefault("@cf/zai-org/glm-5.3-flash")),
      monthlyRequests: yield* Config.int("GSV_INFERENCE_MONTHLY_REQUESTS").pipe(Config.withDefault(10_000)),
      monthlyOutputTokens: yield* Config.int("GSV_INFERENCE_MONTHLY_OUTPUT_TOKENS").pipe(Config.withDefault(1_000_000)),
      maxOutputTokens: yield* Config.int("GSV_INFERENCE_MAX_OUTPUT_TOKENS").pipe(Config.withDefault(32_768)),
      maxDurationMs: yield* Config.int("GSV_INFERENCE_MAX_DURATION_MS").pipe(Config.withDefault(180_000)),
      apiKey, baseUrl: Option.getOrUndefined(yield* Config.string("GSV_INFERENCE_BASE_URL").pipe(Config.option)),
    },
  });
  return { gateway: deployment.gateway.workerName, administration: adminOrigin, accessMode,
    installationDatabase: deployment.database?.databaseId,
    storageBucket: deployment.storage.bucketName, adapters: adapters.map((adapter) => adapter.worker.workerName) };
}));
