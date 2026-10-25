import { admitInstallation } from "./gsv/admission";
import type { PdsEnv } from "./gsv/env";
import { handleXrpc } from "./host/xrpc";

export { PdsLifecycleEntrypoint } from "./gsv/lifecycle";
export { PdsModerationEntrypoint } from "./gsv/moderation";
export { PdsPublisherEntrypoint } from "./gsv/publisher";
export { HostFirehose } from "./host/firehose";
export { HostedRepo } from "./host/repo";

export default {
  fetch: (request, env) => handleXrpc(request, env, (name) => admitInstallation(env.INSTALLATION_DIRECTORY, name)),
} satisfies ExportedHandler<PdsEnv>;
