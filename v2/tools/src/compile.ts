import { DURABLE_OBJECTS, type GsvConfig } from "@gsv/runtime/config";

/** Both targets run the same bundle with the same date and flags. */
export const COMPATIBILITY_FLAGS = ["nodejs_compat"];

/** Secrets never enter a compiled config: Cloudflare stores them, workerd reads them from its environment. */
export const SECRETS = ["GSV_SECRET", "GSV_SETUP"] as const;

export type WranglerConfig = ReturnType<typeof compileWrangler>;

/** The Cloudflare deployment: spaces on `<handle>.<domain>`, bytes in R2, the UI as static assets. */
export function compileWrangler(config: GsvConfig, paths: { main: string; ui: string }) {
  refuseUnwired(config);
  return {
    name: config.name,
    main: paths.main,
    no_bundle: true,
    compatibility_date: config.compatibilityDate,
    compatibility_flags: COMPATIBILITY_FLAGS,
    workers_dev: false,
    routes: [
      { pattern: `${config.domain}/*`, zone_name: config.domain },
      { pattern: `*.${config.domain}/*`, zone_name: config.domain },
    ],
    durable_objects: { bindings: DURABLE_OBJECTS.map(({ binding, className }) => ({ name: binding, class_name: className })) },
    migrations: migrations(),
    r2_buckets: [{ binding: "BLOBS", bucket_name: `${config.name}-blobs` }],
    assets: { directory: paths.ui, binding: "ASSETS", run_worker_first: true },
    vars: vars(config),
  };
}

/**
 * The self-hosted deployment as one workerd process. Directories and the listening address are given at
 * start, so the compiled file moves between machines:
 * `workerd serve workerd.capnp --directory-path gsv-data=<dir> --directory-path gsv-ui=<dir> --socket-addr http=<addr>`.
 */
export function compileWorkerd(config: GsvConfig, paths: { worker: string; assets: string }): string {
  refuseUnwired(config);
  const s3 = config.selfHost?.s3;
  const bindings = [
    ...DURABLE_OBJECTS.map(({ binding, className }) => `(name = ${text(binding)}, durableObjectNamespace = ${text(className)})`),
    `(name = "ASSETS", service = "gsv-assets")`,
    ...Object.entries(vars(config)).map(([name, value]) => `(name = ${text(name)}, text = ${text(value)})`),
    ...SECRETS.map(name => `(name = ${text(name)}, fromEnvironment = ${text(name)})`),
    ...(s3 ? [
      `(name = "S3_ENDPOINT", text = ${text(s3.endpoint)})`,
      `(name = "S3_BUCKET", text = ${text(s3.bucket)})`,
      `(name = "S3_REGION", text = ${text(s3.region)})`,
      `(name = "S3_ACCESS_KEY_ID", fromEnvironment = "S3_ACCESS_KEY_ID")`,
      `(name = "S3_SECRET_ACCESS_KEY", fromEnvironment = "S3_SECRET_ACCESS_KEY")`,
      `(name = "S3_NETWORK", service = "gsv-s3")`,
    ] : []),
  ];
  // The key names each class's storage on disk; it stays fixed for the life of the deployment.
  const namespaces = DURABLE_OBJECTS.map(({ className }) => `(className = ${text(className)}, uniqueKey = ${text(`${config.name}-${className}`)}, enableSql = true)`);
  const services = [
    `(name = "gsv", worker = .gsv)`,
    `(name = "gsv-assets", worker = .assets)`,
    `(name = "gsv-ui", disk = (writable = false))`,
    `(name = "gsv-data", disk = (writable = true))`,
    // Other outbound fetches stay on the public internet, as on Cloudflare; only the blob store may reach a private server.
    ...(s3 ? [`(name = "gsv-s3", network = (allow = ["public", "private", "local"]))`] : []),
  ];
  return `# Compiled by gsv build from the deployment's gsv.config.ts. Do not edit.
# Run: workerd serve workerd.capnp --directory-path gsv-data=<dir> --directory-path gsv-ui=<dir> --socket-addr http=<addr>
# ${SECRETS.join(" and ")}${s3 ? ", S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY" : ""} come from the environment.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
${list(services, 4)}
  ],
  sockets = [(name = "http", address = "*:8787", http = (), service = "gsv")],
);

const gsv :Workerd.Worker = (
  modules = [(name = ${text(paths.worker)}, esModule = embed ${text(paths.worker)})],
  compatibilityDate = ${text(config.compatibilityDate)},
  compatibilityFlags = [${COMPATIBILITY_FLAGS.map(text).join(", ")}],
  bindings = [
${list(bindings, 4)}
  ],
  durableObjectNamespaces = [
${list(namespaces, 4)}
  ],
  durableObjectStorage = (localDisk = "gsv-data"),
);

const assets :Workerd.Worker = (
  modules = [(name = ${text(paths.assets)}, esModule = embed ${text(paths.assets)})],
  compatibilityDate = ${text(config.compatibilityDate)},
  bindings = [(name = "DISK", service = "gsv-ui")],
);
`;
}

/** One Cloudflare migration per tag, in the order the classes were introduced. */
export function migrations(): { tag: string; new_sqlite_classes: string[] }[] {
  const tags = [...new Set(DURABLE_OBJECTS.map(object => object.since))];
  return tags.map(tag => ({ tag, new_sqlite_classes: DURABLE_OBJECTS.filter(object => object.since === tag).map(object => object.className) }));
}

function vars(config: GsvConfig): Record<string, string> {
  return { GSV_DOMAIN: config.domain, GSV_RELEASE: config.release, GSV_OPERATOR_SPACE: config.operatorSpace };
}

/** A config may name services before the runtime can bind them; compiling then would drop them silently. */
function refuseUnwired(config: GsvConfig): void {
  const { messengers, ...services } = config.services;
  const bound = [
    ...Object.entries(services).filter(([, value]) => value !== "none").map(([key]) => `services.${key}`),
    ...Object.entries(messengers).filter(([, value]) => value !== "none").map(([key]) => `services.messengers.${key}`),
    ...(config.plans === "none" ? [] : ["plans"]),
  ];
  if (bound.length) throw new Error(`This build can't bind ${bound.join(", ")} yet. Set ${bound.length === 1 ? "it" : "them"} to "none".`);
}

/** A Cap'n Proto text literal. Config values are plain strings, so control characters are refused rather than escaped. */
function text(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Unexpected control character in ${JSON.stringify(value)}`);
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function list(items: string[], indent: number): string {
  return items.map(item => `${" ".repeat(indent)}${item},`).join("\n");
}
