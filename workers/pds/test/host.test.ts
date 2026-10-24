import { listDurableObjectIds, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { CODEC_RAW, create as createCid, fromDigest, toString as formatCid } from "@atcute/cid";
import { Secp256k1PrivateKey, Secp256k1PrivateKeyExportable, verifySigWithDidKey } from "@atcute/crypto";
import { fromBase16, fromBase64Url, toBase64Url } from "@atcute/multibase";
import { CID } from "@atproto/lex-data";
import { verifyProofs, verifyRepoCar } from "@atproto/repo";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { encode } from "../src/cirrus/cbor-compat";
import { BlobStore, type BlobRef } from "../src/cirrus/repo/blobs";
import { Sequencer } from "../src/cirrus/repo/sequencer";
import { FIREHOSE_NAME, HostFirehose, type OutboxEvent, type RepoState } from "../src/host/firehose";
import { mintIdentity, registerGenesis } from "../src/host/identity";
import { HostedRepo, MAX_BLOB_BYTES, type LexObject, type RepoWrite } from "../src/host/repo";
import { handleXrpc, type Admission } from "../src/host/xrpc";
import { FakePlcDirectory } from "./plc";
import { framesFor, subscribe, verifyCommit, type Frame } from "./relay";
import { byteStream, deliver, errorOf, installFakePlc, read, rejection, upload } from "./support";

const NOTE = "space.ship.note";

const describedRepo = z.object({
  did: z.string(),
  handle: z.string(),
  didDoc: z.looseObject({ verificationMethod: z.array(z.looseObject({ publicKeyMultibase: z.string() })) }),
  collections: z.array(z.string()),
});
const recordPage = z.object({
  records: z.array(z.object({ uri: z.string(), cid: z.string(), value: z.object({ text: z.string() }) })),
  cursor: z.string().optional(),
});
const latestCommit = z.object({ cid: z.string(), rev: z.string() });

let plc: FakePlcDirectory;

beforeEach(() => {
  plc = new FakePlcDirectory();
  installFakePlc(plc, env.PLC_URL);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hosted repository", () => {
  it("creates a did:plc that names this host and announces the account once", async () => {
    const live = await subscribe(hostFirehose());
    const { name, handle, repo, account } = await createAccount();
    expect(account).toEqual({ did: expect.stringMatching(/^did:plc:[a-z2-7]{24}$/), handle });
    expect(await repo.create(handle.toUpperCase(), blobPrefix(name))).toEqual(account);
    expect(await rejection(repo.create(`other.${handle}`, blobPrefix(name)))).toContain("RepoConflict");

    await deliver(repo);
    const description = await read(describedRepo, xrpc("com.atproto.repo.describeRepo", { repo: handle }));
    expect(plc.operations(account.did)).toEqual([expect.objectContaining({
      type: "plc_operation",
      prev: null,
      rotationKeys: [await hostRotationKey()],
      verificationMethods: { atproto: await signingDidKey(account.did) },
      alsoKnownAs: [`at://${handle}`],
      services: { atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: env.PDS_ORIGIN } },
    })]);
    const resolved = await fetch(`${env.PLC_URL}/${account.did}`);
    expect(description.didDoc).toEqual(await resolved.json());

    const state = await repo.state();
    await vi.waitFor(() => expect(framesFor(live, account.did)).toHaveLength(3));
    expect(framesFor(live, account.did)).toMatchObject([
      { type: "#account", body: { active: true } },
      // Consumers resolve the handle from the DID document; the event only says to.
      { type: "#identity", body: { did: account.did } },
      { type: "#sync", body: { rev: state?.rev } },
    ]);
    expect(await hostFirehose().locate(handle.toUpperCase())).toEqual({ ...state, name });
  });

  it("ranks a configured recovery key above the host's rotation key", async () => {
    const recovery = await (await Secp256k1PrivateKeyExportable.createKeypair()).exportPublicKey("did");
    const identity = await mintIdentity({ ...env, PLC_RECOVERY_KEY: recovery }, "recovered.ship.test");
    expect(identity.genesis.rotationKeys).toEqual([recovery, await hostRotationKey()]);
    await registerGenesis(env, identity);
    expect(plc.operations(identity.did)).toEqual([identity.genesis]);

    const unprefixed = recovery.slice("did:key:".length);
    await expect(mintIdentity({ ...env, PLC_RECOVERY_KEY: unprefixed }, "bad.ship.test")).rejects.toThrow("PLC_RECOVERY_KEY");
  });

  it("names the other services an account offers in its DID document", async () => {
    const name = crypto.randomUUID();
    const handle = `${name}.ship.test`;
    const repo = env.REPOS.getByName(name);
    const ship = { type: "ShipService", endpoint: `https://${handle}` };
    const account = await repo.create(handle, blobPrefix(name), { ship });
    expect(plc.operations(account.did)).toEqual([expect.objectContaining({
      services: { atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: env.PDS_ORIGIN }, ship },
    })]);

    await deliver(repo);
    const description = await read(describedRepo, xrpc("com.atproto.repo.describeRepo", { repo: handle }));
    expect(description.didDoc).toEqual(await (await fetch(`${env.PLC_URL}/${account.did}`)).json());
    expect(description.didDoc).toMatchObject({ service: [
      { id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: env.PDS_ORIGIN },
      { id: "#ship", type: "ShipService", serviceEndpoint: `https://${handle}` },
    ] });
  });

  it("signs service-auth tokens that the account's published key verifies, each with its own nonce", async () => {
    const { repo, account } = await hostAccount();
    const request = { aud: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb#ship", lxm: "space.ship.deliver" };
    const issuedFrom = Math.floor(Date.now() / 1000);
    const first = decodeToken(await repo.serviceAuth(request));
    const second = decodeToken(await repo.serviceAuth(request));

    expect(first.header).toEqual({ typ: "JWT", alg: "ES256K" });
    expect(first.payload).toEqual({ iss: account.did, ...request, iat: expect.any(Number), exp: expect.any(Number), jti: expect.any(String) });
    expect(first.payload.iat).toBeGreaterThanOrEqual(issuedFrom);
    expect(first.payload.exp).toBe(Number(first.payload.iat) + 60);
    expect(second.payload.jti).not.toBe(first.payload.jti);
    const key = await signingDidKey(account.did);
    expect(await verifySigWithDidKey(key, first.signature, first.signed, { jwtAlg: "ES256K" })).toBe(true);
    // The signature covers the claims: naming another audience breaks it.
    const redirected = `${first.parts[0]}.${toBase64Url(utf8(JSON.stringify({ ...first.payload, aud: "did:plc:cccccccccccccccccccccccc#ship" })))}`;
    expect(await verifySigWithDidKey(key, first.signature, utf8(redirected), { jwtAlg: "ES256K" })).toBe(false);

    for (const invalid of [{ ...request, aud: "bob.ship.test#ship" }, { ...request, aud: `${request.aud}#again` }, { ...request, lxm: "deliver" }]) {
      expect(await rejection(repo.serviceAuth(invalid))).toContain("InvalidRequest");
    }
    expect(await rejection(env.REPOS.getByName(crypto.randomUUID()).serviceAuth(request))).toContain("RepoNotFound");
  });

  it("finishes creating an account after the directory's response was lost", async () => {
    const name = crypto.randomUUID();
    const handle = `${name}.ship.test`;
    const repo = env.REPOS.getByName(name);
    plc.loseNextResponse();
    expect(await rejection(repo.create(handle, blobPrefix(name)))).toContain("Network connection lost");
    expect(await repo.account()).toBeNull();

    const account = await repo.create(handle, blobPrefix(name));
    expect(plc.operations(account.did)).toHaveLength(1);
    expect(await repo.account()).toEqual(account);
  });

  it("decides each write against the commit before it, even while another write waits on blob storage", async () => {
    const { name, repo, account } = await hostAccount();
    const prefix = `${blobPrefix(name)}${account.did}/`;
    const [first, second] = await Promise.all([upload(repo, "first"), upload(repo, "second")]);
    const put = (text: string, blob: BlobRef): RepoWrite => ({
      action: "put",
      collection: NOTE,
      rkey: "card",
      record: noteRecord(text, { file: blobField(blob) }),
    });
    // R2 calls take network time, during which the object accepts other requests.
    const promote = BlobStore.prototype.promoteBlob;
    vi.spyOn(BlobStore.prototype, "promoteBlob").mockImplementation(async function (this: BlobStore, cid: string, staged?: string) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return promote.call(this, cid, staged);
    });
    // Both writes start before either commits; each first promotes its upload.
    await Promise.all([repo.applyWrites([put("first", first)]), repo.applyWrites([put("second", second)])]);

    const card = await read(z.object({ value: z.object({ text: z.string() }) }), xrpc("com.atproto.repo.getRecord", {
      repo: account.did,
      collection: NOTE,
      rkey: "card",
    }));
    expect(card.value.text).toBe("second");
    expect(await blobKeys(prefix)).toEqual([`${prefix}${second.ref.$link}`]);
  });

  it("chains overlapping writes into commits a relay can verify", async () => {
    const live = await subscribe(hostFirehose());
    const { repo, account } = await hostAccount();
    const commits = await Promise.all(
      Array.from({ length: 8 }, (_, index) => repo.applyWrites([note(`note-${index}`, `note ${index}`)])),
    );
    const listed = await read(recordPage, xrpc("com.atproto.repo.listRecords", { repo: account.did, collection: NOTE }));
    expect(listed.records.map((record) => record.uri).sort())
      .toEqual(commits.flatMap((commit) => commit.results.map((result) => result.uri)).sort());

    await deliver(repo);
    const didKey = await signingDidKey(account.did);
    await vi.waitFor(() => expect(framesFor(live, account.did)).toHaveLength(11));
    expect(await verifyChain(framesFor(live, account.did), didKey)).toBe(8);
    const exported = await xrpc("com.atproto.sync.getRepo", { did: account.did });
    const car = new Uint8Array(await exported.arrayBuffer());
    expect((await verifyRepoCar(car, account.did, didKey)).creates).toHaveLength(8);
  });

  it("announces a head that no event announced before the repository's next write", async () => {
    const { repo, account } = await hostAccount();
    const live = await subscribe(hostFirehose());
    const blocked = blockDelivery();
    const lost = await repo.applyWrites([note("lost", "its event never reached the outbox")]);
    await runInDurableObject(repo, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM firehose_events WHERE event_type = 'commit'");
    });
    // A restarted object compares the head with its last announced revision before writing.
    await runInDurableObject(repo, async (_instance, state) => {
      await new HostedRepo(state, env).applyWrites([note("next", "after a restart")]);
    });
    blocked.append.mockRestore();

    await deliver(repo);
    await vi.waitFor(() => expect(framesFor(live, account.did)).toHaveLength(2));
    expect(framesFor(live, account.did)).toMatchObject([
      { type: "#sync", body: { rev: lost.commit.rev } },
      { type: "#commit", body: { since: lost.commit.rev } },
    ]);
    expect(await verifyChain(framesFor(live, account.did), await signingDidKey(account.did))).toBe(1);
  });

  it("retries delivery with backoff until the host firehose accepts it", async () => {
    const blocked = blockDelivery();
    const { repo, account } = await createAccount();
    const first = await nextRetry(repo, 0);
    const second = await nextRetry(repo, first.failures);
    expect(second.failures).toBe(first.failures + 1);
    expect(second.delay).toBeGreaterThan(first.delay);
    expect(blocked.errors).toHaveBeenCalledWith("Firehose delivery failed; retrying", expect.any(Error));
    blocked.append.mockRestore();

    await deliver(repo);
    expect((await retryState(repo)).failures).toBe(0);
    expect(await hostFirehose().locate(account.did)).toMatchObject({ rev: (await repo.state())?.rev });
  });

  it("publishes an upload once a record references it and deletes blobs no record references", async () => {
    const { name, repo, account } = await hostAccount();
    const prefix = `${blobPrefix(name)}${account.did}/`;
    const first = await upload(repo, "first");
    expect(await blobKeys(prefix)).toEqual([stagedCopy(prefix)]);
    expect(await errorOf(xrpc("com.atproto.sync.getBlob", { did: account.did, cid: first.ref.$link }))).toBe("BlobNotFound");

    await repo.applyWrites([note("card", "with a file", { file: blobField(first) })]);
    expect(await blobKeys(prefix)).toEqual([`${prefix}${first.ref.$link}`]);
    expect(await read(z.json(), xrpc("com.atproto.sync.listBlobs", { did: account.did }))).toEqual({ cids: [first.ref.$link] });
    const served = await xrpc("com.atproto.sync.getBlob", { did: account.did, cid: first.ref.$link });
    expect(served.headers.get("Content-Type")).toBe("text/plain");
    expect(served.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(await served.text()).toBe("first");

    const second = await upload(repo, "second");
    await repo.applyWrites([
      { action: "put", collection: NOTE, rkey: "card", record: noteRecord("replaced", { file: blobField(second) }) },
      note("copy", "shares the file", { file: blobField(second) }),
    ]);
    expect(await blobKeys(prefix)).toEqual([`${prefix}${second.ref.$link}`]);

    await repo.applyWrites([{ action: "delete", collection: NOTE, rkey: "card" }]);
    expect(await blobKeys(prefix)).toEqual([`${prefix}${second.ref.$link}`]);
    await repo.applyWrites([{ action: "delete", collection: NOTE, rkey: "copy" }]);
    expect(await blobKeys(prefix)).toEqual([]);

    expect(await rejection(repo.applyWrites([note("again", "a deleted file", { file: blobField(first) })]))).toContain("BlobNotFound");
  });

  it("keeps a blob that a commit saved before its event failed still references", async () => {
    const { name, repo, account } = await hostAccount();
    const prefix = `${blobPrefix(name)}${account.did}/`;
    const file = await upload(repo, "shared");
    await repo.applyWrites([note("first", "with the file", { file: blobField(file) })]);
    // The engine saves the next commit, then fails to sequence its event.
    vi.spyOn(Sequencer.prototype, "sequenceCommit").mockRejectedValueOnce(new Error("Sequencer unavailable"));
    const shared: RepoWrite = { action: "create", collection: NOTE, record: noteRecord("shares the file", { file: blobField(file) }) };
    expect(await rejection(repo.applyWrites([shared]))).toContain("Sequencer unavailable");
    const listed = await read(recordPage, xrpc("com.atproto.repo.listRecords", { repo: account.did, collection: NOTE }));
    expect(listed.records.map((record) => record.value.text).sort()).toEqual(["shares the file", "with the file"]);

    await repo.applyWrites([{ action: "delete", collection: NOTE, rkey: "first" }]);
    expect(await blobKeys(prefix)).toEqual([`${prefix}${file.ref.$link}`]);
  });

  it("leaves no blob public when a write references one that was never uploaded", async () => {
    const { name, repo, account } = await hostAccount();
    const prefix = `${blobPrefix(name)}${account.did}/`;
    const uploaded = await upload(repo, "uploaded");
    const missing = { ...uploaded, ref: { $link: "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku" } };
    const write = note("pair", "two files", { files: [blobField(uploaded), blobField(missing)] });

    expect(await rejection(repo.applyWrites([write]))).toContain("BlobNotFound");
    expect(await blobKeys(prefix)).toEqual([stagedCopy(prefix)]);
  });

  it("expires an upload that no record references", async () => {
    const { name, repo, account } = await hostAccount();
    const prefix = `${blobPrefix(name)}${account.did}/`;
    const orphan = await upload(repo, "orphan");
    await runInDurableObject(repo, async (_instance, state) => {
      state.storage.sql.exec("UPDATE staged_blobs SET expires_at = ?", Date.now() - 1);
    });
    await vi.waitFor(async () => {
      await runDurableObjectAlarm(repo);
      expect(await blobKeys(prefix)).toEqual([]);
    });
    expect(await rejection(repo.applyWrites([note("late", "an expired file", { file: blobField(orphan) })]))).toContain("BlobNotFound");
  });

  it("names a streamed upload by the CID of its bytes, keeping one staged copy for identical uploads", async () => {
    const { name, repo, account } = await hostAccount();
    const prefix = `${blobPrefix(name)}${account.did}/`;
    const text = "x".repeat(200_000);
    const first = await upload(repo, text, "image/png");
    expect(first).toEqual({
      $type: "blob",
      ref: { $link: formatCid(await createCid(CODEC_RAW, new TextEncoder().encode(text))) },
      mimeType: "image/png",
      size: 200_000,
    });
    expect(await upload(repo, text, "image/png")).toEqual(first);
    expect(await blobKeys(prefix)).toEqual([stagedCopy(prefix)]);
    expect(await stagedRows(repo)).toEqual([first.ref.$link]);
  });

  it("refuses an upload that differs from its declared size or type, storing nothing and expiring its record", async () => {
    const { name, repo, account } = await hostAccount();
    const prefix = `${blobPrefix(name)}${account.did}/`;
    const data = new TextEncoder().encode("eleven byte");
    expect(await rejection(repo.uploadBlob(byteStream(data), data.byteLength - 1, "text/plain"))).toContain("longer than its declared");
    expect(await rejection(repo.uploadBlob(byteStream(data), data.byteLength + 1, "text/plain"))).toContain("ended after 11");
    expect(await rejection(repo.uploadBlob(byteStream(data), MAX_BLOB_BYTES + 1, "text/plain"))).toContain("BlobTooLarge");
    for (const mimeType of ["text/plain; charset=utf-8", "plain", ""]) {
      expect(await rejection(repo.uploadBlob(byteStream(data), data.byteLength, mimeType))).toContain("is not a MIME type");
    }
    expect(await blobKeys(prefix)).toEqual([]);
    expect(await stagedRows(repo)).toEqual([null, null]);
    await runInDurableObject(repo, async (_instance, state) => {
      state.storage.sql.exec("UPDATE staged_blobs SET expires_at = ?", Date.now() - 1);
    });
    await vi.waitFor(async () => {
      await runDurableObjectAlarm(repo);
      expect(await stagedRows(repo)).toEqual([]);
    });
  });

  it("reads back an upload before a record publishes it, and after", async () => {
    const { repo } = await hostAccount();
    const uploaded = await upload(repo, "draft photo", "image/jpeg");
    const readBack = async () => {
      const blob = await repo.readBlob(uploaded.ref.$link);
      return blob && { mimeType: blob.mimeType, size: blob.size, text: await new Response(blob.body).text() };
    };
    expect(await readBack()).toEqual({ mimeType: "image/jpeg", size: 11, text: "draft photo" });
    await repo.applyWrites([note("photo", "published", { file: blobField(uploaded) })]);
    expect(await readBack()).toEqual({ mimeType: "image/jpeg", size: 11, text: "draft photo" });
    expect(await repo.readBlob("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku")).toBeNull();
    expect(await rejection(repo.readBlob(`staged/${uploaded.ref.$link}`))).toContain("is not a blob CID");
  });

  it("streams an upload as large as the host stages", { timeout: 120_000 }, async () => {
    const { repo } = await hostAccount();
    const chunk = new Uint8Array(1024 * 1024).map((_, index) => index % 251);
    const chunks = MAX_BLOB_BYTES / chunk.byteLength;
    const digest = new crypto.DigestStream("SHA-256");
    const writer = digest.getWriter();
    for (let index = 0; index < chunks; index += 1) await writer.write(chunk);
    await writer.close();
    let sent = 0;
    const body = new ReadableStream({
      type: "bytes",
      pull(controller) {
        if (sent === chunks) return controller.close();
        sent += 1;
        controller.enqueue(chunk.slice());
      },
    });
    const blob = await repo.uploadBlob(body, MAX_BLOB_BYTES, "video/mp4");
    expect(blob.ref.$link).toBe(formatCid(fromDigest(CODEC_RAW, new Uint8Array(await digest.digest))));
    expect(blob.size).toBe(MAX_BLOB_BYTES);
  });
});

