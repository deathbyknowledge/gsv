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

const configs = Object.fromEntries(
  Object.entries(configPaths).map(([key, relativePath]) => [
    key,
    JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8")),
  ]),
);

const expectedNames = {
  gateway: "gsv-managed-gateway",
  account: "gsv-accounts",
  inference: "gsv-inference",
  telegram: "gsv-managed-telegram",
  ripgit: "gsv-managed-ripgit",
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

function compareTuples(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}
