import { admitRepository } from "./gsv/admission";
import type { PdsEnv } from "./gsv/env";
import { republishLexicons } from "./gsv/lexicons";
import { handleOperator, OPERATOR_PATH } from "./gsv/operator";
import { handleXrpc } from "./host/xrpc";

export { PdsLifecycleEntrypoint } from "./gsv/lifecycle";
export { PdsModerationEntrypoint } from "./gsv/moderation";
export { PdsPublisherEntrypoint } from "./gsv/publisher";
export { HostFirehose } from "./host/firehose";
export { HostedRepo } from "./host/repo";

export default {
  fetch: (request, env) => new URL(request.url).pathname === OPERATOR_PATH
    ? handleOperator(request, env)
    : handleXrpc(request, env, (name) => admitRepository(env.INSTALLATION_DIRECTORY, name)),
  // A deploy's lexicons take over once the operator has published.
  scheduled: async (_controller, env) => {
    await republishLexicons(env);
  },
} satisfies ExportedHandler<PdsEnv>;
