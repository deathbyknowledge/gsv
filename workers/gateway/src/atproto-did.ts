import type { PdsService, PublicRepositoryAccount } from "@humansandmachines/gsv/services/pds";
import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import { raceWithAbort } from "./shared/abort";

export const ATPROTO_DID_PATH = "/.well-known/atproto-did";

const LOOKUP_TIMEOUT_MS = 5_000;
/** How long a DID the host gave answers its hostname before the host is asked again; a takedown shows within it. */
const DID_CONFIRMATION_MS = 60_000;
/** Hostnames one isolate remembers DIDs for; the oldest answer gives way first. */
const REMEMBERED_HANDLES = 1_024;

type RememberedDid = { installationId: string; did: string; confirmedAt: number };

/**
 * Each isolate's answers, per PDS binding. Only a DID the host gave for the
 * hostname is remembered: a hostname with no account, another handle's or a
 * taken-down account's, or one the host could not answer for, is asked about
 * on every request, so a new account resolves at once.
 */
const rememberedDids = new WeakMap<PdsService, Map<string, RememberedDid>>();

/**
 * Resolves the request's hostname as an ATProto handle: the DID of the
 * installation's public repository, when the repository's account names this
 * hostname as its handle.
 */
export async function serveAtprotoDid(
  request: Request,
  pds: PdsService | undefined,
  installationId: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD", "cache-control": "no-store" } });
  }
  if (!pds) return notFound();
  const hostname = new URL(request.url).hostname;
  let dids = rememberedDids.get(pds);
  if (!dids) {
    dids = new Map();
    rememberedDids.set(pds, dids);
  }
  const remembered = dids.get(hostname);
  if (remembered?.installationId === installationId && Date.now() - remembered.confirmedAt < DID_CONFIRMATION_MS) {
    return didResponse(request, remembered.did);
  }
  const askedAt = Date.now();
  let account: PublicRepositoryAccount | null;
  try {
    const signal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
    const repository = await raceWithAbort(pds.getInstallation(installationId), signal, {
      onLateResolve: (late) => late[Symbol.dispose]?.(),
    });
    try {
      account = await raceWithAbort(repository.account(), signal);
    } finally {
      repository[Symbol.dispose]?.();
    }
  } catch (error) {
    console.error("[Gateway] Public repository lookup failed:", exceptionDiagnostics(error));
    return new Response("Public repository unavailable", { status: 503, headers: { "cache-control": "no-store" } });
  }
  dids.delete(hostname);
  // A host claims no handle for an account it has taken down, as Bluesky's PDS answers; a remembered DID
  // holds for a minute, so this takes hold within a minute of the takedown.
  if (!account || account.status === "takendown" || account.handle !== hostname) return notFound();
  dids.set(hostname, { installationId, did: account.did, confirmedAt: askedAt });
  for (const oldest of dids.keys()) {
    if (dids.size <= REMEMBERED_HANDLES) break;
    dids.delete(oldest);
  }
  return didResponse(request, account.did);
}

function didResponse(request: Request, did: string): Response {
  return new Response(request.method === "HEAD" ? null : did, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function notFound(): Response {
  return new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } });
}
