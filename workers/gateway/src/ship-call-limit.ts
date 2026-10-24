import { ShipXrpcError } from "./kernel/ships/errors";
import { xrpcErrorResponse } from "./kernel/ships/xrpc";

/** The period of the `SHIP_CALLS` binding's budget. */
const PERIOD_MS = 10_000;
/** The address Cloudflare gives every call a Worker makes to another zone. */
const WORKER_ADDRESS = "2a06:98c0:3600::103";

/**
 * The Gateway's rough budget for each source of calls to each Ship, spent
 * before a call reaches the Kernel. Workers on other zones all call from one
 * address, so their zone, which Cloudflare names in `cf-worker`, tells them
 * apart; from any other address that header is the caller's own. The Kernel
 * keeps each caller DID's exact budget.
 */
export async function limitShipCalls(request: Request, limiter: RateLimit, installationId: string): Promise<Response | null> {
  const address = request.headers.get("cf-connecting-ip") ?? "";
  const source = address === WORKER_ADDRESS ? `${address} ${request.headers.get("cf-worker") ?? ""}` : address;
  const { success } = await limiter.limit({ key: `${installationId} ${source}` });
  if (success) return null;
  return xrpcErrorResponse(new ShipXrpcError(429, "RateLimitExceeded", "Too many calls to this Ship; try again shortly", PERIOD_MS));
}
