import { createExecutionContext, listDurableObjectIds } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { InstallationDirectoryService, InstallationState } from "@humansandmachines/gsv/services/directory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PUBLIC_BLOB_MAX_BYTES } from "@humansandmachines/gsv/services/pds";
import { fromBase64Url } from "@atcute/multibase";
import { admitInstallation, followAdmission } from "../src/gsv/admission";
import type { PdsEnv } from "../src/gsv/env";
import { PdsPublisherEntrypoint } from "../src/gsv/publisher";
import { MAX_BLOB_BYTES } from "../src/host/repo";
import worker from "../src/index";
import { FakeAccounts } from "./accounts";
import { FakePlcDirectory } from "./plc";
import { deliver, errorOf, installFakePlc, read, rejection, upload } from "./support";

const NOTE = "com.example.note";

let plc: FakePlcDirectory;
let accounts: FakeAccounts;

beforeEach(() => {
  plc = new FakePlcDirectory();
  installFakePlc(plc, env.PLC_URL);
  accounts = new FakeAccounts();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("publishing for an installation", () => {
  it.each([["no", null], ["an empty", ""], ["the deletion", "installation-deletion"]])("refuses %s binding authority before reading Accounts", async (_label, authority) => {
    const { installationId } = accounts.add();
    const resolve = vi.spyOn(accounts, "resolveInstallation");
    expect(await rejection(publisher(authority).getInstallation(installationId))).toContain("publishing authority");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses an installation Accounts reports neither active nor restricted, without addressing its repository", async () => {
    const before = await listDurableObjectIds(env.REPOS);
    const refused = [
      `inst_${crypto.randomUUID()}`,
      accounts.add("provisioning").installationId,
      accounts.add("retained").installationId,
    ];
    for (const installationId of refused) {
      expect(await rejection(publisher().getInstallation(installationId))).toContain("active installation");
    }
    expect(await rejection(publisher().getInstallation(""))).toContain("Invalid installation");
    expect(await listDurableObjectIds(env.REPOS)).toHaveLength(before.length);
  });

  it("creates the account for a handle Accounts routes to the installation, then keeps it", async () => {
    const ship = accounts.add();
    const other = accounts.add();
    const repository = await publisher().getInstallation(ship.installationId);
    expect(await repository.account()).toBeNull();
    for (const handle of [other.handle, "nobody.ship.test"]) {
      expect(await rejection(repository.ensureAccount(handle))).toContain("InvalidHandle");
    }

    const account = await repository.ensureAccount(ship.handle.toUpperCase());
    expect(account).toEqual({ did: expect.stringMatching(/^did:plc:/), handle: ship.handle, host: env.PDS_ORIGIN });
    expect(plc.operations(account.did)).toEqual([expect.objectContaining({
      alsoKnownAs: [`at://${ship.handle}`],
      // Other Ships call the Ship at its address, the same name as its handle.
      services: expect.objectContaining({ ship: { type: "ShipService", endpoint: `https://${ship.handle}` } }),
    })]);
    // Another hostname for the same installation finds the account it already has.
    expect(await repository.ensureAccount(ship.canonical)).toEqual(account);
    expect(plc.operations(account.did)).toHaveLength(1);
    expect(await repository.account()).toEqual(account);
    expect(await env.REPOS.getByName(ship.installationId).account()).toEqual({ did: account.did, handle: account.handle });
  });

  it("gives a restricted installation its DID but publishes and signs nothing for it", async () => {
    const ship = accounts.add("restricted");
    const repository = await publisher().getInstallation(ship.installationId);
    const account = await repository.ensureAccount(ship.handle);
    expect(account).toEqual({ did: expect.stringMatching(/^did:plc:/), handle: ship.handle, host: env.PDS_ORIGIN });
    expect(await repository.account()).toEqual(account);
    const refusal = "active installation";
    expect(await rejection(repository.serviceAuth({ aud: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb#ship", lxm: "space.ship.deliver" }))).toContain(refusal);
    expect(await rejection(repository.applyWrites([{
      action: "put", collection: NOTE, rkey: "self",
      record: { $type: NOTE, text: "hello", createdAt: "2026-10-23T00:00:00.000Z" },
    }]))).toContain(refusal);
    expect(await rejection(upload(repository, "avatar"))).toContain(refusal);
    expect(await rejection(repository.readBlob("bafkreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm"))).toContain(refusal);
    expect(await admitInstallation(accounts, ship.installationId)).toBe("suspended");
  });

  it("signs only Ship methods addressed to another Ship's service", async () => {
    const ship = accounts.add();
    const repository = await publisher().getInstallation(ship.installationId);
    const { did } = await repository.ensureAccount(ship.handle);
    const aud = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb#ship";
    for (const request of [
      { aud: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb#atproto_pds", lxm: "space.ship.deliver" },
      { aud: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb", lxm: "space.ship.deliver" },
      { aud, lxm: "com.atproto.server.createAccount" },
    ]) {
      expect(await rejection(repository.serviceAuth(request))).toContain("InvalidRequest");
    }
    const token = await repository.serviceAuth({ aud, lxm: "space.ship.deliver" });
    const payload = token.split(".")[1] ?? "";
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(payload)))).toMatchObject({ iss: did, aud, lxm: "space.ship.deliver" });
  });

  it("publishes records and blobs under the installation's storage prefix", async () => {
    const ship = accounts.add();
    const repository = await publisher().getInstallation(ship.installationId);
    const { did } = await repository.ensureAccount(ship.handle);
    const blob = await upload(repository, "avatar");
    const commit = await repository.applyWrites([{
      action: "put",
      collection: NOTE,
      rkey: "self",
      record: { $type: NOTE, text: "hello", createdAt: "2026-10-23T00:00:00.000Z", file: blob },
    }]);
    expect(commit.results).toEqual([{ uri: `at://${did}/${NOTE}/self`, cid: expect.any(String) }]);
    const prefix = `installations/${encodeURIComponent(ship.installationId)}/`;
    expect((await env.BLOBS.list({ prefix })).objects.map((object) => object.key))
      .toEqual([`${prefix}${did}/${blob.ref.$link}`]);
    const read = await repository.readBlob(blob.ref.$link);
    expect(read && await new Response(read.body).text()).toBe("avatar");
  });

  it("accepts blobs as large as a message may attach", () => {
    expect(MAX_BLOB_BYTES).toBe(PUBLIC_BLOB_MAX_BYTES);
  });
});

describe("public reads", () => {
  const repoStatus = z.object({ did: z.string(), active: z.boolean(), status: z.string().optional() });

  it("serves an installation's repository as it follows Accounts' state, without asking Accounts for a read", async () => {
    const ship = accounts.add();
    const repository = await publisher().getInstallation(ship.installationId);
    const { did } = await repository.ensureAccount(ship.handle);
    const repo = env.REPOS.getByName(ship.installationId);
    await deliver(repo);
    const describe = () => serve("com.atproto.repo.describeRepo", { repo: ship.handle });
    const status = () => serve("com.atproto.sync.getRepoStatus", { did });
    const asked = vi.spyOn(accounts, "resolveInstallation");

    expect((await read(z.object({ did: z.string() }), describe())).did).toBe(did);
    expect(await read(repoStatus, status())).toMatchObject({ did, active: true });
    expect(asked).not.toHaveBeenCalled();

    accounts.setState(ship.installationId, "restricted");
    await followAdmission(accounts, ship.installationId, repo);
    asked.mockClear();
    expect(await errorOf(describe())).toBe("RepoSuspended");
    expect(await read(repoStatus, status())).toEqual({ did, active: false, status: "suspended" });

    accounts.setState(ship.installationId, "retained");
    await followAdmission(accounts, ship.installationId, repo);
    asked.mockClear();
    expect(await errorOf(describe())).toBe("RepoNotFound");
    expect(await read(repoStatus, status())).toEqual({ did, active: false, status: "deleted" });
    expect(asked).not.toHaveBeenCalled();
  });

  it("keeps serving reads while Accounts cannot answer", async () => {
    const ship = accounts.add();
    const repository = await publisher().getInstallation(ship.installationId);
    const { did } = await repository.ensureAccount(ship.handle);
    await deliver(env.REPOS.getByName(ship.installationId));
    vi.spyOn(accounts, "resolveInstallation").mockRejectedValue(new Error("Accounts unavailable"));

    const response = await serve("com.atproto.sync.getLatestCommit", { did });
    expect(response.status).toBe(200);
  });

  it.each<[InstallationState, string]>([
    ["active", "active"],
    ["reserved", "suspended"],
    ["provisioning", "suspended"],
    ["trialing", "suspended"],
    ["past_due", "suspended"],
    ["restricted", "suspended"],
    ["cancelled", "suspended"],
    ["retained", "deleted"],
    ["deleting", "deleted"],
    ["deleted", "deleted"],
  ])("admits a %s installation as %s", async (state, admission) => {
    const { installationId } = accounts.add(state);
    expect(await admitInstallation(accounts, installationId)).toBe(admission);
  });

  it("treats an installation Accounts does not know, or names differently, as deleted", async () => {
    expect(await admitInstallation(accounts, `inst_${crypto.randomUUID()}`)).toBe("deleted");
    const { installationId } = accounts.add();
    const renamed: InstallationDirectoryService = {
      resolveHostname: (hostname) => accounts.resolveHostname(hostname),
      resolveInstallation: async (id) => ({ ...(await accounts.resolveInstallation(id)), installationId: `${id}-other` }),
    };
    expect(await admitInstallation(renamed, installationId)).toBe("deleted");
  });
});

/** The publisher entrypoint as a binding with the given authority, or with no props at all, sees it. */
function publisher(authority: string | null = "kernel-publish"): PdsPublisherEntrypoint {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "props", { value: authority === null ? undefined : { authority } });
  // SAFETY: The entrypoint reads only its binding props and the host's bindings.
  return new PdsPublisherEntrypoint(ctx as never, deployedEnv() as never);
}

/** Sends a public XRPC query to the deployed worker. */
function serve(method: string, params: Record<string, string>): Promise<Response> {
  const request = new Request<unknown, IncomingRequestCfProperties>(`https://pds.test/xrpc/${method}?${new URLSearchParams(params)}`);
  return worker.fetch(request, deployedEnv());
}

function deployedEnv(): PdsEnv {
  return { ...env, INSTALLATION_DIRECTORY: accounts };
}
