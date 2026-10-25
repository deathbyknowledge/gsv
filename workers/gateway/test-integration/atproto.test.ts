import { Lexicons, jsonToLex, lexiconDoc } from "@atproto/lexicon";
import { bodyFromBytes, bodyToBytes, type PublicRecordWrite } from "@humansandmachines/gsv/protocol";
import { describe, expect, it } from "vitest";
import profileLexicon from "../../../lexicons/space/ship/profile.json";
import { startProcessRuntimeHarness } from "./process-runtime-harness";

/** The fixture PDS as these tests read it back: each installation's committed batches of writes. */
type FixturePds = { getInstallation(installationId: string): Promise<{ commits(): Promise<PublicRecordWrite[][]> }> };

const NOTE = { action: "put" as const, collection: "space.ship.note", rkey: "first", record: { $type: "space.ship.note", text: "hello" } };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe("publishing to the open network", () => {
  it("publishes the person's profile at sign-in, creating the Ship's identity, then lets them publish directly", async () => {
    const runtime = await startProcessRuntimeHarness({ pds: true });
    try {
      const [profile] = await profilePublishedAtSignIn(runtime);
      expect(profile).toEqual([expect.objectContaining({ action: "put", collection: "space.ship.profile", rkey: "self" })]);
      expect(await runtime.client.atproto.identity({})).toEqual({
        identity: { did: "did:plc:dddddddddddddddddddddddd", handle: "default.gsv.space", host: "https://pds.gsv.space" },
      });
      // Large enough that the file is still streaming after the Kernel releases its repository handle.
      const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, index) => index % 251);
      const uploaded = await runtime.client.request("atproto.blob.upload", { mimeType: "image/png" }, { body: bodyFromBytes(bytes) });
      const { blob } = uploaded.data;
      expect(blob).toMatchObject({ $type: "blob", mimeType: "image/png", size: bytes.byteLength });
      // The file reads back before any record references it.
      const read = await runtime.client.request("atproto.blob.read", { cid: blob.ref.$link });
      expect(read.data).toEqual({ mimeType: "image/png", size: bytes.byteLength });
      expect(await bodyToBytes(read.body!)).toEqual(bytes);

      const write = { ...NOTE, record: { ...NOTE.record, picture: blob } };
      const commit = await runtime.client.atproto.write({ writes: [write] });
      expect(commit.results).toEqual([{ uri: "at://did:plc:dddddddddddddddddddddddd/space.ship.note/first", cid: "bafyrecord2" }]);
      expect(await committed(runtime.harness)).toEqual([profile, [write]]);
      await expect(runtime.client.atproto.write({ writes: [{ action: "delete", collection: "space.ship.profile", rkey: "self" }] }))
        .rejects.toThrow("space.ship.profile is your profile; change it in People");
      expect(await committed(runtime.harness)).toHaveLength(2);
    } finally { await runtime.close(); }
  });
});

describe("the profile record", () => {
  it("is one its lexicon accepts, with a picture and without, as the reference validator reads it", async () => {
    const runtime = await startProcessRuntimeHarness({ pds: true });
    try {
      await profilePublishedAtSignIn(runtime);
      const { profile } = await runtime.client.profile.get({});
      const set = await runtime.client.request("profile.avatar.set", { expectedRevision: profile.revision, mimeType: "image/png" }, { body: bodyFromBytes(PNG) });
      await set.body?.stream.cancel("profile.avatar.set does not return a body");
      await runtime.client.profile.publish({ expectedRevision: set.data.profile.revision });
      await runtime.waitFor(async () => (await committed(runtime.harness)).length === 2, "the profile published with its picture");

      const records = (await committed(runtime.harness)).flat().map((write) => write.action === "delete" ? null : write.record);
      expect(records).toEqual([
        expect.not.objectContaining({ avatar: expect.anything() }),
        expect.objectContaining({ avatar: { $type: "blob", ref: { $link: expect.any(String) }, mimeType: "image/png", size: PNG.byteLength } }),
      ]);
      const lexicons = new Lexicons([lexiconDoc.parse(profileLexicon)]);
      for (const record of records) lexicons.assertValidRecord("space.ship.profile", jsonToLex(record));
    } finally { await runtime.close(); }
  });
});

