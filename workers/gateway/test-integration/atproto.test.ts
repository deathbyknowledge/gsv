import { AppBskyActorProfile } from "@atcute/bluesky";
import { safeParse } from "@atcute/lexicons/validations";
import { Lexicons, jsonToLex, lexiconDoc } from "@atproto/lexicon";
import { bodyFromBytes, bodyToBytes, type PublicRecordWrite } from "@humansandmachines/gsv/protocol";
import type { PublicTakedown } from "@humansandmachines/gsv/services/pds";
import { describe, expect, it } from "vitest";
import profileLexicon from "../../../lexicons/space/ship/profile.json";
import { startProcessRuntimeHarness } from "./process-runtime-harness";

/** The fixture PDS as these tests drive it: each installation's committed batches of writes, and what its host has taken down. */
type FixturePds = { getInstallation(installationId: string): Promise<{
  commits(): Promise<PublicRecordWrite[][]>;
  setTakedowns(takedowns: PublicTakedown[]): Promise<void>;
}> };

const NOTE = { action: "put" as const, collection: "com.example.note", rkey: "first", record: { $type: "com.example.note", text: "hello" } };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe("publishing to the open network", () => {
  it("publishes the person's profile at sign-in, creating the Ship's identity, then lets them publish directly", async () => {
    const runtime = await startProcessRuntimeHarness({ pds: true });
    try {
      const [profile] = await profilePublishedAtSignIn(runtime);
      expect(profile).toEqual([
        expect.objectContaining({ action: "put", collection: "space.ship.profile", rkey: "self" }),
        expect.objectContaining({ action: "put", collection: "app.bsky.actor.profile", rkey: "self" }),
      ]);
      expect(await runtime.client.atproto.identity({})).toEqual({
        identity: { did: "did:plc:dddddddddddddddddddddddd", handle: "default.gsv.space", host: "https://pds.gsv.space" },
        takedowns: [],
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
      expect(commit.results).toEqual([{ uri: "at://did:plc:dddddddddddddddddddddddd/com.example.note/first", cid: "bafyrecord2" }]);
      expect(await committed(runtime.harness)).toEqual([profile, [write]]);
      await expect(runtime.client.atproto.write({ writes: [{ action: "delete", collection: "space.ship.profile", rkey: "self" }] }))
        .rejects.toThrow("space.ship.profile is your profile; change it in People");
      await expect(runtime.client.atproto.write({ writes: [{ action: "delete", collection: "app.bsky.actor.profile", rkey: "self" }] }))
        .rejects.toThrow("app.bsky.actor.profile is your profile on Bluesky; change it in People");
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

      const writes = (await committed(runtime.harness)).flat();
      const records = (collection: string) => writes.flatMap((write) => write.action !== "delete" && write.collection === collection ? [write.record] : []);
      const picture = { $type: "blob", ref: { $link: expect.any(String) }, mimeType: "image/png", size: PNG.byteLength };
      expect(records("space.ship.profile")).toEqual([
        expect.not.objectContaining({ avatar: expect.anything() }),
        expect.objectContaining({ avatar: picture }),
      ]);
      const lexicons = new Lexicons([lexiconDoc.parse(profileLexicon)]);
      for (const record of records("space.ship.profile")) lexicons.assertValidRecord("space.ship.profile", jsonToLex(record));
      // Bluesky's copy shares the picture and passes the validator the open-network host applies to app.bsky.actor.profile.
      expect(records("app.bsky.actor.profile")).toEqual([
        expect.not.objectContaining({ avatar: expect.anything() }),
        expect.objectContaining({ avatar: picture, website: "https://default.gsv.space/profile" }),
      ]);
      for (const record of records("app.bsky.actor.profile")) expect(safeParse(AppBskyActorProfile.mainSchema, record)).toMatchObject({ ok: true });
    } finally { await runtime.close(); }
  });
});

describe("a takedown by the Ship's open-network host", () => {
  it("takes down the public page, and the handle with the account, tells the person why, and restores both", async () => {
    const runtime = await startProcessRuntimeHarness({ pds: true });
    try {
      await profilePublishedAtSignIn(runtime);
      const gateway = runtime.harness.getWorker("gsv");
      const status = async (path: string) => {
        const response = await gateway.fetch(`https://default.gsv.space${path}`);
        await response.body?.cancel();
        return response.status;
      };
      const { identity } = await runtime.client.atproto.identity({});
      if (!identity) throw new Error("Sign-in did not create the Ship's identity");
      expect(await status("/profile")).toBe(200);
      const { PDS } = await runtime.harness.getWorker<{ PDS: FixturePds }>("gsv").getEnv();
      const repository = await PDS.getInstallation("inst_integration_default");

      const record: PublicTakedown = {
        subject: { $type: "com.atproto.repo.strongRef", uri: `at://${identity.did}/space.ship.profile/self`, cid: "bafyrecord1" },
        ref: "audit_record", reason: "It impersonates another person", at: 1,
      };
      await repository.setTakedowns([record]);
      expect(await status("/profile")).toBe(404);
      expect(await status("/.well-known/atproto-did")).toBe(200);
      expect(await runtime.client.atproto.identity({})).toEqual({ identity, takedowns: [record] });

      const account: PublicTakedown = { subject: { $type: "com.atproto.admin.defs#repoRef", did: identity.did }, ref: "audit_account", reason: "Spam", at: 2 };
      await repository.setTakedowns([account]);
      expect(await status("/profile")).toBe(404);
      expect(await status("/.well-known/atproto-did")).toBe(404);
      expect(await runtime.client.atproto.identity({})).toEqual({ identity: { ...identity, status: "takendown" }, takedowns: [account] });

      await repository.setTakedowns([]);
      expect(await status("/profile")).toBe(200);
      expect(await (await gateway.fetch("https://default.gsv.space/.well-known/atproto-did")).text()).toBe(identity.did);
      expect(await runtime.client.atproto.identity({})).toEqual({ identity, takedowns: [] });
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
        input: `atproto put com.example.note ${rkey} --json '{"text":"hello"}'`, purpose: "Publish the note",
      } }] });
      const finish = { kind: "tool-calls" as const, calls: [{ id: "finish", name: "Send", arguments: { yield: true } }] };
      const written = { action: "put", collection: "com.example.note", rkey: "approved", record: { $type: "com.example.note", text: "hello" } };

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
