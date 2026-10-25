import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Secp256k1PrivateKey, Secp256k1PrivateKeyExportable } from "@atcute/crypto";
import { PlcClient, signOperation } from "@atcute/did-plc";
import { fromBase16 } from "@atcute/multibase";
import type { InstallationDeletionRequest } from "@humansandmachines/gsv/services/lifecycle";
import type { InstallationDeletionInspection } from "@humansandmachines/gsv/services/lifecycle-discovery";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdsEnv } from "../src/gsv/env";
import { PdsLifecycleEntrypoint } from "../src/gsv/lifecycle";
import { PdsPublisherEntrypoint } from "../src/gsv/publisher";
import { FIREHOSE_NAME } from "../src/host/firehose";
import { FakeAccounts } from "./accounts";
import { FakePlcDirectory, isDidPlc } from "./plc";
import { framesFor, subscribe } from "./relay";
import { deliver, installFakePlc, rejection, upload } from "./support";

const NOTE = "com.example.note";
const SHIP_CALL = { aud: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb#ship", lxm: "space.ship.deliver" };
const DAY_MS = 24 * 60 * 60_000;

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

describe("deleting an installation's public account", () => {
  it.each([["no", null], ["the publishing", "kernel-publish"]])("refuses %s binding authority before reading Accounts", async (_label, authority) => {
    const { installationId } = accounts.add("retained");
    const resolve = vi.spyOn(accounts, "resolveInstallation");
    const owner = lifecycle(authority);
    const request = deletion(installationId);
    const messages = [
      await rejection(owner.quiesceInstallation(request)),
      await rejection(owner.eraseInstallation(request)),
      await rejection(owner.installationDeletionStatus(request)),
      await rejection(owner.inspectInstallationDeletion({ installationId, resources: [] })),
    ];
    for (const message of messages) expect(message).toContain("deletion authority");
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(["active", "restricted"] as const)("refuses to delete an installation Accounts reports %s", async (state) => {
    const { installationId } = accounts.add(state);
    expect(await rejection(lifecycle().quiesceInstallation(deletion(installationId)))).toContain("retired installation");
    expect(await rejection(lifecycle().inspectInstallationDeletion({ installationId, resources: [] }))).toContain("retired installation");
  });

  it("tells relays the account is deleted, then erases its repository, files, host entries and DID", async () => {
    const ship = accounts.add();
    const repository = await publisher().getInstallation(ship.installationId);
    const { did } = await repository.ensureAccount(ship.handle);
    const avatar = await upload(repository, "avatar");
    await repository.applyWrites([{
      action: "put", collection: NOTE, rkey: "self",
      record: { $type: NOTE, text: "hello", createdAt: "2026-10-24T00:00:00.000Z", file: avatar },
    }]);
    await upload(repository, "an upload no record references");
    const repo = env.REPOS.getByName(ship.installationId);
    await deliver(repo);
    const firehose = env.FIREHOSE.getByName(FIREHOSE_NAME);
    const relay = await subscribe(firehose);
    accounts.setState(ship.installationId, "retained");
    const request = deletion(ship.installationId);

    expect(await lifecycle().installationDeletionStatus(request)).toMatchObject({ phase: "pending", pendingResources: 2 });
    expect(await lifecycle().quiesceInstallation(request)).toMatchObject({ phase: "quiesced", outcome: "progress", pendingResources: 2 });
    await vi.waitFor(() => expect(framesFor(relay, did).at(-1)).toMatchObject({ type: "#account", body: { active: false, status: "deleted" } }));
    expect(await firehose.locate(did)).toMatchObject({ active: false, status: "deleted" });
    // Whatever binding the Kernel still holds, the account publishes and signs nothing more.
    const refusals = [
      await rejection(repo.applyWrites([{ action: "delete", collection: NOTE, rkey: "self" }])),
      await rejection(upload(repo, "a late upload")),
      await rejection(repo.serviceAuth(SHIP_CALL)),
    ];
    for (const refusal of refusals) expect(refusal).toContain("RepoDeleted");

    const erased = await lifecycle().eraseInstallation(request);
    expect(erased).toEqual({
      ...request, phase: "live-erased", outcome: "retention-pending", pendingResources: 0, updatedAt: expect.any(Number),
      retainedCopies: [{ id: "pds-durable-object-backup", kind: "backup", expiresAt: erased.updatedAt + 30 * DAY_MS + 60_000 }],
    });
    expect(plc.operations(did).at(-1)).toMatchObject({ type: "plc_tombstone" });
    expect((await env.BLOBS.list({ prefix: `installations/${encodeURIComponent(ship.installationId)}/` })).objects).toEqual([]);
    expect(await firehose.locate(did)).toBeNull();
    expect(await firehose.locate(ship.handle)).toBeNull();
    // Relays replaying the firehose still learn of the deletion, and of nothing the account published.
    expect(await runInDurableObject(firehose, (_instance, state) => state.storage.sql.exec<{ events: number }>(
      "SELECT COUNT(*) AS events FROM events WHERE did = ?", did,
    ).one().events)).toBe(1);
    // The object keeps only its record of the deletion, which refuses another account for the installation.
    expect(await runInDurableObject(repo, async (_instance, state) => ({
      keys: [...(await state.storage.list()).keys()],
      tables: state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()
        .map((table) => table.name).filter((name) => !name.startsWith("_cf_") && !name.startsWith("sqlite_")),
    }))).toEqual({ keys: ["retirement"], tables: [] });
    expect(await repo.account()).toBeNull();
    expect(await rejection(repo.create(ship.handle, `installations/${ship.installationId}/`))).toContain("RepoDeleted");

    // Erasing again changes nothing.
    expect(await lifecycle().eraseInstallation(request)).toEqual(erased);
    expect(plc.operations(did).filter((operation) => operation.type === "plc_tombstone")).toHaveLength(1);
    expect(await rejection(lifecycle().quiesceInstallation({ ...request, operationId: "another-deletion" }))).toContain("immutable");
  });

  it("completes once Cloudflare's backups of the erased storage expire", async () => {
    const { installationId } = accounts.add("retained");
    const request = deletion(installationId);
    await lifecycle().quiesceInstallation(request);
    const erased = await lifecycle().eraseInstallation(request);
    expect(erased).toMatchObject({ phase: "live-erased", outcome: "retention-pending" });
    await runInDurableObject(env.REPOS.getByName(installationId), async (_instance, state) => {
      const retirement = await state.storage.get<{ updatedAt: number }>("retirement");
      await state.storage.put("retirement", { ...retirement, updatedAt: erased.updatedAt - 31 * DAY_MS });
    });
    expect(await lifecycle().installationDeletionStatus(request)).toMatchObject({
      phase: "erased", outcome: "complete", pendingResources: 0, retainedCopies: [],
    });
  });

  it("deletes an installation that never published", async () => {
    const { installationId } = accounts.add("retained");
    const request = deletion(installationId);
    expect(await rejection(lifecycle().eraseInstallation(request))).toContain("quiesce first");
    expect(await lifecycle().quiesceInstallation(request)).toMatchObject({ phase: "quiesced", pendingResources: 0 });
    expect(await lifecycle().eraseInstallation(request)).toMatchObject({ phase: "live-erased", pendingResources: 0 });
  });

  it("keeps erasing until the directory has the DID's tombstone", async () => {
    const ship = accounts.add();
    const { did } = await (await publisher().getInstallation(ship.installationId)).ensureAccount(ship.handle);
    accounts.setState(ship.installationId, "retained");
    const request = deletion(ship.installationId);
    await lifecycle().quiesceInstallation(request);

    // The directory logs the tombstone, but the response never arrives.
    plc.loseNextResponse();
    expect(await rejection(lifecycle().eraseInstallation(request))).toContain("Network connection lost");
    expect(await lifecycle().installationDeletionStatus(request)).toMatchObject({ phase: "erasing", pendingResources: 1 });
    expect(await env.FIREHOSE.getByName(FIREHOSE_NAME).locate(did)).toBeNull();

    expect(await lifecycle().eraseInstallation(request)).toMatchObject({ phase: "live-erased", pendingResources: 0 });
    expect(plc.operations(did).filter((operation) => operation.type === "plc_tombstone")).toHaveLength(1);
  });

  it("leaves a DID whose rotation keys no longer include the host's", async () => {
    const ship = accounts.add();
    const { did } = await (await publisher().getInstallation(ship.installationId)).ensureAccount(ship.handle);
    if (!isDidPlc(did)) throw new Error(`Expected a did:plc, not ${did}`);
    const client = new PlcClient({ serviceUrl: env.PLC_URL });
    const [genesis] = await client.getAuditLog(did);
    if (!genesis || genesis.operation.type !== "plc_operation") throw new Error("Expected the DID's genesis operation");
    const other = await (await Secp256k1PrivateKeyExportable.createKeypair()).exportPublicKey("did");
    const host = await Secp256k1PrivateKey.importRaw(fromBase16(env.PLC_ROTATION_KEY));
    const { sig: _sig, ...state } = genesis.operation;
    await client.submitOperation(did, await signOperation({ ...state, prev: genesis.cid, rotationKeys: [other] }, host));
    accounts.setState(ship.installationId, "retained");
    const request = deletion(ship.installationId);

    await lifecycle().quiesceInstallation(request);
    expect(await lifecycle().eraseInstallation(request)).toMatchObject({ phase: "live-erased", pendingResources: 0 });
    expect(plc.operations(did).map((operation) => operation.type)).toEqual(["plc_operation", "plc_operation"]);
  });

  it("leaves a DID that names another host, though it still lists the host's key", async () => {
    const ship = accounts.add();
    const { did } = await (await publisher().getInstallation(ship.installationId)).ensureAccount(ship.handle);
    if (!isDidPlc(did)) throw new Error(`Expected a did:plc, not ${did}`);
    const client = new PlcClient({ serviceUrl: env.PLC_URL });
    const [genesis] = await client.getAuditLog(did);
    if (!genesis || genesis.operation.type !== "plc_operation") throw new Error("Expected the DID's genesis operation");
    const host = await Secp256k1PrivateKey.importRaw(fromBase16(env.PLC_ROTATION_KEY));
    const { sig: _sig, ...state } = genesis.operation;
    // The identity moved to another host and kept this host's key among its rotation keys.
    const elsewhere = { type: "AtprotoPersonalDataServer", endpoint: "https://pds.elsewhere.test" };
    await client.submitOperation(did, await signOperation({ ...state, prev: genesis.cid, services: { ...state.services, atproto_pds: elsewhere } }, host));
    accounts.setState(ship.installationId, "retained");
    const request = deletion(ship.installationId);

    await lifecycle().quiesceInstallation(request);
    expect(await lifecycle().eraseInstallation(request)).toMatchObject({ phase: "live-erased", pendingResources: 0 });
    expect(plc.operations(did).map((operation) => operation.type)).toEqual(["plc_operation", "plc_operation"]);
  });

  it("finds each installation's repository, and the host's entries for it, for deletion discovery", async () => {
    const ship = accounts.add();
    const other = accounts.add();
    const unused = accounts.add("retained");
    for (const { installationId, handle } of [ship, other]) {
      await (await publisher().getInstallation(installationId)).ensureAccount(handle);
      await deliver(env.REPOS.getByName(installationId));
    }
    accounts.setState(ship.installationId, "retained");
    const host = { kind: "pds-host", objectId: env.FIREHOSE.idFromName(FIREHOSE_NAME).toString() } as const;
    const repository = (installationId: string) => ({ kind: "pds-repository", objectId: env.REPOS.idFromName(installationId).toString() }) as const;
    const inspect = async (resources: InstallationDeletionInspection["resources"]) =>
      (await lifecycle().inspectInstallationDeletion({ installationId: ship.installationId, resources })).observations;

    expect(await inspect([repository(ship.installationId), repository(other.installationId), repository(unused.installationId), host])).toEqual([
      { ...repository(ship.installationId), name: ship.installationId, outcome: "identified", installationId: ship.installationId },
      { ...repository(other.installationId), name: other.installationId, outcome: "identified", installationId: other.installationId },
      { ...repository(unused.installationId), outcome: "empty" },
      { ...host, name: FIREHOSE_NAME, outcome: "identified", installationId: ship.installationId },
    ]);

    const request = deletion(ship.installationId);
    await lifecycle().quiesceInstallation(request);
    await lifecycle().eraseInstallation(request);
    expect(await inspect([repository(ship.installationId), host])).toEqual([
      { ...repository(ship.installationId), outcome: "empty" },
      { ...host, name: FIREHOSE_NAME, outcome: "unrelated" },
    ]);
    // An object the host does not hold is never guessed at.
    const elsewhere = { kind: "pds-host", objectId: env.FIREHOSE.idFromName("elsewhere").toString() } as const;
    expect(await inspect([elsewhere])).toEqual([{ ...elsewhere, outcome: "unidentified" }]);
    expect(await rejection(lifecycle().inspectInstallationDeletion({
      installationId: ship.installationId, resources: [{ kind: "kernel", objectId: "a".repeat(64) }],
    }))).toContain("not owned by the PDS");
  });
});

function deletion(installationId: string): InstallationDeletionRequest {
  return { version: 1, operationId: `deletion-${crypto.randomUUID()}`, installationId };
}

/** The deletion entrypoint as Accounts' binding, with the given authority or with no props, sees it. */
function lifecycle(authority: string | null = "installation-deletion"): PdsLifecycleEntrypoint {
  return bound(PdsLifecycleEntrypoint, authority);
}

function publisher(): PdsPublisherEntrypoint {
  return bound(PdsPublisherEntrypoint, "kernel-publish");
}

function bound<T>(Entrypoint: new (ctx: never, env: never) => T, authority: string | null): T {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "props", { value: authority === null ? undefined : { authority } });
  // SAFETY: The entrypoints read only their binding props and the host's bindings.
  return new Entrypoint(ctx as never, deployedEnv() as never);
}

function deployedEnv(): PdsEnv {
  return { ...env, INSTALLATION_DIRECTORY: accounts };
}
