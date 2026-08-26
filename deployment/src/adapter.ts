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
  compatibility?: typeof GSV_WORKER_COMPATIBILITY;
  workersDev?: boolean | Cloudflare.Workers.WorkersDevConfig;
  observability?: Cloudflare.Workers.WorkerObservability;
};

export const GsvAdapterWorker = (props: GsvAdapterWorkerProps) => {
  const env = props.env ?? {};
  for (const secret of props.deployment.requiredSecrets) {
    if (!(secret in env)) {
      throw new Error(
        `${props.adapter.displayName} requires deployment secret ${secret}`,
      );
    }
  }
  const workerEnv: Cloudflare.Workers.WorkerBindingProps = Object.fromEntries(
    props.deployment.durableObjects.map((durableObject) => [
      durableObject.binding,
      Cloudflare.DurableObject(durableObject.binding, {
        className: durableObject.className,
      }),
    ]),
  );
  if (props.deployment.selfUrlBinding) {
    workerEnv[props.deployment.selfUrlBinding] = Cloudflare.Worker.URL;
  }
  Object.assign(workerEnv, env);
  return Cloudflare.Worker(props.logicalId, {
    name: props.workerName,
    main: props.deployment.main,
    bundle: props.deployment.bundle,
    compatibility: props.compatibility ?? GSV_WORKER_COMPATIBILITY,
    workersDev: props.workersDev ?? false,
    observability: props.observability ?? { enabled: true },
    env: workerEnv,
  }).pipe(retain());
};
