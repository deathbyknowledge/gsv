import type { WebSearchArgs, WebSearchResult } from "@humansandmachines/gsv/protocol";
import { WEB_SEARCH_TIMEOUT_MS, webSearchQuerySchema } from "@humansandmachines/gsv/services/web-search";
import type { KernelContext } from "../../kernel/context";
import { principalOf } from "../../kernel/context";
import { hasCapability } from "../../kernel/capabilities";
import { raceWithAbort } from "../../shared/abort";

export async function handleWebSearch(value: WebSearchArgs, ctx: KernelContext): Promise<WebSearchResult> {
  if (!hasCapability(principalOf(ctx)?.calls ?? [], "web.search")) throw new Error("Permission denied: web.search");
  const args = webSearchQuerySchema.parse(value);
  const service = ctx.env.WEB_SEARCH;
  if (!service) throw new Error("Web search is not configured for this installation");
  const signal = ctx.requestSignal
    ? AbortSignal.any([ctx.requestSignal, AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS)])
    : AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS);
  signal.throwIfAborted();
  const deadlineAt = Date.now() + WEB_SEARCH_TIMEOUT_MS;
  const target = await raceWithAbort(service.getInstallation(ctx.installationId), signal, {
    onLateResolve: (late) => late[Symbol.dispose]?.(),
  });
  const requestId = crypto.randomUUID();
  try {
    signal.throwIfAborted();
    return await raceWithAbort(target.search({ requestId, deadlineAt, search: args }), signal, {
      onAbort: () => { ctx.defer(target.cancel(requestId).catch(() => {})); },
    });
  } finally {
    target[Symbol.dispose]?.();
  }
}