describe("host XRPC", () => {
  it("lists records newest first, or oldest first when reversed, one page at a time", async () => {
    const { repo, account, handle } = await hostAccount();
    await repo.applyWrites(["a", "b", "c", "d", "e"].map((rkey) => note(rkey, rkey)));

    expect(await listAll(handle.toUpperCase(), false)).toEqual([["e", "d"], ["c", "b"], ["a"]]);
    expect(await listAll(account.did, true)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(await errorOf(xrpc("com.atproto.repo.listRecords", { repo: account.did, collection: NOTE, limit: "0" })))
      .toBe("InvalidRequest");
  });

  it("serves records and the proofs a client verifies them with", async () => {
    const { repo, account } = await hostAccount();
    const { results: [written] } = await repo.applyWrites([note("proved", "a proved record")]);
    const didKey = await signingDidKey(account.did);

    const record = { repo: account.did, collection: NOTE, rkey: "proved" };
    expect(await read(z.json(), xrpc("com.atproto.repo.getRecord", record))).toEqual({
      uri: written?.uri,
      cid: written?.cid,
      value: noteRecord("a proved record"),
    });
    expect(await errorOf(xrpc("com.atproto.repo.getRecord", { ...record, cid: "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kpqcsgz7soitae" })))
      .toBe("RecordNotFound");
    expect(await errorOf(xrpc("com.atproto.repo.getRecord", { ...record, rkey: "missing" }))).toBe("RecordNotFound");

    const proof = await xrpc("com.atproto.sync.getRecord", { did: account.did, collection: NOTE, rkey: "proved" });
    const claims = [{ collection: NOTE, rkey: "proved", cid: CID.parse(written?.cid ?? "") }];
    expect((await verifyProofs(new Uint8Array(await proof.arrayBuffer()), claims, account.did, didKey)).verified).toHaveLength(1);

    const latest = await read(latestCommit, xrpc("com.atproto.sync.getLatestCommit", { did: account.did }));
    expect(latest.rev).toBe((await repo.state())?.rev);
    expect(await read(z.json(), xrpc("com.atproto.sync.getRepoStatus", { did: account.did })))
      .toEqual({ did: account.did, active: true, rev: latest.rev });
    const blocks = await xrpc("com.atproto.sync.getBlocks", { did: account.did, cids: latest.cid });
    expect(blocks.headers.get("Content-Type")).toBe("application/vnd.ipld.car");
  });

  it("answers for a repository the host does not hold without addressing any repository object", async () => {
    const before = (await listDurableObjectIds(env.REPOS)).length;
    const unknown = "did:plc:zzzzzzzzzzzzzzzzzzzzzzzz";
    expect(await errorOf(xrpc("com.atproto.repo.describeRepo", { repo: unknown }))).toBe("RepoNotFound");
    expect(await errorOf(xrpc("com.atproto.sync.getRepo", { did: unknown }))).toBe("RepoNotFound");
    expect(await errorOf(xrpc("com.atproto.repo.getRecord", { repo: "nobody.ship.test", collection: NOTE, rkey: "self" })))
      .toBe("RepoNotFound");
    expect(await errorOf(xrpc("com.atproto.sync.getRepo", { did: "nobody.ship.test" }))).toBe("InvalidRequest");
    expect(await listDurableObjectIds(env.REPOS)).toHaveLength(before);
  });

  it("reports a repository the deployment does not admit", async () => {
    const { account } = await hostAccount();
    const suspended = async (): Promise<Admission> => "suspended";
    expect(await errorOf(xrpc("com.atproto.repo.describeRepo", { repo: account.did }, suspended))).toBe("RepoSuspended");
    expect(await read(z.json(), xrpc("com.atproto.sync.getRepoStatus", { did: account.did }, suspended)))
      .toEqual({ did: account.did, active: false, status: "suspended" });
  });

  it("refuses a blob CID that would name a staged upload", async () => {
    const { repo, account } = await hostAccount();
    const staged = await upload(repo, "unpublished");
    expect(await errorOf(xrpc("com.atproto.sync.getBlob", { did: account.did, cid: `staged/${staged.ref.$link}` })))
      .toBe("InvalidRequest");
  });

  it("serves host methods with CORS and streams the firehose", async () => {
    const { account } = await hostAccount();
    const server = await xrpc("com.atproto.server.describeServer", {});
    expect(server.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await server.json()).toEqual({ did: "did:web:pds.test", availableUserDomains: [], inviteCodeRequired: true });

    const listing = z.object({ repos: z.array(z.object({ did: z.string(), active: z.boolean() })) })
      .parse(await read(z.json(), xrpc("com.atproto.sync.listRepos", { limit: "1000" })));
    expect(listing.repos).toContainEqual(expect.objectContaining({ did: account.did, active: true }));

    const preflight = await handleXrpc(new Request("https://pds.test/xrpc/_health", { method: "OPTIONS" }), env, admitAll);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toBe("GET, HEAD, OPTIONS");
    expect(await errorOf(xrpc("com.atproto.repo.createRecord", {}))).toBe("MethodNotImplemented");
    const post = await handleXrpc(new Request("https://pds.test/xrpc/_health", { method: "POST" }), env, admitAll);
    expect(post.status).toBe(405);

    const upgrade = new Request("https://pds.test/xrpc/com.atproto.sync.subscribeRepos", { headers: { Upgrade: "websocket" } });
    const socket = await handleXrpc(upgrade, env, admitAll);
    expect(socket.status).toBe(101);
    socket.webSocket?.accept();
    socket.webSocket?.close();
  });
});

describe("host firehose", () => {
  const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";

  it("appends a retried batch once and keeps each DID with one repository", async () => {
    const firehose = env.FIREHOSE.getByName(crypto.randomUUID());
    expect(await firehose.append("one", repoState(did), identityEvents(did, 1, 3))).toBe(3);
    expect(await firehose.append("one", repoState(did), identityEvents(did, 1, 3))).toBe(3);
    expect(await firehose.append("one", repoState(did), identityEvents(did, 3, 5))).toBe(5);
    const replay = await subscribe(firehose, 0);
    await vi.waitFor(() => expect(replay.frames.map(seqOf)).toEqual([1, 2, 3, 4, 5]));

    expect(await rejection(firehose.append("two", repoState(did), identityEvents(did, 6, 6)))).toContain("RepoConflict");
    const other = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
    expect(await rejection(firehose.append("one", repoState(other), identityEvents(other, 1, 1)))).toContain("RepoConflict");
  });

  it("replays every retained frame after a cursor, across pages", async () => {
    const firehose = env.FIREHOSE.getByName(crypto.randomUUID());
    for (let from = 1; from <= 1200; from += 100) {
      await firehose.append("one", repoState(did), identityEvents(did, from, from + 99));
    }
    const all = await subscribe(firehose, 0);
    const tail = await subscribe(firehose, 700);
    await vi.waitFor(() => {
      expect(all.frames).toHaveLength(1200);
      expect(tail.frames).toHaveLength(500);
    });
    expect(all.frames.map(seqOf)).toEqual(range(1, 1200));
    expect(tail.frames.map(seqOf)).toEqual(range(701, 1200));
  });

  it("closes a subscription whose cursor is in the future", async () => {
    const firehose = env.FIREHOSE.getByName(crypto.randomUUID());
    await firehose.append("one", repoState(did), identityEvents(did, 1, 2));
    const future = await subscribe(firehose, 3);
    expect(await future.closed).toBe(1008);
    expect(future.frames).toEqual([{ type: "error", body: { error: "FutureCursor", message: "Cursor is in the future" } }]);
  });

  it("tells a subscriber whose cursor predates retention that events were skipped", async () => {
    const firehose = env.FIREHOSE.getByName(crypto.randomUUID());
    await firehose.append("one", repoState(did), identityEvents(did, 1, 5));
    await runInDurableObject(firehose, async (_instance, state) => {
      state.storage.sql.exec("UPDATE events SET appended_at = 0 WHERE seq <= 3");
    });
    await firehose.append("one", repoState(did), identityEvents(did, 6, 6));

    const outdated = await subscribe(firehose, 1);
    const current = await subscribe(firehose, 3);
    await vi.waitFor(() => {
      expect(outdated.frames).toHaveLength(4);
      expect(current.frames).toHaveLength(3);
    });
    expect(outdated.frames[0]).toMatchObject({ type: "#info", body: { name: "OutdatedCursor" } });
    expect(outdated.frames.slice(1).map(seqOf)).toEqual([4, 5, 6]);
    expect(current.frames.map(seqOf)).toEqual([4, 5, 6]);
  });

  it("lists repositories with a head in DID order and finds them by DID or handle", async () => {
    const firehose = env.FIREHOSE.getByName(crypto.randomUUID());
    const alice = repoState("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", "alice.ship.test");
    const bob = repoState("did:plc:bbbbbbbbbbbbbbbbbbbbbbbb", "bob.ship.test");
    const carol = { ...repoState("did:plc:cccccccccccccccccccccccc", "carol.ship.test"), rev: null, head: null };
    await firehose.append("bob", bob, identityEvents(bob.did, 1, 1));
    await firehose.append("alice", alice, identityEvents(alice.did, 1, 1));
    await firehose.append("carol", carol, identityEvents(carol.did, 1, 1));

    const first = await firehose.listRepos(1);
    expect(first).toEqual({ repos: [alice], cursor: alice.did });
    expect(await firehose.listRepos(1, first.cursor)).toEqual({ repos: [bob] });
    expect(await firehose.locate("ALICE.ship.test")).toEqual({ ...alice, name: "alice" });
    expect(await firehose.locate(carol.did)).toEqual({ ...carol, name: "carol" });
    expect(await firehose.locate("nobody.ship.test")).toBeNull();
  });

  it("finds a handle's newest repository, as when a reset moves the handle to a new installation", async () => {
    const firehose = env.FIREHOSE.getByName(crypto.randomUUID());
    const retired = repoState("did:plc:dddddddddddddddddddddddd", "dana.ship.test");
    const current = repoState("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", "dana.ship.test");
    await firehose.append("retired", retired, identityEvents(retired.did, 1, 1));
    await firehose.append("current", current, identityEvents(current.did, 1, 1));
    // Later events from the retired repository do not take the handle back.
    await firehose.append("retired", retired, identityEvents(retired.did, 2, 2));
    expect(await firehose.locate("DANA.ship.test")).toEqual({ ...current, name: "current" });
    expect(await firehose.locate(retired.did)).toEqual({ ...retired, name: "retired" });
  });
});

async function admitAll(): Promise<Admission> {
  return "active";
}

function xrpc(
  method: string,
  params: ConstructorParameters<typeof URLSearchParams>[0],
  admit: (name: string) => Promise<Admission> = admitAll,
): Promise<Response> {
  return handleXrpc(new Request(`https://pds.test/xrpc/${method}?${new URLSearchParams(params)}`), env, admit);
}

/** Every page of a collection's listing, as record keys. */
async function listAll(repo: string, reverse: boolean): Promise<string[][]> {
  const pages: string[][] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ repo, collection: NOTE, limit: "2", reverse: String(reverse) });
    if (cursor !== undefined) params.set("cursor", cursor);
    const page = await read(recordPage, xrpc("com.atproto.repo.listRecords", params));
    pages.push(page.records.map((record) => record.uri.split("/").at(-1) ?? ""));
    cursor = page.cursor;
  } while (cursor !== undefined);
  return pages;
}

