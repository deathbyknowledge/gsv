import type { PdsService, PublicRepositoryAccount } from "@humansandmachines/gsv/services/pds";
import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import { raceWithAbort } from "./shared/abort";

export const ATPROTO_DID_PATH = "/.well-known/atproto-did";

const LOOKUP_TIMEOUT_MS = 5_000;

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
  // A host claims no handle for an account it has taken down, as Bluesky's PDS answers.
  if (!account || account.status === "takendown" || account.handle !== new URL(request.url).hostname) return notFound();
  return new Response(request.method === "HEAD" ? null : account.did, {
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
