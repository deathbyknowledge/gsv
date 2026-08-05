import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const configPaths = {
  gateway: "gateway/wrangler.managed.jsonc",
  account: "account-service/wrangler.jsonc",
  inference: "inference-service/wrangler.jsonc",
  telegram: "adapters/telegram/wrangler.managed.jsonc",
  ripgit: "ripgit/wrangler.managed.jsonc",
};

const developmentConfigPaths = {
  gateway: "gateway/wrangler.managed.dev.jsonc",
  account: "account-service/wrangler.dev.jsonc",
  inference: "inference-service/wrangler.dev.jsonc",
  telegram: "adapters/telegram/wrangler.managed.dev.jsonc",
  ripgit: "ripgit/wrangler.managed.dev.jsonc",
};

const configs = Object.fromEntries(
  Object.entries(configPaths).map(([key, relativePath]) => [
    key,
    JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8")),
  ]),
);

const developmentConfigs = Object.fromEntries(
  Object.entries(developmentConfigPaths).map(([key, relativePath]) => [
    key,
    JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8")),
  ]),
);

const developmentLauncher = fs.readFileSync(
  path.join(root, "scripts/dev-managed-stack.sh"),
  "utf8",
);

const expectedNames = {
  gateway: "gsv-managed-gateway",
  account: "gsv-accounts",
  inference: "gsv-inference",
  telegram: "gsv-managed-telegram",
  ripgit: "gsv-managed-ripgit",
};

const expectedMains = {
  gateway: "src/index.ts",
  account: "src/index.ts",
  inference: "src/index.ts",
  telegram: "src/managed.ts",
  ripgit: "build/index.js",
};

const expectedDevelopmentMains = {
  gateway: "src/managed-development.ts",
  account: "src/development.ts",
  inference: "src/index.ts",
  telegram: "src/managed.ts",
  ripgit: "build/index.js",
};

const expectedDevelopmentNames = Object.fromEntries(
  Object.entries(expectedNames).map(([key, name]) => [key, `${name}-dev`]),
);

const expectedDevelopmentServices = {
  gateway: [
    ["ACCOUNT_HTTP", "gsv-accounts-dev", undefined],
    ["CHANNEL_TELEGRAM", "gsv-managed-telegram-dev", "ManagedTelegramChannel"],
    ["INSTALLATION_DIRECTORY", "gsv-accounts-dev", "GatewayDirectoryEntrypoint"],
    ["MANAGED_INFERENCE", "gsv-inference-dev", "InferenceService"],
    ["RIPGIT", "gsv-managed-ripgit-dev", undefined],
  ],
  account: [
    ["GATEWAY", "gsv-managed-gateway-dev", "GatewayEntrypoint"],
    ["MANAGED_INFERENCE", "gsv-inference-dev", "InferenceService"],
    ["MANAGED_TELEGRAM", "gsv-managed-telegram-dev", "ManagedTelegramChannel"],
  ],
  inference: [
    ["ENTITLEMENTS", "gsv-accounts-dev", "EntitlementReaderEntrypoint"],
  ],
  telegram: [
    ["GATEWAY", "gsv-managed-gateway-dev", "GatewayEntrypoint"],
  ],
  ripgit: [],
};

const expectedServices = {
  gateway: [
    ["CHANNEL_TELEGRAM", "gsv-managed-telegram", "ManagedTelegramChannel"],
    ["INSTALLATION_DIRECTORY", "gsv-accounts", "GatewayDirectoryEntrypoint"],
    ["MANAGED_INFERENCE", "gsv-inference", "InferenceService"],
    ["RIPGIT", "gsv-managed-ripgit", undefined],
  ],
  account: [
    ["GATEWAY", "gsv-managed-gateway", "GatewayEntrypoint"],
    ["MANAGED_INFERENCE", "gsv-inference", "InferenceService"],
    ["MANAGED_TELEGRAM", "gsv-managed-telegram", "ManagedTelegramChannel"],
  ],
  inference: [
    ["ENTITLEMENTS", "gsv-accounts", "EntitlementReaderEntrypoint"],
  ],
  telegram: [
    ["GATEWAY", "gsv-managed-gateway", "GatewayEntrypoint"],
  ],
  ripgit: [],
};

const expectedSecrets = {
  account: [
    "GSV_STRIPE_FOUNDING_PRICE_ID",
    "GSV_STRIPE_MERCHANT_MODE",
    "GSV_TURNSTILE_SITE_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "TURNSTILE_SECRET",
  ],
  telegram: [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_BOT_USERNAME",
    "TELEGRAM_CLAIM_SIGNING_KEY",
    "TELEGRAM_WEBHOOK_SECRET",
  ],
};