function hostFirehose(): DurableObjectStub<HostFirehose> {
  return env.FIREHOSE.getByName(FIREHOSE_NAME);
}

async function createAccount() {
  const name = crypto.randomUUID();
  const handle = `${name}.ship.test`;
  const repo = env.REPOS.getByName(name);
  const account = await repo.create(handle, blobPrefix(name));
  return { name, handle, repo, account };
}

/** Creates an account and waits until the host directory lists it. */
async function hostAccount() {
  const created = await createAccount();
  await deliver(created.repo);
  return created;
}

/** A service-auth token's decoded parts and the bytes its signature covers. */
function decodeToken(token: string) {
  const parts = token.split(".");
  const [header, payload, signature] = parts;
  if (parts.length !== 3 || !header || !payload || !signature) throw new Error("A token has three parts");
  const json = (part: string) => z.record(z.string(), z.union([z.string(), z.number()])).parse(JSON.parse(new TextDecoder().decode(fromBase64Url(part))));
  return { parts, header: json(header), payload: json(payload), signature: fromBase64Url(signature), signed: utf8(`${header}.${payload}`) };
}

/** UTF-8 bytes backed by a plain ArrayBuffer, which the atcute verifiers take. */
function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(text));
}

function blobPrefix(name: string): string {
  return `installations/${name}/`;
}

