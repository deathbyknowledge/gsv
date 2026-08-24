import * as Cloudflare from "alchemy/Cloudflare";
import { retain } from "alchemy/RemovalPolicy";
import type { AdapterDeploymentManifest } from "./manifest.ts";
import { GSV_WORKER_COMPATIBILITY } from "./runtime.ts";

export type GsvAdapterWorkerProps = {
  logicalId: string;
  workerName: string;
  manifest: AdapterDeploymentManifest;
  env?: Cloudflare.Workers.WorkerBindingProps;
  compatibility?: typeof GSV_WORKER_COMPATIBILITY;
  workersDev?: boolean | Cloudflare.Workers.WorkersDevConfig;
  observability?: Cloudflare.Workers.WorkerObservability;
};

export const GsvAdapterWorker = (props: GsvAdapterWorkerProps) =>
  Cloudflare.Worker(props.logicalId, {
    name: props.workerName,
    main: props.manifest.main,
    compatibility: props.compatibility ?? GSV_WORKER_COMPATIBILITY,
    workersDev: props.workersDev ?? false,
    observability: props.observability ?? { enabled: true },
    env: {
      ...Object.fromEntries(
        props.manifest.durableObjects.map((durableObject) => [
          durableObject.binding,
          Cloudflare.DurableObject(durableObject.binding, {
            className: durableObject.className,
          }),
        ]),
      ),
      ...props.env,
    },
  }).pipe(retain());
