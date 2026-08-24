import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { readFileSync } from "node:fs";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  StandaloneGsvDeployment,
  gsvDeploymentManifestSchema,
} from "./deployment/src/index.ts";

const manifest = gsvDeploymentManifestSchema.parse(
  JSON.parse(
    readFileSync("./dist/cloudflare/deployment-manifest.json", "utf8"),
  ),
);

export default Alchemy.Stack(
  "gsv",
  {
    providers: Layer.mergeAll(Cloudflare.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const configuredAdapters = yield* Config.string("GSV_ADAPTERS").pipe(
      Config.withDefault(manifest.adapters.map((adapter) => adapter.id).join(",")),
    );
    const adapterIds = [
      ...new Set(
        configuredAdapters
          .split(",")
          .map((adapter) => adapter.trim())
          .filter(Boolean),
      ),
    ];
    const deployment = yield* StandaloneGsvDeployment({
      manifest,
      adapterIds,
    });
    return {
      gateway: {
        name: deployment.gateway.workerName,
        url: deployment.gateway.url,
      },
      adapters: deployment.adapters.map((adapter) => ({
        id: adapter.id,
        workerName: adapter.worker.workerName,
        url: adapter.worker.url,
      })),
      storageBucket: deployment.storage.bucketName,
    };
  }),
);
