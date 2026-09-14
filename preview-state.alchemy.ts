import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { gsvPreviewState, parseGsvPreviewIdentity } from "./deployment/src/preview.ts";

const identity = parseGsvPreviewIdentity(process.env);

export default Alchemy.Stack(identity.stack, {
  providers: Cloudflare.providers(),
  state: gsvPreviewState(process.env),
}, Effect.gen(function* () {
  const stage = yield* Alchemy.Stage;
  if (stage !== identity.stage) throw new Error("Preview state stage must match the pull request");
  return {};
}));