for (const [key, config] of Object.entries(configs)) {
  invariant(config.name === expectedNames[key], `${key}: unexpected Worker name`);
  invariant(config.main === expectedMains[key], `${key}: production entrypoint drifted`);
  invariant(config.compatibility_date === "2026-07-31", `${key}: compatibility date drifted`);
  invariant(config.workers_dev === false, `${key}: workers.dev must remain disabled`);
  invariant(config.preview_urls === false, `${key}: preview URLs must remain disabled`);
  invariant(config.observability?.enabled === true, `${key}: observability must remain enabled`);
  invariant(!("dispatch_namespaces" in config), `${key}: Workers for Platforms is not part of this topology`);
  invariant(!("dispatch_namespace" in config), `${key}: Workers for Platforms is not part of this topology`);
  assertServices(key, config.services ?? [], expectedServices[key]);
}

assertRoutes("gateway", [["*.gsv.space/*", "gsv.space"]]);
assertRoutes("account", [["accounts.gsv.space/*", "gsv.space"]]);
assertRoutes("telegram", [["telegram.gsv.space/*", "gsv.space"]]);
assertRoutes("inference", []);
assertRoutes("ripgit", []);

invariant(
  configs.gateway.r2_buckets?.some((binding) =>
    binding.binding === "STORAGE" && binding.bucket_name === "gsv-managed-storage"
  ),
  "gateway: managed R2 bucket is missing",
);
invariant(
  configs.gateway.durable_objects?.bindings?.map((binding) => binding.name).sort().join(",")
    === "KERNEL,PROCESS",
  "gateway: Kernel and Process namespaces must be explicit",
);
invariant(
  configs.gateway.worker_loaders?.some((binding) => binding.binding === "LOADER"),
  "gateway: CodeMode Worker Loader is missing",
);
invariant(
  configs.gateway.assets?.directory === "../web/dist/",
  "gateway: desktop assets path drifted",
);
invariant(
  JSON.stringify(configs.gateway.assets?.run_worker_first) === JSON.stringify([
    "/*",
    "!/assets/*",
    "!/brand/*",
    "!/fonts/*",
    "!/icons/*",
    "!/img/*",
    "!/favicon.svg",
    "!/manifest.webmanifest",
  ]),
  "gateway: desktop shell must remain behind hostname resolution",
);
invariant(
  configs.account.d1_databases?.some((binding) =>
    binding.binding === "ACCOUNT_DB"
      && binding.database_name === "gsv-accounts"
      && binding.migrations_dir === "migrations"
  ),
  "account: D1 binding or migrations directory is missing",
);
invariant(
  configs.account.send_email?.some((binding) => binding.name === "EMAIL"),
  "account: transactional email binding is missing",
);
invariant(
  configs.account.vars?.ENVIRONMENT === "production"
    && !("GSV_INSTALLATION_ORIGIN_TEMPLATE" in configs.account.vars),
  "account: production environment boundary drifted",
);
invariant(
  configs.account.triggers?.crons?.length === 1,
  "account: lifecycle cron must remain configured",
);
invariant(
  configs.inference.vars?.MANAGED_INFERENCE_PROVIDER === "disabled",
  "inference: a config edit must not bypass the source-controlled provider gate",
);
invariant(
  configs.telegram.durable_objects?.bindings?.some((binding) =>
    binding.name === "MANAGED_TELEGRAM_PEER"
  ),
  "telegram: managed peer namespace is missing",
);
invariant(
  configs.ripgit.durable_objects?.bindings?.some((binding) => binding.name === "REPOSITORY"),
  "ripgit: repository namespace is missing",
);

for (const [owner, names] of Object.entries(expectedSecrets)) {
  const actual = [...(configs[owner].secrets?.required ?? [])].sort();
  invariant(
    actual.join(",") === [...names].sort().join(","),
    `${owner}: required production secrets drifted`,
  );
}

for (const [key, config] of Object.entries(developmentConfigs)) {
  invariant(
    config.name === expectedDevelopmentNames[key],
    `${key} development: unexpected Worker name`,
  );
  invariant(
    config.main === expectedDevelopmentMains[key],
    `${key} development: entrypoint drifted`,
  );
  invariant(
    config.compatibility_date === "2026-07-29",
    `${key} development: compatibility date drifted from the local runtime`,
  );
  invariant(config.workers_dev === false, `${key} development: workers.dev must remain disabled`);
  invariant(config.preview_urls === false, `${key} development: preview URLs must remain disabled`);
  invariant((config.routes ?? []).length === 0, `${key} development: public routes are forbidden`);
  invariant(
    !("secrets" in config),
    `${key} development: secrets would enable ambient environment overrides`,
  );
  invariant(!("dispatch_namespaces" in config), `${key} development: Workers for Platforms is forbidden`);
  assertDevelopmentServices(key, config.services ?? []);
}