async function hostRotationKey(): Promise<string> {
  return (await Secp256k1PrivateKey.importRaw(fromBase16(env.PLC_ROTATION_KEY))).exportPublicKey("did");
}

async function signingDidKey(did: string): Promise<string> {
  const description = await read(describedRepo, xrpc("com.atproto.repo.describeRepo", { repo: did }));
  const method = description.didDoc.verificationMethod[0];
  if (!method) throw new Error("The repository publishes no signing key");
  return `did:key:${method.publicKeyMultibase}`;
}

function noteRecord(text: string, fields: LexObject = {}): LexObject {
  return { $type: NOTE, text, createdAt: "2026-10-23T00:00:00.000Z", ...fields };
}

function note(rkey: string, text: string, fields: LexObject = {}): RepoWrite {
  return { action: "create", collection: NOTE, rkey, record: noteRecord(text, fields) };
}

function blobField(blob: BlobRef): LexObject {
  return { $type: blob.$type, ref: { $link: blob.ref.$link }, mimeType: blob.mimeType, size: blob.size };
}

/** The key of an upload's staged copy, which is named before its CID is known. */
function stagedCopy(prefix: string) {
  return expect.stringMatching(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}staged/upload-[0-9a-f-]{36}$`));
}

async function stagedRows(repo: DurableObjectStub<HostedRepo>) {
  return runInDurableObject(repo, async (_instance, state) =>
    state.storage.sql.exec<{ cid: string | null }>("SELECT cid FROM staged_blobs").toArray().map((row) => row.cid));
}

async function blobKeys(prefix: string): Promise<string[]> {
  return (await env.BLOBS.list({ prefix })).objects.map((object) => object.key).sort();
}

/** Makes every delivery to a host firehose fail until `append` is restored; `errors` records what delivery logs. */
function blockDelivery() {
  return {
    append: vi.spyOn(HostFirehose.prototype, "append").mockRejectedValue(new Error("Firehose unavailable")),
    errors: vi.spyOn(console, "error").mockImplementation(() => undefined),
  };
}

/** Runs a repository's alarm until delivery has failed more than `after` times; returns the retry it scheduled. */
async function nextRetry(repo: DurableObjectStub<HostedRepo>, after: number) {
  return vi.waitFor(async () => {
    await runDurableObjectAlarm(repo);
    const retry = await retryState(repo);
    expect(retry.failures).toBeGreaterThan(after);
    return retry;
  });
}

async function retryState(repo: DurableObjectStub<HostedRepo>) {
  return runInDurableObject(repo, async (_instance, state) => ({
    failures: (await state.storage.get<number>("firehose.failures")) ?? 0,
    delay: ((await state.storage.getAlarm()) ?? Date.now()) - Date.now(),
  }));
}

/** Verifies each commit from its own blocks and checks it builds on the revision announced before it. */
async function verifyChain(frames: Frame[], didKey: string): Promise<number> {
  let since: string | null = null;
  let commits = 0;
  for (const frame of frames) {
    if (frame.type === "#sync") since = frame.body.rev;
    if (frame.type !== "#commit") continue;
    await verifyCommit(frame.body, didKey);
    expect(frame.body.since).toBe(since);
    since = frame.body.rev;
    commits += 1;
  }
  return commits;
}

function repoState(did: string, handle = "repo.ship.test"): RepoState {
  return {
    did,
    handle,
    active: true,
    status: null,
    rev: "3m3cu3ae2wk2a",
    head: "bafyreigq5ajqdyoscxcc6vfnsdhyjd5bp6lvt6xf6tzfxqavsumubocwge",
  };
}

function identityEvents(did: string, from: number, to: number): OutboxEvent[] {
  return range(from, to).map((seq) => ({ seq, type: "identity", payload: encode({ did, time: "2026-10-23T00:00:00.000Z" }) }));
}

function seqOf(frame: Frame): number | null {
  return "seq" in frame ? frame.seq : null;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}
