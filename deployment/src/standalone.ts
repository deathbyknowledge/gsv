import * as Effect from "effect/Effect";
import type { GsvDeploymentManifest } from "./manifest.ts";
import { GsvAdapterWorker } from "./adapter.ts";
import { GsvRuntime } from "./runtime.ts";

export type StandaloneGsvDeploymentProps = {
  manifest: GsvDeploymentManifest;
  adapterIds: readonly string[];
};

export const StandaloneGsvDeployment = (
  props: StandaloneGsvDeploymentProps,
) =>
  Effect.gen(function* () {
    const requested = new Set(props.adapterIds);
    const known = new Set(props.manifest.adapters.map((adapter) => adapter.id));
    const missing = [...requested].filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new Error(`Unknown GSV adapters: ${missing.join(", ")}`);
    }

    const adapters = [];
    for (const adapter of props.manifest.adapters) {
      if (!requested.has(adapter.id)) continue;
      const worker = yield* GsvAdapterWorker({
        logicalId: `GsvAdapter-${adapter.id}`,
        workerName: `gsv-channel-${adapter.id}`,
        adapter,
        deployment: adapter.standalone,
        workersDev: { enabled: true, previewsEnabled: false },
      });
      adapters.push({
        id: adapter.id,
        gatewayBinding: adapter.gatewayBinding,
        gatewayEntrypoint: adapter.standalone.gatewayEntrypoint,
        gatewayBindingLogicalId: `GsvAdapter-${adapter.id}-GatewayBinding`,
        worker,
      });
    }

    const runtime = yield* GsvRuntime({
      mode: "standalone",
      logicalPrefix: "Gsv",
      names: {
        gateway: "gsv",
        ripgit: "ripgit",
        storageBucket: "gsv-storage",
      },
      paths: props.manifest.runtime,
      workersDev: { enabled: true, previewsEnabled: false },
      services: { adapters },
    });
    return { ...runtime, adapters };
  });
