import { createExecutionContext, listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { CID } from "@atproto/lex-data";
import { verifyProofs, verifyRepoCar } from "@atproto/repo";
import type { JsonObject } from "@humansandmachines/gsv/protocol";
import type { ModerationSubject, PublicRecordWrite, PublicRepository } from "@humansandmachines/gsv/services/pds";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { PdsEnv } from "../src/gsv/env";
import { PdsModerationEntrypoint } from "../src/gsv/moderation";
import { PdsPublisherEntrypoint } from "../src/gsv/publisher";
import { FIREHOSE_NAME } from "../src/host/firehose";
import { HostedRepo } from "../src/host/repo";
import worker from "../src/index";
import { FakeAccounts } from "./accounts";
import { FakePlcDirectory } from "./plc";
import { framesFor, subscribe } from "./relay";
import { deliver, errorOf, installFakePlc, read, rejection, upload } from "./support";

const NOTE = "space.ship.note";
const CREATED_AT = "2026-10-25T00:00:00.000Z";

const repoStatus = z.object({ did: z.string(), active: z.boolean(), status: z.string().optional(), rev: z.string().optional() });
const record = z.object({ uri: z.string(), cid: z.string(), value: z.looseObject({ text: z.string() }) });
const recordPage = z.object({ records: z.array(record), cursor: z.string().optional() });
const repoListing = z.object({ repos: z.array(z.looseObject({ did: z.string(), active: z.boolean(), status: z.string().optional() })) });
const blobListing = z.object({ cids: z.array(z.string()) });

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

describe("moderating for an operator", () => {
  it.each([["no", null], ["an empty", ""], ["the publishing", "kernel-publish"], ["the deletion", "installation-deletion"]])(
    "refuses %s binding authority before reading Accounts",
    async (_label, authority) => {
      const { installationId } = accounts.add();
      const resolve = vi.spyOn(accounts, "resolveInstallation");
      expect(await rejection(moderation(authority).getRepository(installationId))).toContain("moderation authority");
      expect(await rejection(moderation(authority).updateSubjectStatus(installationId, {
        subject: { $type: "com.atproto.admin.defs#repoRef", did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" }, takedown: { applied: true },
      }))).toContain("moderation authority");
      expect(await rejection(moderation(authority).getSubjectStatus(installationId, { did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" })))
        .toContain("moderation authority");
      expect(await rejection(moderation(authority).locateRepository("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"))).toContain("moderation authority");
      expect(await rejection(moderation(authority).reconcileAccountStatus(installationId))).toContain("moderation authority");
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it("refuses an installation Accounts doesn't know without addressing a repository, and names nothing before an account exists", async () => {
    const before = await listDurableObjectIds(env.REPOS);
    expect(await rejection(moderation().getRepository(`inst_${crypto.randomUUID()}`))).toContain("Unknown installation");
    expect(await rejection(moderation().reconcileAccountStatus(`inst_${crypto.randomUUID()}`))).toContain("Unknown installation");
    expect(await listDurableObjectIds(env.REPOS)).toHaveLength(before.length);

    const { installationId } = accounts.add();
    expect(await moderation().getRepository(installationId)).toBeNull();
    expect(await moderation().getSubjectStatus(installationId, { did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" })).toBeNull();
  });

  it("refuses a subject of another account, and names a takedown without a reference by its time, as Bluesky's PDS does", async () => {
    const ship = await publishedShip();
    const other = await publishedShip();
    for (const subject of [
      { $type: "com.atproto.admin.defs#repoRef", did: other.did },
      { $type: "com.atproto.repo.strongRef", uri: other.noteUri, cid: other.noteCid },
      { $type: "com.atproto.repo.strongRef", uri: `at://${ship.handle}/${NOTE}/first`, cid: ship.noteCid },
      { $type: "com.atproto.admin.defs#repoBlobRef", did: other.did, cid: ship.blobCid },
    ] satisfies ModerationSubject[]) {
      expect(await rejection(moderation().updateSubjectStatus(ship.installationId, { subject, takedown: { applied: true, ref: "audit_1" } })))
        .toContain("InvalidRequest");
    }
    expect(await ship.repository.takedowns()).toEqual([]);
    const subject = { $type: "com.atproto.admin.defs#repoRef", did: ship.did } as const;
    const { takedown } = await moderation().updateSubjectStatus(ship.installationId, { subject, takedown: { applied: true } });
    expect(new Date(takedown.ref ?? "").toISOString()).toBe(takedown.ref);
    expect(await ship.repository.takedowns()).toEqual([{ subject, ref: takedown.ref, reason: null, at: expect.any(Number) }]);
  });
});

describe("finding an account by its DID", () => {
  it("names the installation that holds it and what is taken down, and nothing for a DID hosted elsewhere", async () => {
    const ship = await publishedShip();
    const { did, installationId, handle } = ship;
    expect(await moderation().locateRepository(did)).toEqual({ installationId, did, handle, takedowns: [] });

    const subject = { $type: "com.atproto.admin.defs#repoRef", did } as const;
    await moderation().updateSubjectStatus(installationId, { subject, takedown: { applied: true, ref: "audit_found" }, reason: "Spam" });
    expect(await moderation().locateRepository(did)).toEqual({
      installationId, did, handle, takedowns: [{ subject, ref: "audit_found", reason: "Spam", at: expect.any(Number) }],
    });

    expect(await moderation().locateRepository("did:plc:cccccccccccccccccccccccc")).toBeNull();
    expect(await rejection(moderation().locateRepository(handle))).toContain("Invalid DID");
  });

  it("refuses a DID whose installation Accounts doesn't know", async () => {
    const ship = await publishedShip();
    const resolve = vi.spyOn(accounts, "resolveInstallation").mockResolvedValue({ found: false });
    expect(await rejection(moderation().locateRepository(ship.did))).toContain("Unknown installation");
    expect(resolve).toHaveBeenCalledWith(ship.installationId);
  });
});

describe("taking down an account", () => {
  it("answers every repository read with RepoTakendown and tells relays, until the same call restores it", async () => {
    const ship = await publishedShip();
    const { did, installationId, repository } = ship;
    const live = await subscribe(env.FIREHOSE.getByName(FIREHOSE_NAME));
    const subject = { $type: "com.atproto.admin.defs#repoRef", did } as const;
    const reads = (): Array<[string, Record<string, string>]> => [
      ["com.atproto.repo.describeRepo", { repo: did }],
      ["com.atproto.repo.getRecord", { repo: did, collection: NOTE, rkey: "first" }],
      ["com.atproto.repo.listRecords", { repo: ship.handle, collection: NOTE }],
      ["com.atproto.sync.getRepo", { did }],
      ["com.atproto.sync.getRecord", { did, collection: NOTE, rkey: "first" }],
      ["com.atproto.sync.getLatestCommit", { did }],
      ["com.atproto.sync.getBlob", { did, cid: ship.blobCid }],
      ["com.atproto.sync.listBlobs", { did }],
    ];

    expect(await moderation().updateSubjectStatus(installationId, { subject, takedown: { applied: true, ref: "audit_account" }, reason: "Impersonation" }))
      .toEqual({ subject, takedown: { applied: true, ref: "audit_account" } });
    await deliver(ship.repo);
    for (const [method, params] of reads()) expect(await errorOf(serve(method, params)), method).toBe("RepoTakendown");
    const rev = (await read(repoStatus, serve("com.atproto.sync.getRepoStatus", { did }))).rev;
    expect(await read(repoStatus, serve("com.atproto.sync.getRepoStatus", { did }))).toEqual({ did, active: false, status: "takendown", rev });
    await vi.waitFor(() => expect(framesFor(live, did)).toMatchObject([{ type: "#account", body: { active: false, status: "takendown" } }]));
    expect((await read(repoListing, serve("com.atproto.sync.listRepos", {}))).repos)
      .toContainEqual(expect.objectContaining({ did, active: false, status: "takendown" }));

    // The account publishes and signs nothing, and asking for it again does not bring it back.
    const takendown = { did, handle: ship.handle, host: env.PDS_ORIGIN, status: "takendown" };
    expect(await repository.account()).toEqual(takendown);
    expect(await repository.ensureAccount(ship.handle)).toEqual(takendown);
    expect(await rejection(repository.applyWrites([note("second")]))).toContain("RepoTakendown");
    // The Kernel knows the refusal by this prefix, and fails what it was sending at once.
    expect(await rejection(repository.serviceAuth({ aud: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb#ship", lxm: "space.ship.deliver" }))).toMatch(/^RepoTakendown: /);
    expect(await rejection(upload(repository, "another file"))).toContain("RepoTakendown");
    expect(await errorOf(serve("com.atproto.repo.describeRepo", { repo: did }))).toBe("RepoTakendown");

    // The person and the operator see what was taken down and why.
    const takedown = { subject, ref: "audit_account", reason: "Impersonation", at: expect.any(Number) };
    expect(await repository.takedowns()).toEqual([takedown]);
    expect(await moderation().getRepository(installationId)).toEqual({ did, handle: ship.handle, takedowns: [takedown] });
    expect(await moderation().getSubjectStatus(installationId, { did })).toEqual({ subject, takedown: { applied: true, ref: "audit_account" } });

    expect(await moderation().updateSubjectStatus(installationId, { subject, takedown: { applied: false } }))
      .toEqual({ subject, takedown: { applied: false } });
    await deliver(ship.repo);
    for (const [method, params] of reads()) expect((await serve(method, params)).ok, method).toBe(true);
    expect(await read(repoStatus, serve("com.atproto.sync.getRepoStatus", { did }))).toEqual({ did, active: true, rev });
    await vi.waitFor(() => expect(framesFor(live, did)).toMatchObject([
      { type: "#account", body: { active: false, status: "takendown" } },
      { type: "#account", body: { active: true } },
      { type: "#identity", body: { did } },
      { type: "#sync", body: { rev } },
    ]));
    expect(await repository.account()).toEqual({ did, handle: ship.handle, host: env.PDS_ORIGIN });
    expect(await repository.takedowns()).toEqual([]);
    expect(await moderation().getSubjectStatus(installationId, { did })).toEqual({ subject, takedown: { applied: false } });
    expect((await repository.applyWrites([note("second")])).results).toHaveLength(1);
  });
});

describe("suspending an installation's account", () => {
  it("tells relays when Accounts restricts the installation and again when it reactivates it, as listRepos and getRepoStatus report", async () => {
    const ship = await publishedShip();
    const { did, installationId, repository } = ship;
    const live = await subscribe(env.FIREHOSE.getByName(FIREHOSE_NAME));
    const rev = (await read(repoStatus, serve("com.atproto.sync.getRepoStatus", { did }))).rev;

    accounts.setState(installationId, "restricted");
    await moderation().reconcileAccountStatus(installationId);
    // Asking again changes nothing.
    await moderation().reconcileAccountStatus(installationId);
    await deliver(ship.repo);
    expect(await read(repoStatus, serve("com.atproto.sync.getRepoStatus", { did }))).toEqual({ did, active: false, status: "suspended" });
    expect(await listed(did)).toMatchObject({ did, active: false, status: "suspended" });
    expect(await errorOf(serve("com.atproto.repo.describeRepo", { repo: did }))).toBe("RepoSuspended");
    await vi.waitFor(() => expect(framesFor(live, did)).toMatchObject([{ type: "#account", body: { active: false, status: "suspended" } }]));

    accounts.setState(installationId, "active");
    await moderation().reconcileAccountStatus(installationId);
    await deliver(ship.repo);
    expect(await read(repoStatus, serve("com.atproto.sync.getRepoStatus", { did }))).toEqual({ did, active: true, rev });
    expect(await listed(did)).toEqual({ did, head: expect.any(String), rev, active: true });
    // A relay that dropped the account's events while it was suspended fetches the repository again from its head.
    await vi.waitFor(() => expect(framesFor(live, did)).toMatchObject([
      { type: "#account", body: { active: false, status: "suspended" } },
      { type: "#account", body: { active: true } },
      { type: "#identity", body: { did } },
      { type: "#sync", body: { rev } },
    ]));
    expect((await repository.applyWrites([note("second")])).results).toHaveLength(1);
  });

  it("keeps a taken-down account down while it is suspended, and reports the suspension once the takedown is lifted", async () => {
    const ship = await publishedShip();
    const { did, installationId } = ship;
    const live = await subscribe(env.FIREHOSE.getByName(FIREHOSE_NAME));
    const subject = { $type: "com.atproto.admin.defs#repoRef", did } as const;
    await moderation().updateSubjectStatus(installationId, { subject, takedown: { applied: true, ref: "audit_down" } });
    accounts.setState(installationId, "restricted");
    await moderation().reconcileAccountStatus(installationId);
    await deliver(ship.repo);
    expect(await listed(did)).toMatchObject({ active: false, status: "takendown" });

    await moderation().updateSubjectStatus(installationId, { subject, takedown: { applied: false } });
    await deliver(ship.repo);
    expect(await listed(did)).toMatchObject({ active: false, status: "suspended" });
    expect(await ship.repository.takedowns()).toEqual([]);

    accounts.setState(installationId, "active");
    await moderation().reconcileAccountStatus(installationId);
    await deliver(ship.repo);
    expect(await listed(did)).toMatchObject({ active: true });
    await vi.waitFor(() => expect(framesFor(live, did).map((frame) => frame.type === "#account" ? frame.body.status ?? "active" : frame.type))
      .toEqual(["takendown", "suspended", "active", "#identity", "#sync"]));
  });

  it("creates a restricted installation's account suspended, and announces it once Accounts reactivates the installation", async () => {
    const ship = accounts.add("restricted");
    const live = await subscribe(env.FIREHOSE.getByName(FIREHOSE_NAME));
    const { did } = await (await publisher().getInstallation(ship.installationId)).ensureAccount(ship.handle);
    const repo = env.REPOS.getByName(ship.installationId);
    await deliver(repo);
    expect(await listed(did)).toMatchObject({ did, active: false, status: "suspended" });
    expect(await read(repoStatus, serve("com.atproto.sync.getRepoStatus", { did }))).toEqual({ did, active: false, status: "suspended" });

    accounts.setState(ship.installationId, "active");
    await moderation().reconcileAccountStatus(ship.installationId);
    await deliver(repo);
    expect(await read(repoStatus, serve("com.atproto.sync.getRepoStatus", { did }))).toMatchObject({ did, active: true });
    await vi.waitFor(() => expect(framesFor(live, did).map((frame) => frame.type === "#account" ? frame.body.status ?? "active" : frame.type))
      .toEqual(["suspended", "active", "#identity", "#sync"]));
  });

  it("suspends an account whose installation Accounts restricts while the account is being created", async () => {
    const ship = accounts.add();
    const create = HostedRepo.prototype.create;
    // Accounts restricts the installation after the publisher reads its state, before the account exists to follow it.
    vi.spyOn(HostedRepo.prototype, "create").mockImplementationOnce(async function (this: HostedRepo, ...args: Parameters<HostedRepo["create"]>) {
      accounts.setState(ship.installationId, "restricted");
      return await create.apply(this, args);
    });
    const { did } = await (await publisher().getInstallation(ship.installationId)).ensureAccount(ship.handle);
    await deliver(env.REPOS.getByName(ship.installationId));
    expect(await listed(did)).toMatchObject({ did, active: false, status: "suspended" });
  });

  it("follows a change Accounts makes while the account follows the one before it, and gives up while the state keeps changing", async () => {
    const ship = await publishedShip();
    const { did, installationId } = ship;
    accounts.setState(installationId, "restricted");
    const follow = HostedRepo.prototype.setSuspended;
    // Accounts reactivates the installation while the host suspends its account.
    vi.spyOn(HostedRepo.prototype, "setSuspended").mockImplementationOnce(async function (this: HostedRepo, suspended: boolean) {
      await follow.call(this, suspended);
      accounts.setState(installationId, "active");
    });
    await moderation().reconcileAccountStatus(installationId);
    await deliver(ship.repo);
    expect(await listed(did)).toMatchObject({ did, active: true });

    const known = await accounts.resolveInstallation(installationId);
    let answers = 0;
    vi.spyOn(accounts, "resolveInstallation").mockImplementation(async () => ({ ...known, state: answers++ % 2 ? "active" : "restricted" }));
    expect(await rejection(moderation().reconcileAccountStatus(installationId))).toContain("kept changing");
  });
});

describe("retiring an installation's account", () => {
  it("reads as deleted from its own repository once Accounts retires the installation, leaving relays to hear of it from the deletion", async () => {
    const ship = await publishedShip();
    const { did, installationId } = ship;
    const live = await subscribe(env.FIREHOSE.getByName(FIREHOSE_NAME));
    accounts.setState(installationId, "retained");
    await moderation().reconcileAccountStatus(installationId);
    // Asking again changes nothing.
    await moderation().reconcileAccountStatus(installationId);
    await deliver(ship.repo);

    expect(await read(repoStatus, direct(ship.repo, "com.atproto.sync.getRepoStatus", { did }))).toEqual({ did, active: false, status: "deleted" });
    const reads: Array<[string, Record<string, string>]> = [
      ["com.atproto.repo.describeRepo", { repo: did }],
      ["com.atproto.repo.getRecord", { repo: ship.handle, collection: NOTE, rkey: "first" }],
      ["com.atproto.sync.getRepo", { did }],
      ["com.atproto.sync.getBlob", { did, cid: ship.blobCid }],
    ];
    for (const [method, params] of reads) expect(await errorOf(direct(ship.repo, method, params))).toBe("RepoNotFound");
    expect(await listed(did)).toMatchObject({ did, active: true });
    expect(framesFor(live, did)).toEqual([]);
  });

  it("leaves an installation's object empty when Accounts retires it before it publishes", async () => {
    const { installationId } = accounts.add("retained");
    await moderation().reconcileAccountStatus(installationId);
    expect(await runInDurableObject(env.REPOS.getByName(installationId), async (_instance, state) => [...(await state.storage.list()).keys()]))
      .toEqual([]);
  });
});

describe("taking down a record", () => {
  it("hides it from getRecord and listRecords, as Bluesky's PDS does, while the signed repository still carries it", async () => {
    const ship = await publishedShip();
    const { did, installationId } = ship;
    await ship.repository.applyWrites([note("kept")]);
    const subject = { $type: "com.atproto.repo.strongRef", uri: ship.noteUri, cid: ship.noteCid } as const;

    expect(await moderation().updateSubjectStatus(installationId, { subject, takedown: { applied: true, ref: "audit_record" }, reason: "Harassment" }))
      .toEqual({ subject, takedown: { applied: true, ref: "audit_record" } });
    expect(await errorOf(serve("com.atproto.repo.getRecord", { repo: did, collection: NOTE, rkey: "first" }))).toBe("RecordNotFound");
    expect(await errorOf(serve("com.atproto.repo.getRecord", { repo: ship.handle, collection: NOTE, rkey: "first", cid: ship.noteCid })))
      .toBe("RecordNotFound");
    expect((await read(recordPage, serve("com.atproto.repo.listRecords", { repo: did, collection: NOTE }))).records.map((entry) => entry.uri))
      .toEqual([`at://${did}/${NOTE}/kept`]);
    expect((await read(record, serve("com.atproto.repo.getRecord", { repo: did, collection: NOTE, rkey: "kept" }))).value.text).toBe("kept");
    // The repository is signed as it is, so relays still verify every record in it.
    const didKey = await signingDidKey(did);
    const proof = await serve("com.atproto.sync.getRecord", { did, collection: NOTE, rkey: "first" });
    expect((await verifyProofs(new Uint8Array(await proof.arrayBuffer()), [{ collection: NOTE, rkey: "first", cid: CID.parse(ship.noteCid) }], did, didKey)).verified)
      .toHaveLength(1);
    const exported = await serve("com.atproto.sync.getRepo", { did });
    expect((await verifyRepoCar(new Uint8Array(await exported.arrayBuffer()), did, didKey)).creates).toHaveLength(2);
    expect(await read(repoStatus, serve("com.atproto.sync.getRepoStatus", { did }))).toMatchObject({ did, active: true });

    expect(await ship.repository.takedowns()).toEqual([{ subject, ref: "audit_record", reason: "Harassment", at: expect.any(Number) }]);
    expect(await moderation().getSubjectStatus(installationId, { uri: ship.noteUri }))
      .toEqual({ subject, takedown: { applied: true, ref: "audit_record" } });
    expect(await moderation().getSubjectStatus(installationId, { uri: `at://${did}/${NOTE}/kept` })).toEqual({
      subject: { $type: "com.atproto.repo.strongRef", uri: `at://${did}/${NOTE}/kept`, cid: expect.any(String) }, takedown: { applied: false },
    });

    await moderation().updateSubjectStatus(installationId, { subject, takedown: { applied: false } });
    expect((await read(record, serve("com.atproto.repo.getRecord", { repo: did, collection: NOTE, rkey: "first" }))).cid).toBe(ship.noteCid);
    expect(await ship.repository.takedowns()).toEqual([]);
  });

  it("stays with the record's URI when its owner edits, deletes or writes it again, until it is restored", async () => {
    const ship = await publishedShip();
    const { did, installationId, repository } = ship;
    const subject = { $type: "com.atproto.repo.strongRef", uri: ship.noteUri, cid: ship.noteCid } as const;
    await moderation().updateSubjectStatus(installationId, { subject, takedown: { applied: true, ref: "audit_record" }, reason: "Spam" });
    const hidden = async () => await errorOf(serve("com.atproto.repo.getRecord", { repo: did, collection: NOTE, rkey: "first" }));

    const edited = await repository.applyWrites([note("first", "edited")]);
    expect(await hidden()).toBe("RecordNotFound");
    expect(await moderation().getSubjectStatus(installationId, { uri: ship.noteUri })).toEqual({
      subject: { ...subject, cid: edited.results[0]?.cid }, takedown: { applied: true, ref: "audit_record" },
    });
    await repository.applyWrites([{ action: "delete", collection: NOTE, rkey: "first" }]);
    expect(await moderation().getSubjectStatus(installationId, { uri: ship.noteUri })).toEqual({ subject, takedown: { applied: true, ref: "audit_record" } });
    await repository.applyWrites([note("first", "written again")]);
    expect(await hidden()).toBe("RecordNotFound");
    expect(await repository.takedowns()).toEqual([expect.objectContaining({ subject, ref: "audit_record" })]);

    await moderation().updateSubjectStatus(installationId, { subject, takedown: { applied: false } });
    expect((await read(record, serve("com.atproto.repo.getRecord", { repo: did, collection: NOTE, rkey: "first" }))).value.text).toBe("written again");
  });

  it("refuses to take down a record the repository doesn't hold, and restoring one never taken down changes nothing", async () => {
    const ship = await publishedShip();
    const missing = { $type: "com.atproto.repo.strongRef", uri: `at://${ship.did}/${NOTE}/missing`, cid: ship.noteCid } as const;
    expect(await rejection(moderation().updateSubjectStatus(ship.installationId, { subject: missing, takedown: { applied: true, ref: "audit_missing" } })))
      .toContain("RecordNotFound");
    expect(await moderation().getSubjectStatus(ship.installationId, { uri: missing.uri })).toBeNull();
    expect(await moderation().updateSubjectStatus(ship.installationId, { subject: missing, takedown: { applied: false } }))
      .toEqual({ subject: missing, takedown: { applied: false } });
    expect(await ship.repository.takedowns()).toEqual([]);
  });
});

describe("taking down a blob", () => {
  it("stops serving it while its record still names it, until the same call restores it", async () => {
    const ship = await publishedShip();
    const { did, installationId } = ship;
    const subject = { $type: "com.atproto.admin.defs#repoBlobRef", did, cid: ship.blobCid, recordUri: ship.noteUri } as const;

    expect(await moderation().updateSubjectStatus(installationId, { subject, takedown: { applied: true, ref: "audit_blob" }, reason: "Copyright" }))
      .toEqual({ subject, takedown: { applied: true, ref: "audit_blob" } });
    expect(await errorOf(serve("com.atproto.sync.getBlob", { did, cid: ship.blobCid }))).toBe("BlobNotFound");
    // As in Bluesky's PDS, the listing still names the blob, and the record still references it.
    expect((await read(blobListing, serve("com.atproto.sync.listBlobs", { did }))).cids).toEqual([ship.blobCid]);
    expect((await read(record, serve("com.atproto.repo.getRecord", { repo: did, collection: NOTE, rkey: "first" }))).cid).toBe(ship.noteCid);
    // Its owner can still read it back.
    const own = await ship.repository.readBlob(ship.blobCid);
    expect(own && await new Response(own.body).text()).toBe("attached file");
    expect(await ship.repository.takedowns()).toEqual([{ subject, ref: "audit_blob", reason: "Copyright", at: expect.any(Number) }]);
    expect(await moderation().getSubjectStatus(installationId, { did, blob: ship.blobCid }))
      .toEqual({ subject, takedown: { applied: true, ref: "audit_blob" } });
    expect(await rejection(moderation().getSubjectStatus(installationId, { blob: ship.blobCid }))).toContain("did");

    await moderation().updateSubjectStatus(installationId, { subject, takedown: { applied: false } });
    expect(await (await serve("com.atproto.sync.getBlob", { did, cid: ship.blobCid })).text()).toBe("attached file");
    expect(await moderation().getSubjectStatus(installationId, { did, blob: ship.blobCid })).toEqual({
      subject: { $type: "com.atproto.admin.defs#repoBlobRef", did, cid: ship.blobCid }, takedown: { applied: false },
    });
  });
});

/** An active installation whose repository holds one note with an attached file, delivered to the host firehose. */
async function publishedShip() {
  const ship = accounts.add();
  const repository: PublicRepository = await publisher().getInstallation(ship.installationId);
  const { did } = await repository.ensureAccount(ship.handle);
  const blob = await upload(repository, "attached file");
  const commit = await repository.applyWrites([note("first", "first", { file: blob })]);
  const repo = env.REPOS.getByName(ship.installationId);
  await deliver(repo);
  return {
    ...ship, did, repository, repo,
    noteUri: `at://${did}/${NOTE}/first`, noteCid: commit.results[0]?.cid ?? "", blobCid: blob.ref.$link,
  };
}

async function signingDidKey(did: string): Promise<string> {
  const description = await read(z.object({ didDoc: z.looseObject({ verificationMethod: z.array(z.looseObject({ publicKeyMultibase: z.string() })) }) }),
    serve("com.atproto.repo.describeRepo", { repo: did }));
  const method = description.didDoc.verificationMethod[0];
  if (!method) throw new Error("The repository publishes no signing key");
  return `did:key:${method.publicKeyMultibase}`;
}

function note(rkey: string, text = rkey, fields: JsonObject = {}): PublicRecordWrite {
  return { action: "put", collection: NOTE, rkey, record: { $type: NOTE, text, createdAt: CREATED_AT, ...fields } };
}

/** The moderation entrypoint as a binding with the given authority, or with no props at all, sees it. */
function moderation(authority: string | null = "operator-moderation"): PdsModerationEntrypoint {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "props", { value: authority === null ? undefined : { authority } });
  // SAFETY: The entrypoint reads only its binding props and the host's bindings.
  return new PdsModerationEntrypoint(ctx as never, deployedEnv() as never);
}

function publisher(): PdsPublisherEntrypoint {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "props", { value: { authority: "kernel-publish" } });
  // SAFETY: The entrypoint reads only its binding props and the host's bindings.
  return new PdsPublisherEntrypoint(ctx as never, deployedEnv() as never);
}

/** Sends a public XRPC query to the deployed worker. */
function serve(method: string, params: Record<string, string>): Promise<Response> {
  const request = new Request<unknown, IncomingRequestCfProperties>(`https://pds.test/xrpc/${method}?${new URLSearchParams(params)}`);
  return worker.fetch(request, deployedEnv());
}

/** Sends a public XRPC query straight to the object holding a repository, as the host's front door forwards it. */
function direct(repo: DurableObjectStub<HostedRepo>, method: string, params: Record<string, string>): Promise<Response> {
  return repo.fetch(`https://pds.test/xrpc/${method}?${new URLSearchParams(params)}`);
}

/** The host's listRepos entry for a DID. */
async function listed(did: string) {
  return (await read(repoListing, serve("com.atproto.sync.listRepos", {}))).repos.find((repo) => repo.did === did);
}

function deployedEnv(): PdsEnv {
  return { ...env, INSTALLATION_DIRECTORY: accounts };
}
