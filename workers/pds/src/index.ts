import type { PdsEnv } from "./gsv/env";
import { republishLexicons } from "./gsv/lexicons";
import { handleOperator, OPERATOR_PATH } from "./gsv/operator";
import { announceToRelays } from "./host/firehose";
import { handleXrpc } from "./host/xrpc";

export { PdsLifecycleEntrypoint } from "./gsv/lifecycle";
export { PdsModerationEntrypoint } from "./gsv/moderation";
export { PdsPublisherEntrypoint } from "./gsv/publisher";
export { HostFirehose } from "./host/firehose";
export { HostedRepo } from "./host/repo";

export default {
  fetch: (request, env) => new URL(request.url).pathname === OPERATOR_PATH
    ? handleOperator(request, env)
    : handleXrpc(request, env),
  // A deploy's lexicons take over once the operator has published.
  // Relays hear of the host's new events. Each job runs whatever the other does, and a failure fails the run.
  scheduled: async (_controller, env) => {
    const failed = (await Promise.allSettled([republishLexicons(env), announceToRelays(env)]))
      .flatMap((job) => job.status === "rejected" ? [job.reason] : []);
    if (failed.length > 0) throw failed.length === 1 ? failed[0] : new AggregateError(failed, "Scheduled PDS jobs failed");
  },
} satisfies ExportedHandler<PdsEnv>;
