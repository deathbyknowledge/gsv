import { WorkerEntrypoint } from "cloudflare:workers";
import type { InstallationDirectoryResult, InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";
import type { PdsService } from "@humansandmachines/gsv/services/pds";
import { FakePlcDirectory } from "../test/plc";

type SmokeEnv = {
  /** The host's publisher, as the Kernel's deployment binding sees it. */
  PDS: PdsService;
};

const INSTALLATION_ID = "inst_smoke";
const HANDLE = "smoke.ship.test";
const NOTE = "space.gsv.note";

/** Identity operations the host registers during the run; a restart starts an empty directory. */
const plc = new FakePlcDirectory();

/** Accounts with one active installation, whose Ship address is HANDLE. */
export class SmokeAccounts extends WorkerEntrypoint implements InstallationDirectoryService {
  async resolveHostname(hostname: string): Promise<InstallationDirectoryResult> {
    return hostname === HANDLE ? installation() : { found: false };
  }

  async resolveInstallation(installationId: string): Promise<InstallationDirectoryResult> {
    return installationId === INSTALLATION_ID ? installation() : { found: false };
  }
}

/**
 * Serves the PLC directory at DID paths. /_smoke/ready answers once the host
 * reaches Accounts through its binding, and /_smoke/publish runs the scenario.
 */
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    // Clients may percent-encode the DID in the path, as @atcute/did-plc does.
    if (decodeURIComponent(pathname).startsWith("/did:")) return plc.handle(request);
    if (pathname === "/_smoke/ready") {
      await env.PDS.getInstallation(INSTALLATION_ID);
      return new Response(null, { status: 204 });
    }
    if (pathname === "/_smoke/publish" && request.method === "POST") return Response.json(await publish(env.PDS));
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<SmokeEnv>;

/** Creates the account, then creates, updates and deletes records across three commits. */
async function publish(pds: PdsService) {
  const repository = await pds.getInstallation(INSTALLATION_ID);
  const account = await repository.ensureAccount(HANDLE);
  const blob = await repository.uploadBlob(new TextEncoder().encode("smoke attachment"), "text/plain");
  const note = (text: string) => ({ $type: NOTE, text, createdAt: "2026-10-23T00:00:00.000Z" });
  const commits = [
    await repository.applyWrites([
      { action: "create", collection: NOTE, rkey: "first", record: { ...note("first"), attachment: blob } },
      { action: "create", collection: NOTE, rkey: "second", record: note("second") },
    ]),
    await repository.applyWrites([{ action: "put", collection: NOTE, rkey: "first", record: { ...note("first, edited"), attachment: blob } }]),
    await repository.applyWrites([{ action: "delete", collection: NOTE, rkey: "second" }]),
  ];
  return { ...account, blob: blob.ref.$link, revs: commits.map((commit) => commit.commit.rev) };
}

function installation(): InstallationDirectoryResult {
  return { found: true, installationId: INSTALLATION_ID, state: "active", handle: "smoke", canonicalOrigin: `https://${HANDLE}` };
}
