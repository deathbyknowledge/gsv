import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Secp256k1Keypair } from "@atproto/crypto";
import { verifyRepoCar } from "@atproto/repo";
import { describe, expect, it, vi } from "vitest";
import { BlobStore, extractJsonBlobCids } from "../src/cirrus/repo/blobs";
import { RepoEngine } from "../src/cirrus/repo/engine";
import { Firehose } from "../src/cirrus/repo/firehose";
import { Sequencer, type CommitEvent, type SeqEvent } from "../src/cirrus/repo/sequencer";
import { SqliteRepoStorage } from "../src/cirrus/repo/storage";
import { getRepoCar } from "../src/cirrus/repo/sync";
import { verifyCommit } from "./relay";

const DID = "did:web:repo.test";
const NOTE = "space.gsv.note";

async function testSigner(): Promise<{ didKey: string; signingKey: string }> {
  const keypair = await Secp256k1Keypair.create({ exportable: true });
  const signingKey = Array.from(await keypair.export(), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { didKey: keypair.did(), signingKey };
}

function openRepo(state: DurableObjectState, signingKey: string, broadcast: (event: SeqEvent) => Promise<void> = async () => {}) {
  const storage = new SqliteRepoStorage(state.storage.sql);
  storage.initSchema();
  const sequencer = new Sequencer(state.storage.sql);
  const engine = new RepoEngine({
    storage, sequencer, did: DID, signingKey, lock: (fn) => state.blockConcurrencyWhile(fn), broadcast,
  });
  return { storage, sequencer, engine };
}

function acceptSubscriber(state: DurableObjectState) {
  const { 0: client, 1: server } = new WebSocketPair();
  state.acceptWebSocket(server);
  server.serializeAttachment({ cursor: 0 });
  const frames: Uint8Array[] = [];
  client.binaryType = "arraybuffer";
  client.accept();
  client.addEventListener("message", (message) => {
    if (message.data instanceof ArrayBuffer) frames.push(new Uint8Array(message.data));
  });
  return { server, frames };
}

describe("vendored Cirrus repo engine", () => {
  it("writes, reads, updates and deletes records", async () => {
    const { signingKey } = await testSigner();
    await runInDurableObject(env.ENGINE.getByName("records"), async (_host, state) => {
      const { engine } = openRepo(state, signingKey);
      const created = await engine.createRecord(NOTE, "first", { $type: NOTE, text: "hello" });
      expect(created.uri).toBe(`at://${DID}/${NOTE}/first`);
      expect(await engine.getRecord(NOTE, "first")).toEqual({ cid: created.cid, record: { $type: NOTE, text: "hello" } });

      const updated = await engine.putRecord(NOTE, "first", { $type: NOTE, text: "hello again" });
      expect(updated.cid).not.toBe(created.cid);
      const generated = await engine.createRecord(NOTE, undefined, { $type: NOTE, text: "second" });
      expect((await engine.listRecords(NOTE, { limit: 10 })).records.map((record) => record.uri).sort())
        .toEqual([created.uri, generated.uri].sort());

      expect(await engine.deleteRecord(NOTE, "first")).not.toBeNull();
      expect(await engine.getRecord(NOTE, "first")).toBeNull();
      expect((await engine.describeRepo()).collections).toEqual([NOTE]);
    });
  });

  it("sequences a commit chain a relay can verify from each event, across a reload", async () => {
    const { didKey, signingKey } = await testSigner();
    const stub = env.ENGINE.getByName("commits");
    const live: CommitEvent[] = [];
    const record = async (event: SeqEvent) => {
      if (event.type === "commit") live.push(event.event);
    };
    await runInDurableObject(stub, async (_host, state) => {
      const { engine } = openRepo(state, signingKey, record);
      await engine.createRecord(NOTE, "one", { $type: NOTE, text: "one" });
      await engine.putRecord(NOTE, "one", { $type: NOTE, text: "one, edited" });
      await engine.createRecord(NOTE, "two", { $type: NOTE, text: "two" });
    });
    await runInDurableObject(stub, async (_host, state) => {
      const { engine, sequencer } = openRepo(state, signingKey, record);
      await engine.deleteRecord(NOTE, "one");
      expect((await sequencer.getEventsSince(0)).map((event) => [event.seq, event.type]))
        .toEqual([[1, "commit"], [2, "commit"], [3, "commit"], [4, "commit"]]);
    });

    expect(live.map((event) => event.ops.map((op) => op.action)))
      .toEqual([["create"], ["update"], ["create"], ["delete"]]);
    for (const [index, event] of live.entries()) {
      await verifyCommit(event, didKey);
      const previous = live[index - 1];
      if (previous) expect(event.since).toBe(previous.rev);
    }
  });

  it("replays the same firehose frames a subscriber received live", async () => {
    const { signingKey } = await testSigner();
    await runInDurableObject(env.ENGINE.getByName("firehose"), async (_host, state) => {
      const sequencer = new Sequencer(state.storage.sql);
      const firehose = new Firehose(sequencer, () => state.getWebSockets());
      const live = acceptSubscriber(state);
      const { engine } = openRepo(state, signingKey, (event) => firehose.broadcast(event));
      await engine.createRecord(NOTE, "one", { $type: NOTE, text: "one" });
      await engine.deleteRecord(NOTE, "one");
      await vi.waitFor(() => expect(live.frames).toHaveLength(2));

      const replay = acceptSubscriber(state);
      await firehose.backfill(replay.server, 0);
      await vi.waitFor(() => expect(replay.frames).toHaveLength(2));
      expect(replay.frames).toEqual(live.frames);
      expect(replay.server.deserializeAttachment()).toEqual({ cursor: 2 });
    });
  });

  it("exports a repository CAR that verifies against the signing key", async () => {
    const { didKey, signingKey } = await testSigner();
    await runInDurableObject(env.ENGINE.getByName("export"), async (_host, state) => {
      const { engine, storage } = openRepo(state, signingKey);
      await engine.createRecord(NOTE, "kept", { $type: NOTE, text: "kept" });
      await engine.createRecord(NOTE, "gone", { $type: NOTE, text: "gone" });
      await engine.deleteRecord(NOTE, "gone");
      const car = new Uint8Array(await (await getRepoCar(state.storage.sql, storage)).arrayBuffer());
      const verified = await verifyRepoCar(car, DID, didKey);
      expect(verified.creates.map((create) => `${create.collection}/${create.rkey}`)).toEqual([`${NOTE}/kept`]);
    });
  });

  it("stages uploaded blobs until a record references them", async () => {
    const blobs = new BlobStore(env.BLOBS, DID);
    const blob = await blobs.putBlob(new TextEncoder().encode("hello"), "text/plain");
    expect(await env.BLOBS.head(`${DID}/staged/${blob.ref.$link}`)).not.toBeNull();
    expect(await blobs.hasBlob(blob.ref.$link)).toBe(false);

    const referenced = extractJsonBlobCids({ $type: NOTE, text: "with a file", attachments: [{ file: blob }] });
    expect(referenced).toEqual([blob.ref.$link]);
    await blobs.promoteBlobs(referenced);
    const served = await blobs.getBlob(blob.ref.$link);
    expect(served?.httpMetadata?.contentType).toBe("text/plain");
    expect(await served?.text()).toBe("hello");
  });

  it("deletes a blob's staged and public copies", async () => {
    const blobs = new BlobStore(env.BLOBS, DID, "installations/deletes/");
    const blob = await blobs.putBlob(new TextEncoder().encode("gone"), "text/plain");
    await blobs.promoteBlob(blob.ref.$link);

    await blobs.deleteStagedBlob(blob.ref.$link);
    expect(await env.BLOBS.head(`installations/deletes/${DID}/staged/${blob.ref.$link}`)).toBeNull();
    expect(await blobs.hasBlob(blob.ref.$link)).toBe(true);
    await blobs.deleteBlob(blob.ref.$link);
    expect(await blobs.hasBlob(blob.ref.$link)).toBe(false);
  });

  it("keeps blobs under the store's key prefix", async () => {
    const scoped = new BlobStore(env.BLOBS, DID, "installations/one/");
    const blob = await scoped.putBlob(new TextEncoder().encode("scoped"), "text/plain");
    await scoped.promoteBlob(blob.ref.$link);

    const keys = (await env.BLOBS.list({ prefix: "installations/" })).objects.map((object) => object.key);
    expect(keys.sort()).toEqual([`installations/one/${DID}/${blob.ref.$link}`, `installations/one/${DID}/staged/${blob.ref.$link}`]);
    expect(await new BlobStore(env.BLOBS, DID, "installations/two/").hasBlob(blob.ref.$link)).toBe(false);
  });
});