invariant(
  developmentConfigs.account.vars?.ENVIRONMENT === "test"
    && developmentConfigs.account.vars?.GSV_ACCOUNT_ORIGIN === "http://localhost:8976"
    && developmentConfigs.account.vars?.GSV_BASE_DOMAIN === "localhost"
    && developmentConfigs.account.vars?.GSV_INSTALLATION_ORIGIN_TEMPLATE
      === "http://{handle}.localhost:8976",
  "account development: local-only runtime boundary drifted",
);
invariant(
  developmentLauncher.includes("CLOUDFLARE_INCLUDE_PROCESS_ENV=false")
    && developmentLauncher.includes("CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false")
    && developmentLauncher.includes('--env-file "$EMPTY_ENV_FILE"'),
  "development launcher: ambient environment isolation is missing",
);
invariant(
  developmentConfigs.inference.vars?.ENVIRONMENT === "test"
    && developmentConfigs.inference.vars?.MANAGED_INFERENCE_PROVIDER === "synthetic",
  "inference development: credential-free synthetic provider is missing",
);
invariant(
  !("ai" in developmentConfigs.gateway),
  "gateway development: Workers AI must not be activated locally",
);
invariant(
  developmentConfigs.gateway.assets?.directory === "../.wrangler/managed-dev-assets/"
    && JSON.stringify(developmentConfigs.gateway.assets?.run_worker_first) === '["/*"]',
  "gateway development: the primary host router must own all local assets",
);
invariant(
  !("assets" in developmentConfigs.account),
  "account development: auxiliary assets must be staged behind the primary host router",
);
const developmentAccountOrigin = developmentConfigs.account.vars?.GSV_ACCOUNT_ORIGIN;
invariant(
  developmentAccountOrigin === developmentConfigs.gateway.vars?.GSV_ACCOUNT_ORIGIN
    && developmentAccountOrigin === developmentConfigs.telegram.vars?.GSV_ACCOUNT_ORIGIN
    && developmentAccountOrigin === "http://localhost:8976",
  "development: account origins must share the local ingress",
);
for (const key of ["gateway", "inference", "ripgit"]) {
  invariant(
    (configs[key].secrets?.required ?? []).length === 0,
    `${key}: this service must not own production credentials`,
  );
}

const secretOwners = new Map();
for (const [key, config] of Object.entries(configs)) {
  for (const name of config.secrets?.required ?? []) {
    invariant(!secretOwners.has(name), `${name}: secret is declared by multiple services`);
    secretOwners.set(name, key);
  }
}

process.stdout.write(
  [
    "Managed GSV topology is internally consistent.",
    "Public: accounts.gsv.space -> gsv-accounts",
    "Public: telegram.gsv.space -> gsv-managed-telegram",
    "Public: *.gsv.space -> gsv-managed-gateway",
    "Internal only: gsv-inference, gsv-managed-ripgit",
    "Managed inference provider: disabled (release gate intact)",
    "Local managed graph: five credential-free *-dev Workers on localhost:8976",
  ].join("\n") + "\n",
);

function assertRoutes(key, expected) {
  const actual = (configs[key].routes ?? [])
    .map((route) => [route.pattern, route.zone_name])
    .sort(compareTuples);
  const normalizedExpected = [...expected].sort(compareTuples);
  invariant(
    JSON.stringify(actual) === JSON.stringify(normalizedExpected),
    `${key}: public routes drifted`,
  );
}

function assertServices(key, actualBindings, expectedBindings) {
  const actual = actualBindings
    .map((binding) => [binding.binding, binding.service, binding.entrypoint])
    .sort(compareTuples);
  const expected = [...expectedBindings].sort(compareTuples);
  invariant(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${key}: service binding graph drifted`,
  );
  for (const [, target] of actual) {
    invariant(
      Object.values(expectedNames).includes(target),
      `${key}: ${target} is outside the managed service graph`,
    );
  }
}

function assertDevelopmentServices(key, actualBindings) {
  const actual = actualBindings
    .map((binding) => [binding.binding, binding.service, binding.entrypoint])
    .sort(compareTuples);
  const expected = [...expectedDevelopmentServices[key]].sort(compareTuples);
  invariant(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${key} development: service binding graph drifted`,
  );
  for (const [, target] of actual) {
    invariant(
      Object.values(expectedDevelopmentNames).includes(target),
      `${key} development: ${target} is outside the local managed graph`,
    );
  }
}

function compareTuples(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}
