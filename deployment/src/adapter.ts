import * as Config from "effect/Config";
import * as Schema from "effect/Schema";
import * as Cloudflare from "alchemy/Cloudflare";
import { retain } from "alchemy/RemovalPolicy";
import type {
  AdapterDeploymentManifest,
  AdapterWorkerDeploymentManifest,
} from "./manifest.ts";
import { GSV_WORKER_COMPATIBILITY } from "./runtime.ts";

export type GsvAdapterWorkerProps = {
  logicalId: string;
  workerName: string;
  adapter: AdapterDeploymentManifest;
  deployment: AdapterWorkerDeploymentManifest;
  env?: Cloudflare.Workers.WorkerBindingProps;
  secrets?: Readonly<
    Record<string, { env: string; pattern?: RegExp }>
  >;
  compatibility?: typeof GSV_WORKER_COMPATIBILITY;
  workersDev?: boolean | Cloudflare.Workers.WorkersDevConfig;
  observability?: Cloudflare.Workers.WorkerObservability;
};

export type GsvAdapterWorkerRuntime = {
  Cloudflare: typeof Cloudflare;
  Config: typeof Config;
  Schema: typeof Schema;
  retain: typeof retain;
};

const defaultRuntime: GsvAdapterWorkerRuntime = {
  Cloudflare,
  Config,
  Schema,
  retain,
};

export const GsvAdapterWorker = (
  props: GsvAdapterWorkerProps,
  runtime: GsvAdapterWorkerRuntime = defaultRuntime,
) => {
  const env = props.env ?? {};
  const secrets = props.secrets ?? {};
  for (const secret of props.deployment.requiredSecrets) {
    if (!(secret in secrets)) {
      throw new Error(
        `${props.adapter.displayName} requires deployment secret ${secret}`,
      );
    }
  }
  const workerEnv: Cloudflare.Workers.WorkerBindingProps = Object.fromEntries(
    props.deployment.durableObjects.map((durableObject) => [
      durableObject.binding,
      runtime.Cloudflare.DurableObject(durableObject.binding, {
        className: durableObject.className,
      }),
    ]),
  );
  if (props.deployment.selfUrlBinding) {
    workerEnv[props.deployment.selfUrlBinding] = runtime.Cloudflare.Worker.URL;
  }
  for (const [binding, secret] of Object.entries(secrets)) {
    if (binding in env) {
      throw new Error(
        `${binding} cannot be both an environment value and a secret`,
      );
    }
    const valueSchema = secret.pattern
      ? runtime.Schema.String.check(runtime.Schema.isPattern(secret.pattern))
      : runtime.Schema.NonEmptyString;
    workerEnv[binding] = runtime.Config.schema(
      runtime.Schema.Redacted(valueSchema),
      secret.env,
    );
  }
  Object.assign(workerEnv, env);
  return runtime.Cloudflare.Worker(props.logicalId, {
    name: props.workerName,
    main: props.deployment.main,
    bundle: props.deployment.bundle,
    compatibility: props.compatibility ?? GSV_WORKER_COMPATIBILITY,
    workersDev: props.workersDev ?? false,
    observability: props.observability ?? { enabled: true },
    env: workerEnv,
  }).pipe(runtime.retain());
};