describe("the Ship publishing to the open network", () => {
  it("asks first, even when other tools run without asking, and writes only what the person approves", async () => {
    const runtime = await startProcessRuntimeHarness({ pds: true });
    try {
      const signIn = await profilePublishedAtSignIn(runtime);
      const ship = (await runtime.client.proc.list({})).processes.find(({ personal }) => personal);
      if (!ship) throw new Error("Setup did not create Ship");
      await runtime.configureAi(ship.pid);
      await runtime.client.sys.config.set({ key: `users/${ship.uid}/ai/tools/approval`, value: JSON.stringify({ default: "auto", rules: [] }) });
      await runtime.client.proc.observe({ pid: ship.pid });
      const publish = (rkey: string) => ({ kind: "tool-calls" as const, calls: [{ id: `publish-${rkey}`, name: "Shell", arguments: {
        input: `atproto put space.ship.note ${rkey} --json '{"text":"hello"}'`, purpose: "Publish the note",
      } }] });
      const finish = { kind: "tool-calls" as const, calls: [{ id: "finish", name: "Send", arguments: { yield: true } }] };
      const written = { action: "put", collection: "space.ship.note", rkey: "approved", record: { $type: "space.ship.note", text: "hello" } };

      for (const [rkey, decision] of [["denied", "deny"], ["approved", "approve"]] as const) {
        runtime.ai.enqueue(publish(rkey), finish);
        const sent = await runtime.client.proc.send({ pid: ship.pid, message: "Publish a note." });
        if (!sent.ok) throw new Error(sent.error);
        await runtime.waitFor(async () => {
          const state = await runtime.client.proc.history({ pid: ship.pid, includeMessages: false });
          return state.ok && state.pendingHil?.syscall === "atproto.write";
        }, `the ${rkey} publish approval`, 15000);
        const history = await runtime.client.proc.history({ pid: ship.pid, includeMessages: false });
        if (!history.ok || !history.pendingHil) throw new Error("Publish approval missing from process history");
        expect(history.pendingHil).toMatchObject({ syscall: "atproto.write", args: {
          handle: "default", address: "default.gsv.space",
          writes: [{ ...written, rkey }],
        } });
        expect(await committed(runtime.harness)).toEqual(signIn);
        expect(await runtime.client.proc.hil({ pid: ship.pid, requestId: history.pendingHil.requestId, decision })).toMatchObject({ ok: true });
        await runtime.waitFor(async () => {
          const state = await runtime.client.proc.history({ pid: ship.pid, includeMessages: false });
          return state.ok && state.activeRunId === null;
        }, `the ${rkey} run to finish`, 15000);
        if (decision === "deny") expect(await committed(runtime.harness)).toEqual(signIn);
      }
      expect(await committed(runtime.harness)).toEqual([...signIn, [written]]);
    } finally { await runtime.close(); }
  });
});

/** The write batches committed once the person's sign-in has published their profile, the Ship's first write. */
async function profilePublishedAtSignIn(runtime: Awaited<ReturnType<typeof startProcessRuntimeHarness>>) {
  await runtime.waitFor(async () => (await committed(runtime.harness)).length > 0, "the profile published at sign-in");
  return await committed(runtime.harness);
}

/** The write batches the fixture PDS committed for the harness installation. */
async function committed(harness: Awaited<ReturnType<typeof startProcessRuntimeHarness>>["harness"]) {
  const { PDS } = await harness.getWorker<{ PDS: FixturePds }>("gsv").getEnv();
  const repository = await PDS.getInstallation("inst_integration_default");
  return await repository.commits();
}
