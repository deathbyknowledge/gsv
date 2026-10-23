import { bodyFromBytes, bodyToBytes, type PublicRecordWrite } from "@humansandmachines/gsv/protocol";
import { describe, expect, it } from "vitest";
import { startProcessRuntimeHarness } from "./process-runtime-harness";

/** The fixture PDS as these tests read it back: each installation's committed batches of writes. */
type FixturePds = { getInstallation(installationId: string): Promise<{ commits(): Promise<PublicRecordWrite[][]> }> };

const NOTE = { action: "put" as const, collection: "space.ship.note", rkey: "first", record: { $type: "space.ship.note", text: "hello" } };

describe("publishing to the open network", () => {
  it("lets the signed-in person publish directly, creating the Ship's identity on the first write", async () => {
    const runtime = await startProcessRuntimeHarness({ pds: true });
    try {
      expect(await runtime.client.atproto.identity({})).toEqual({ identity: null });
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
      expect(commit.results).toEqual([{ uri: "at://did:plc:dddddddddddddddddddddddd/space.ship.note/first", cid: "bafyrecord1" }]);
      expect(await runtime.client.atproto.identity({})).toEqual({
        identity: { did: "did:plc:dddddddddddddddddddddddd", handle: "default.gsv.space", host: "https://pds.gsv.space" },
      });
      expect(await committed(runtime.harness)).toEqual([[write]]);
      await expect(runtime.client.atproto.write({ writes: [{ action: "delete", collection: "space.ship.profile", rkey: "self" }] }))
        .rejects.toThrow("space.ship.profile is your profile; change it in People");
      expect(await committed(runtime.harness)).toHaveLength(1);
    } finally { await runtime.close(); }
  });
});

describe("the Ship publishing to the open network", () => {
  it("asks first, even when other tools run without asking, and writes only what the person approves", async () => {
    const runtime = await startProcessRuntimeHarness({ pds: true });
    try {
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
        expect(await committed(runtime.harness)).toEqual([]);
        expect(await runtime.client.proc.hil({ pid: ship.pid, requestId: history.pendingHil.requestId, decision })).toMatchObject({ ok: true });
        await runtime.waitFor(async () => {
          const state = await runtime.client.proc.history({ pid: ship.pid, includeMessages: false });
          return state.ok && state.activeRunId === null;
        }, `the ${rkey} run to finish`, 15000);
        if (decision === "deny") {
          expect(await committed(runtime.harness)).toEqual([]);
          expect(await runtime.client.atproto.identity({})).toEqual({ identity: null });
        }
      }
      expect(await committed(runtime.harness)).toEqual([[written]]);
    } finally { await runtime.close(); }
  });
});

/** The write batches the fixture PDS committed for the harness installation. */
async function committed(harness: Awaited<ReturnType<typeof startProcessRuntimeHarness>>["harness"]) {
  const { PDS } = await harness.getWorker<{ PDS: FixturePds }>("gsv").getEnv();
  const repository = await PDS.getInstallation("inst_integration_default");
  return await repository.commits();
}
