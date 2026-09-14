import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { readFileSync } from "node:fs";
import { gsvDeploymentManifestSchema } from "./deployment/src/manifest.ts";
import { GsvPreview, gsvPreviewState, parseGsvPreviewConfig, parseGsvPreviewIdentity } from "./deployment/src/preview.ts";

const identity = parseGsvPreviewIdentity(process.env);

export default Alchemy.Stack(identity.stack, {
  providers: Cloudflare.providers(),
  state: gsvPreviewState(process.env),
}, Effect.gen(function* () {
  const stage = yield* Alchemy.Stage;
  const config = parseGsvPreviewConfig(process.env, stage);
  const manifest = gsvDeploymentManifestSchema.parse(JSON.parse(readFileSync("./dist/cloudflare/deployment-manifest.json", "utf8")));
  return yield* GsvPreview({ config, stage, manifest });
}));
