import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ConversationMessageAuthor } from "@humansandmachines/gsv/protocol";
import type { PublicRepository } from "@humansandmachines/gsv/services/pds";
import type { OperatorPersonDid } from "@humansandmachines/gsv/services/operator";
import { hashPassword, makeShadowEntry } from "../../auth/shadow";
import type { ConversationMoveInput, ConversationMoveResult } from "../../conversation/do";
import { getKernelByInstallationId } from "../../installation/routing";
import { runSqlMigrations } from "../../schema/runner";
import * as utils from "../../shared/utils";
import { APPROACH_RECEIPT_MS } from "../approach-store";
import type { Kernel } from "../do";
import { federationPayloadHash } from "../federation";
import { FederationStore } from "../federation-store";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "../schema/migrations";

const OWNER = { username: "hank", uid: 1000, gid: 1000, gecos: "Hank", home: "/home/hank", shell: "/bin/init" };
const did = (letter: string) => `did:plc:${letter.repeat(24)}`;
const HANK = { shipId: "ship:hank", subjectId: "subject:hank", did: did("h"), handle: "hank.ship.test" };
const MARA = { shipId: "ship:mara", subjectId: "subject:mara", did: did("m"), handle: "mara.ship.test" };
const RUTH = { shipId: "ship:ruth", subjectId: "subject:ruth", did: did("r"), handle: "ruth.ship.test" };
const LEE = { shipId: "ship:lee", subjectId: "subject:lee", did: did("l"), handle: "lee.ship.test" };
const KIM = { shipId: "ship:kim", subjectId: "subject:kim", did: did("k"), handle: "kim.ship.test" };
const SAM = { shipId: "ship:sam", subjectId: "subject:sam", did: did("s"), handle: "sam.ship.test" };
/** Someone whose Ship is on another deployment, so they have no DID here. */
const FAR = { shipId: "ship:far", subjectId: "subject:far" };
const PEOPLE: OperatorPersonDid[] = [HANK, MARA, RUTH, LEE, KIM, SAM];
type OldName = { shipId: string; subjectId: string };
const actor = (person: OldName) => ({ shipId: person.shipId, subjectId: person.subjectId });

afterEach(async () => {
  await reset();
  vi.restoreAllMocks();
});

describe("the move to DIDs", () => {
  it("names each person by DID, ends what names anyone without one, and resumes the deliveries it moved", async () => {
    const { kernel } = await shipBeforeDids(seedHank, { did: HANK.did });
    const conversations = conversationsReporting(new Map([
      ["federation:contact:mara:gen:mara:delivery:in-reply", 12],
      ["federation-local:delivery:first-version", 9],
    ]));
    const before = Date.now();
    await runInDurableObject(kernel, async (instance: Kernel, state) => {
      const delivery = vi.spyOn(instance.federationRuntime, "scheduleFederationDelivery");
      const inbox = vi.spyOn(instance.federationRuntime, "scheduleFederationInbox");
      const move = await instance.operatorIdentityMove(PEOPLE);
      expect(move).toEqual({
        version: 1,
        installationId: instance.installationId,
        moved: { contacts: 3, blocks: 1, requests: 3, deliveries: 6, messages: 4 },
        ended: { contacts: 2, blocks: 2, requests: 3, deliveries: 2, messages: 1 },
      });

      // Each conversation names its own people, and hears which pending appends it already holds.
      expect(conversations.get("conv:mara")).toEqual({
        people: [HANK, MARA],
        idempotencyKeys: [
          "federation:contact:mara:gen:mara:delivery:in-first",
          "federation:contact:mara:gen:mara:delivery:in-reply",
          "federation-local:delivery:first-version",
          "federation-local:delivery:photo",
        ].sort(),
      });
      expect(conversations.get("conv:far")).toEqual({ people: [HANK], idempotencyKeys: [] });

      const sql = state.storage.sql;
      expect(sql.exec("SELECT contact_id, owner_uid, state, remote_did, remote_handle FROM federation_contacts ORDER BY contact_id").toArray()).toEqual([
        { contact_id: "contact:far", owner_uid: 1000, state: "revoked", remote_did: null, remote_handle: null },
        { contact_id: "contact:lee", owner_uid: 1000, state: "active", remote_did: LEE.did, remote_handle: LEE.handle },
        { contact_id: "contact:mara", owner_uid: 1000, state: "active", remote_did: MARA.did, remote_handle: MARA.handle },
        // Another account's contact ends: only the Ship's person has a DID.
        { contact_id: "contact:root-mara", owner_uid: 0, state: "revoked", remote_did: null, remote_handle: null },
        { contact_id: "contact:ruth", owner_uid: 1000, state: "revoked", remote_did: RUTH.did, remote_handle: RUTH.handle },
      ]);
      expect(sql.exec("SELECT owner_uid, did, display_name, created_at FROM federation_actor_blocks").toArray())
        .toEqual([{ owner_uid: 1000, did: RUTH.did, display_name: "Ruth", created_at: 7 }]);

      const requests = new Map(sql.exec<{
        approach_id: string; request_id: string; remote_did: string; remote_handle: string | null; state: string; revision: number;
        message_id: string; sent_at: number; pending_text: string | null; delivery_state: string; attempts: number;
        next_attempt_at: number | null; accepted_at: number | null; cleanup_at: number | null; profile_cid: string | null;
      }>(`SELECT approach_id, request_id, remote_did, remote_handle, state, revision, message_id, sent_at, pending_text, delivery_state,
        attempts, next_attempt_at, accepted_at, cleanup_at, profile_cid FROM social_approaches`).toArray().map((row) => [row.approach_id, row]));
      expect([...requests.keys()].sort()).toEqual(["approach:from-kim", "approach:from-lee", "approach:to-ruth", "approach:to-sam"]);
      // The other person never received it, so it expires where its sender sees it.
      const toSam = requests.get("approach:to-sam")!;
      expect(toSam).toMatchObject({
        request_id: "request:to-sam", remote_did: SAM.did, remote_handle: SAM.handle, state: "expired", revision: 2,
        message_id: "msg:to-sam", sent_at: 50, pending_text: null, next_attempt_at: null, profile_cid: null,
      });
      expect(toSam.cleanup_at).toBeGreaterThanOrEqual(before + APPROACH_RECEIPT_MS);
      expect(requests.get("approach:to-ruth")).toMatchObject({
        remote_did: RUTH.did, state: "pending", revision: 1, delivery_state: "received", pending_text: "Hello again",
      });
      // The connection it made has moved, so the acceptance is done.
      expect(requests.get("approach:from-lee")).toMatchObject({
        remote_did: LEE.did, state: "accepted", revision: 3, delivery_state: "received", attempts: 0, next_attempt_at: null,
      });
      expect(requests.get("approach:from-lee")?.accepted_at).toBeGreaterThanOrEqual(before);
      // No connection yet: the acceptance runs again over DIDs, now.
      const fromKim = requests.get("approach:from-kim")!;
      expect(fromKim).toMatchObject({ remote_did: KIM.did, state: "accepting", revision: 2, attempts: 0 });
      expect(fromKim.next_attempt_at).toBeGreaterThanOrEqual(before);

      const outbox = new Map(sql.exec<{
        delivery_id: string; state: string; payload_json: string | null; preparation_json: string | null;
        local_message_json: string | null; local_sequence: number | null; updated_at: number;
      }>("SELECT delivery_id, state, payload_json, preparation_json, local_message_json, local_sequence, updated_at FROM federation_outbox")
        .toArray().map((row) => [row.delivery_id, row]));
      expect([...outbox.keys()].sort()).toEqual(["delivery:first-version", "delivery:goodbye", "delivery:photo", "delivery:reply"]);
      const reply = outbox.get("delivery:reply")!;
      const replySocial = {
        threadId: "thread:mara",
        reference: { did: HANK.did, messageId: "msg:reply" },
        provenance: { kind: "process", processId: "proc:ship" },
        replyTo: { did: MARA.did, messageId: "msg:mara-1" },
      };
      expect(JSON.parse(reply.payload_json!)).toEqual({
        kind: "message", messageId: "msg:reply", threadId: "thread:mara", text: "Sounds good", social: replySocial,
      });
      expect(JSON.parse(reply.local_message_json!).social).toEqual(replySocial);
      expect([reply.local_sequence, reply.updated_at]).toEqual([4, 20]);
      // A Ship of the first version named no origin: the delivery reads as its person's, and the local copy keeps its author.
      const firstVersion = outbox.get("delivery:first-version")!;
      expect(JSON.parse(firstVersion.payload_json!).social).toEqual({
        threadId: "thread:mara", reference: { did: HANK.did, messageId: "msg:first-version" }, provenance: { kind: "human" },
      });
      expect(JSON.parse(firstVersion.local_message_json!).social).toEqual({
        threadId: "thread:mara", reference: { did: HANK.did, messageId: "msg:first-version" }, provenance: { kind: "human" },
      });
      // Its conversation already holds it, so it is not appended again.
      expect(firstVersion.local_sequence).toBe(9);
      expect(firstVersion.updated_at).toBeGreaterThanOrEqual(before);
      const photo = outbox.get("delivery:photo")!;
      expect([photo.state, photo.payload_json, photo.local_sequence]).toEqual(["preparing", null, null]);
      expect(JSON.parse(photo.preparation_json!).localMessage.social).toEqual({
        threadId: "thread:mara", reference: { did: HANK.did, messageId: "msg:photo" }, provenance: { kind: "process", processId: "proc:ship" },
      });
      expect(JSON.parse(outbox.get("delivery:goodbye")!.payload_json!)).toEqual({ kind: "contact.revoked" });

      const received = new Map(sql.exec<{ delivery_id: string; state: string; payload_hash: string; payload_json: string; committed_at: number | null }>(
        "SELECT delivery_id, state, payload_hash, payload_json, committed_at FROM federation_inbox",
      ).toArray().map((row) => [row.delivery_id, row]));
      expect([...received.keys()].sort()).toEqual(["delivery:in-first", "delivery:in-reply"]);
      const inReply = received.get("delivery:in-reply")!;
      expect(inReply.state).toBe("committed");
      expect(inReply.committed_at).toBeGreaterThanOrEqual(before);
      expect(JSON.parse(inReply.payload_json).social).toEqual({
        threadId: "thread:mara", reference: { did: MARA.did, messageId: "msg:mara-2" }, provenance: { kind: "human" },
        replyTo: { did: HANK.did, messageId: "msg:reply" },
      });
      const inFirst = received.get("delivery:in-first")!;
      expect(inFirst.state).toBe("received");
      expect(JSON.parse(inFirst.payload_json).social).toEqual({
        threadId: "thread:mara", reference: { did: MARA.did, messageId: "msg:mara-3" }, provenance: { kind: "human" },
      });
      for (const row of received.values()) expect(row.payload_hash).toBe(await federationPayloadHash(JSON.parse(row.payload_json)));

      for (const table of LEGACY_TABLES) expect(sql.exec(`SELECT COUNT(*) AS count FROM ${table}`).one().count).toBe(0);
      expect(state.storage.kv.get("federation_identity_v1")).toBeUndefined();
      expect(new FederationStore(state.storage).awaitingMove()).toBe(false);
      for (const deliveryId of ["delivery:reply", "delivery:first-version", "delivery:photo", "delivery:goodbye"]) {
        expect(delivery).toHaveBeenCalledWith(deliveryId, expect.any(Number), true);
      }
      expect(inbox).toHaveBeenCalledExactlyOnceWith("contact:mara", "gen:mara", "delivery:in-first", expect.any(Number), true);

      // A finished move changes nothing.
      const rows = snapshot(sql);
      expect(await instance.operatorIdentityMove(PEOPLE)).toEqual({
        version: 1,
        installationId: instance.installationId,
        moved: { contacts: 0, blocks: 0, requests: 0, deliveries: 0, messages: 0 },
        ended: { contacts: 0, blocks: 0, requests: 0, deliveries: 0, messages: 0 },
      });
      expect(snapshot(sql)).toEqual(rows);
    });
  });

  it("refuses a move that names the Ship's person with another DID, and changes nothing", async () => {
    const { kernel } = await shipBeforeDids(seedHank, { did: HANK.did });
    const conversations = conversationsReporting(new Map());
    await runInDurableObject(kernel, async (instance: Kernel, state) => {
      const rows = snapshot(state.storage.sql);
      await expect(instance.operatorIdentityMove([{ ...HANK, did: did("x") }, MARA])).rejects.toThrow("another DID");
      await expect(instance.operatorIdentityMove([MARA])).rejects.toThrow("another DID");
      expect(conversations.size).toBe(0);
      expect(snapshot(state.storage.sql)).toEqual(rows);
      expect(state.storage.kv.get("federation_identity_v1")).toBeDefined();
    });
  });

  it("leaves a delivery received before the move matching its sender's copy", async () => {
    // Mara's Ship sent both before the move; Hank's received them. Each Ship moves its own copy.
    const v1 = { kind: "message", messageId: "msg:shared-1", threadId: "thread:shared", text: "From before origins" };
    const v2 = {
      kind: "message", messageId: "msg:shared-2", threadId: "thread:shared", text: "Written by my Ship",
      social: {
        threadId: "thread:shared", reference: { actor: actor(MARA), messageId: "msg:shared-2" },
        provenance: { kind: "process", processId: "proc:mara-ship" }, replyTo: { actor: actor(HANK), messageId: "msg:hank-1" },
      },
    };
    const revoked = { kind: "contact.revoked", generation: "gen:shared" };
    const sender = await shipBeforeDids((sql) => {
      account(sql, MARA);
      contact(sql, { id: "contact:to-hank", owner: 1000, remote: HANK, conversation: "conv:to-hank", thread: "thread:shared", generation: "gen:shared" });
      for (const [deliveryId, payload] of [["delivery:shared-1", v1], ["delivery:shared-2", v2], ["delivery:shared-3", revoked]] as const) {
        const local = payload.kind === "message"
          ? localMessage(payload.messageId, payload.text, { kind: "process", pid: "proc:mara-ship", uid: 1000 })
          : null;
        outbox(sql, { id: deliveryId, contact: "contact:to-hank", generation: "gen:shared", payload, local, localSequence: 1 });
      }
    }, { did: MARA.did, person: MARA });
    const recipient = await shipBeforeDids((sql) => {
      account(sql, HANK);
      contact(sql, { id: "contact:from-mara", owner: 1000, remote: MARA, conversation: "conv:from-mara", thread: "thread:shared", generation: "gen:shared" });
      for (const [deliveryId, payload] of [["delivery:shared-1", v1], ["delivery:shared-2", v2], ["delivery:shared-3", revoked]] as const) {
        inbox(sql, { contact: "contact:from-mara", generation: "gen:shared", delivery: deliveryId, payload, state: "received" });
      }
    }, { did: HANK.did, person: HANK });
    conversationsReporting(new Map());
    const people = [HANK, MARA];
    const sent = await runInDurableObject(sender.kernel, async (instance: Kernel, state) => {
      await instance.operatorIdentityMove(people);
      return state.storage.sql.exec<{ delivery_id: string; payload_json: string }>("SELECT delivery_id, payload_json FROM federation_outbox ORDER BY delivery_id").toArray();
    });
    const kept = await runInDurableObject(recipient.kernel, async (instance: Kernel, state) => {
      await instance.operatorIdentityMove(people);
      return state.storage.sql.exec<{ delivery_id: string; payload_hash: string }>("SELECT delivery_id, payload_hash FROM federation_inbox ORDER BY delivery_id").toArray();
    });
    expect(sent.map((row) => row.delivery_id)).toEqual(["delivery:shared-1", "delivery:shared-2", "delivery:shared-3"]);
    const hashes = await Promise.all(sent.map(async (row) => ({ delivery_id: row.delivery_id, payload_hash: await federationPayloadHash(JSON.parse(row.payload_json)) })));
    expect(kept).toEqual(hashes);
  });
});

describe("the survey before the move", () => {
  it("names the Ship's person and everyone its rows name the old way, and gives the Ship its DID", async () => {
    const { kernel } = await shipBeforeDids((sql) => {
      seedHank(sql);
      publishedProfileBeforeRecords(sql);
    });
    conversationsReporting(new Map());
    await runInDurableObject(kernel, async (instance: Kernel) => {
      const repository = withRepository(instance);
      const survey = await instance.operatorIdentitySurvey(true);
      expect(survey).toEqual({
        version: 1,
        installationId: instance.installationId,
        person: HANK,
        references: [FAR, KIM, LEE, MARA, RUTH, SAM].map(actor),
        waiting: { contacts: 5, blocks: 3, requests: 6, deliveries: 8 },
        otherAccounts: 1,
      });
      expect(repository.ensureAccount).toHaveBeenCalledExactlyOnceWith("hank.ship.test");
      expect(instance.shipIdentity.current()).toBe(HANK.did);
      // A profile published before profiles were records is written to the repository, so it stays public.
      expect(repository.applyWrites).toHaveBeenCalledExactlyOnceWith([{
        action: "put", collection: "space.ship.profile", rkey: "self",
        record: { $type: "space.ship.profile", displayName: "Hank", about: "Hello", contactPolicy: "requests" },
      }]);
      // A second survey finds the same, and publishes nothing again.
      expect(await instance.operatorIdentitySurvey(true)).toEqual(survey);
      expect(repository.applyWrites).toHaveBeenCalledOnce();
    });
  });

  it("gives a restricted Ship its DID but publishes nothing for it", async () => {
    const { kernel } = await shipBeforeDids((sql) => {
      seedHank(sql);
      publishedProfileBeforeRecords(sql);
    });
    await runInDurableObject(kernel, async (instance: Kernel) => {
      const repository = withRepository(instance);
      expect((await instance.operatorIdentitySurvey(false)).person).toEqual(HANK);
      expect(repository.applyWrites).not.toHaveBeenCalled();
    });
  });

  it("finds nothing waiting on a Ship that never had contacts", async () => {
    const { kernel } = await shipBeforeDids(() => {}, { identity: false });
    await runInDurableObject(kernel, async (instance: Kernel) => {
      const repository = withRepository(instance);
      expect(await instance.operatorIdentitySurvey(true)).toEqual({
        version: 1,
        installationId: instance.installationId,
        person: null,
        references: [],
        waiting: { contacts: 0, blocks: 0, requests: 0, deliveries: 0 },
        otherAccounts: 0,
      });
      expect(repository.ensureAccount).not.toHaveBeenCalled();
    });
  });
});

const LEGACY_TABLES = [
  "federation_contacts_legacy", "federation_actor_blocks_legacy", "social_approaches_legacy",
  "federation_outbox_legacy", "federation_inbox_legacy",
];

/**
 * Hank's Ship before DIDs. Mara, Lee and Ruth are contacts (Ruth's removed),
 * someone on another deployment is a contact too, and root has its own contact
 * with Mara. Hank blocked Ruth and the far person; root blocked Mara. Requests:
 * one to Sam never delivered, one to Ruth delivered, Lee's accepted with its
 * connection made, Kim's being accepted, and two from people without a DID here.
 */
function seedHank(sql: SqlStorage): void {
  account(sql, HANK);
  contact(sql, { id: "contact:mara", owner: 1000, remote: MARA, conversation: "conv:mara", thread: "thread:mara", generation: "gen:mara" });
  contact(sql, { id: "contact:lee", owner: 1000, remote: LEE, conversation: "conv:lee", thread: "thread:lee", generation: "gen:lee" });
  contact(sql, { id: "contact:ruth", owner: 1000, remote: RUTH, conversation: "conv:ruth", thread: "thread:ruth", generation: "gen:ruth", revoked: true });
  contact(sql, { id: "contact:far", owner: 1000, remote: FAR, conversation: "conv:far", thread: "thread:far", generation: "gen:far" });
  contact(sql, { id: "contact:root-mara", owner: 0, remote: MARA, conversation: "conv:root-mara", thread: "thread:root-mara", generation: "gen:root" });
  for (const [conversationId, ownerUid] of [["conv:sam", 1000], ["conv:ruth-again", 1000], ["conv:kim", 1000], ["conv:far-request", 1000], ["conv:root-request", 0]] as const) {
    conversation(sql, conversationId, ownerUid);
  }
  block(sql, 1000, RUTH, "Ruth", 7);
  block(sql, 1000, FAR, "Far", 8);
  block(sql, 0, MARA, "Mara", 9);

  approach(sql, { id: "approach:to-sam", direction: "outgoing", remote: SAM, conversation: "conv:sam", state: "pending", delivery: "queued" });
  approach(sql, { id: "approach:to-ruth", direction: "outgoing", remote: RUTH, conversation: "conv:ruth-again", state: "pending", delivery: "received" });
  approach(sql, { id: "approach:from-lee", direction: "incoming", remote: LEE, conversation: "conv:lee", contact: "contact:lee", generation: "gen:lee", state: "accepting", revision: 2, delivery: "unconfirmed" });
  approach(sql, { id: "approach:from-kim", direction: "incoming", remote: KIM, conversation: "conv:kim", state: "accepting", revision: 2, delivery: "unconfirmed", attempts: 4 });
  approach(sql, { id: "approach:from-far", direction: "incoming", remote: FAR, conversation: "conv:far-request", state: "pending", delivery: "unconfirmed" });
  approach(sql, { id: "approach:root-from-mara", owner: 0, direction: "incoming", remote: MARA, conversation: "conv:root-request", state: "pending", delivery: "unconfirmed" });

  const replySocial = {
    threadId: "thread:mara", reference: { actor: actor(HANK), messageId: "msg:reply" },
    provenance: { kind: "process", processId: "proc:ship" }, replyTo: { actor: actor(MARA), messageId: "msg:mara-1" },
  };
  const shipAuthor: ConversationMessageAuthor = { kind: "process", pid: "proc:ship", uid: 1000 };
  outbox(sql, {
    id: "delivery:reply", contact: "contact:mara", generation: "gen:mara", wireVersion: 2,
    payload: { kind: "message", messageId: "msg:reply", threadId: "thread:mara", text: "Sounds good", social: replySocial },
    local: { ...localMessage("msg:reply", "Sounds good", shipAuthor), social: replySocial }, localSequence: 4,
  });
  outbox(sql, {
    id: "delivery:first-version", contact: "contact:mara", generation: "gen:mara",
    payload: { kind: "message", messageId: "msg:first-version", threadId: "thread:mara", text: "Hi" },
    local: localMessage("msg:first-version", "Hi", { kind: "user", uid: 1000 }), localSequence: null,
  });
  outbox(sql, {
    id: "delivery:photo", contact: "contact:mara", generation: "gen:mara", state: "preparing",
    preparation: {
      kind: "message", messageId: "msg:photo", threadId: "thread:mara", text: "A photo", resources: [],
      localMessage: localMessage("msg:photo", "A photo", shipAuthor),
    },
  });
  outbox(sql, { id: "delivery:goodbye", contact: "contact:ruth", generation: "gen:ruth", payload: { kind: "contact.revoked", generation: "gen:ruth" } });
  outbox(sql, {
    id: "delivery:far", contact: "contact:far", generation: "gen:far",
    payload: { kind: "message", messageId: "msg:far", threadId: "thread:far", text: "Far away" }, localSequence: 2,
  });

  inbox(sql, {
    contact: "contact:mara", generation: "gen:mara", delivery: "delivery:in-reply", state: "received", payload: {
      kind: "message", messageId: "msg:mara-2", threadId: "thread:mara", text: "See you then",
      social: {
        threadId: "thread:mara", reference: { actor: actor(MARA), messageId: "msg:mara-2" }, provenance: { kind: "human" },
        replyTo: { actor: actor(HANK), messageId: "msg:reply" },
      },
    },
  });
  inbox(sql, {
    contact: "contact:mara", generation: "gen:mara", delivery: "delivery:in-first", state: "received",
    payload: { kind: "message", messageId: "msg:mara-3", threadId: "thread:mara", text: "From an older Ship" },
  });
  inbox(sql, {
    contact: "contact:far", generation: "gen:far", delivery: "delivery:in-far", state: "committed",
    payload: { kind: "message", messageId: "msg:far-1", threadId: "thread:far", text: "Hello from afar" },
  });
}

/**
 * A Kernel whose storage holds the rows from before DIDs, migrated as the
 * release finds them, then started afresh. `did` remembers the Ship's DID as an
 * earlier survey left it; `identity: false` leaves out the old key.
 */
async function shipBeforeDids(
  seed: (sql: SqlStorage) => void,
  options: { did?: string; identity?: boolean; person?: OldName } = {},
) {
  const installationId = `inst_identity_move_${crypto.randomUUID().replaceAll("-", "")}`;
  const kernel = await getKernelByInstallationId(env.KERNEL, installationId);
  const person = options.person ?? HANK;
  await runInDurableObject(kernel, async (_instance: Kernel, state) => {
    await state.storage.deleteAlarm();
    await state.storage.deleteAll();
    runSqlMigrations(state.storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 74));
    seed(state.storage.sql);
    runKernelSqlMigrations(state.storage);
    if (options.identity !== false) {
      state.storage.kv.put("federation_identity_v1", { privateKey: { kty: "EC" }, document: { shipId: person.shipId } });
    }
  });
  await evictDurableObject(kernel);
  await runInDurableObject(kernel, async (instance: Kernel) => {
    await instance.ensureInstallationIdentity({
      installationId,
      handle: person === HANK ? "hank" : "mara",
      canonicalOrigin: person === HANK ? "https://hank.ship.test" : "https://mara.ship.test",
    });
    instance.auth.addUser({ ...OWNER, username: person === HANK ? "hank" : "mara" });
    instance.auth.setShadow(makeShadowEntry(person === HANK ? "hank" : "mara", await hashPassword("identity-move-fixture")));
    if (options.did) instance.shipIdentity.remember(options.did);
  });
  return { kernel, installationId };
}

/** Fakes each contact conversation's move, recording what it was given; `appended` names the appends a conversation holds. */
function conversationsReporting(appended: ReadonlyMap<string, number>): Map<string, ConversationMoveInput> {
  const moves = new Map<string, ConversationMoveInput>();
  vi.spyOn(utils, "getConversationById").mockImplementation((_installationId, conversationId) => {
    const moveToDids = async (input: ConversationMoveInput): Promise<ConversationMoveResult> => {
      moves.set(conversationId, { ...input, idempotencyKeys: [...input.idempotencyKeys].sort() });
      return {
        moved: conversationId === "conv:mara" ? 4 : 0,
        ended: conversationId === "conv:far" ? 1 : 0,
        appended: input.idempotencyKeys.flatMap((idempotencyKey) => {
          const sequence = appended.get(idempotencyKey);
          return sequence === undefined ? [] : [{ idempotencyKey, sequence }];
        }),
      };
    };
    // SAFETY: the move reaches a contact conversation only through moveToDids.
    return { moveToDids } as never;
  });
  return moves;
}

/** The Ship's repository on the open-network host, which creates its account on the first ensureAccount. */
function withRepository(instance: Kernel) {
  let created: Awaited<ReturnType<PublicRepository["account"]>> = null;
  const repository = {
    account: vi.fn<PublicRepository["account"]>(async () => created),
    ensureAccount: vi.fn<PublicRepository["ensureAccount"]>(async (handle) => (created = { did: HANK.did, handle, host: "https://pds.ship.test" })),
    serviceAuth: vi.fn<PublicRepository["serviceAuth"]>(),
    applyWrites: vi.fn<PublicRepository["applyWrites"]>(async (writes) => ({
      commit: { cid: "bafycommit", rev: "3l2" },
      results: writes.map((write) => ({ uri: `at://${HANK.did}/${write.collection}/${write.rkey}`, cid: "bafyprofile" })),
    })),
    uploadBlob: vi.fn<PublicRepository["uploadBlob"]>(),
    readBlob: vi.fn<PublicRepository["readBlob"]>(),
    [Symbol.dispose]: vi.fn(),
  };
  const previous = instance.env.PDS;
  // SAFETY: the survey reaches the open-network host only through getInstallation.
  instance.env.PDS = { getInstallation: async () => repository } as never;
  onTestFinished(() => { instance.env.PDS = previous; });
  return repository;
}

/** Every row the move writes, to show that a refused or repeated move leaves them as they were. */
function snapshot(sql: SqlStorage) {
  return Object.fromEntries([
    ...LEGACY_TABLES, "federation_contacts", "federation_actor_blocks", "social_approaches", "federation_outbox", "federation_inbox",
  ].map((table) => [table, sql.exec(`SELECT * FROM ${table} ORDER BY 1, 2, 3`).toArray()]));
}

function account(sql: SqlStorage, person: OldName): void {
  sql.exec("INSERT INTO federation_subjects (owner_uid, subject_id, display_name, created_at, updated_at) VALUES (1000, ?, 'Person', 1, 1)", person.subjectId);
}

function conversation(sql: SqlStorage, conversationId: string, ownerUid: number): void {
  sql.exec("INSERT INTO conversations (conversation_id, owner_uid, kind, created_at, updated_at) VALUES (?, ?, 'contact', 1, 1)", conversationId, ownerUid);
}

function contact(sql: SqlStorage, input: {
  id: string; owner: number; remote: OldName; conversation: string; thread: string; generation: string; revoked?: boolean;
}): void {
  conversation(sql, input.conversation, input.owner);
  sql.exec(`INSERT INTO federation_contacts (
    contact_id, owner_uid, state, generation, remote_ship_id, remote_subject_id, remote_display_name,
    remote_origin, remote_public_key_json, shared_secret, conversation_id, thread_id, created_at, updated_at, revoked_at
  ) VALUES (?, ?, ?, ?, ?, ?, 'Remote', 'https://remote.example', '{}', 'fixture-secret', ?, ?, 1, 2, ?)`,
  input.id, input.owner, input.revoked ? "revoked" : "active", input.generation, input.remote.shipId, input.remote.subjectId,
  input.conversation, input.thread, input.revoked ? 3 : null);
}

function block(sql: SqlStorage, ownerUid: number, person: OldName, displayName: string, createdAt: number): void {
  sql.exec("INSERT INTO federation_actor_blocks (owner_uid, ship_id, subject_id, display_name, created_at) VALUES (?, ?, ?, ?, ?)",
    ownerUid, person.shipId, person.subjectId, displayName, createdAt);
}

function approach(sql: SqlStorage, input: {
  id: string; owner?: number; direction: "incoming" | "outgoing"; remote: OldName; conversation: string;
  contact?: string; generation?: string; state: string; revision?: number; delivery: string; attempts?: number;
}): void {
  const name = input.id.slice("approach:".length);
  const origin = input.direction === "outgoing" ? HANK : input.remote;
  const metadata = {
    reference: { actor: actor(origin), approachId: `request:${name}` }, recipient: actor(input.direction === "outgoing" ? input.remote : HANK),
    profileRevision: 1, displayName: "Sender", messageId: `msg:${name}`, createdAtMs: 50, expiresAtMs: 9_999_999_999_999,
  };
  sql.exec(`INSERT INTO social_approaches (
    approach_id, owner_uid, direction, origin_ship_id, origin_subject_id, origin_id, remote_ship_id, remote_subject_id,
    remote_origin, remote_public_key_json, remote_display_name, local_display_name, conversation_id, contact_id, thread_id,
    state, revision, fingerprint, metadata_json, pending_text, pending_text_bytes, setup_token_hash, contact_generation,
    delivery_state, attempts, next_attempt_at, created_at, updated_at, expires_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'https://remote.example', '{}', 'Remote', 'Local', ?, ?, ?, ?, ?, 'hash', ?, ?, ?, ?, ?, ?, ?, NULL, 1, 2, 9999999999999)`,
  input.id, input.owner ?? 1000, input.direction, origin.shipId, origin.subjectId, `request:${name}`,
  input.remote.shipId, input.remote.subjectId, input.conversation, input.contact ?? `contact:${name}`, `thread:${name}`,
  input.state, input.revision ?? 1, JSON.stringify(metadata), name === "to-ruth" ? "Hello again" : null, name === "to-ruth" ? 11 : 0,
  `token:${input.id}`, input.generation ?? null, input.delivery, input.attempts ?? 0);
}

function localMessage(messageId: string, text: string, author: ConversationMessageAuthor) {
  return { messageId, text, author, origin: { kind: "client" }, createdAtMs: 5 };
}

function outbox(sql: SqlStorage, input: {
  id: string; contact: string; generation: string; state?: string; wireVersion?: number;
  payload?: object; preparation?: object; local?: object | null; localSequence?: number | null;
}): void {
  sql.exec(`INSERT INTO federation_outbox (
    delivery_id, owner_uid, contact_id, contact_generation, idempotency_key, fingerprint, payload_json, preparation_json,
    local_message_json, local_sequence, state, created_at, updated_at, wire_version
  ) VALUES (?, 1000, ?, ?, ?, 'hash', ?, ?, ?, ?, ?, 10, 20, ?)`,
  input.id, input.contact, input.generation, `key:${input.id}`,
  input.payload ? JSON.stringify(input.payload) : null, input.preparation ? JSON.stringify(input.preparation) : null,
  input.local ? JSON.stringify(input.local) : null, input.localSequence ?? null, input.state ?? "pending", input.wireVersion ?? 1);
}

function inbox(sql: SqlStorage, input: { contact: string; generation: string; delivery: string; state: string; payload: object }): void {
  sql.exec(`INSERT INTO federation_inbox (
    contact_id, contact_generation, delivery_id, payload_hash, payload_json, state, received_at, updated_at, committed_at, wire_version
  ) VALUES (?, ?, ?, 'hash:before', ?, ?, 30, 31, ?, 2)`,
  input.contact, input.generation, input.delivery, JSON.stringify(input.payload), input.state, input.state === "committed" ? 32 : null);
}

/** Hank's profile as published before profiles were records: a signed profile the release turns into a pending record. */
function publishedProfileBeforeRecords(sql: SqlStorage): void {
  const fields = { displayName: "Hank", about: "Hello", contactPolicy: "requests" };
  sql.exec(`INSERT INTO social_profiles (owner_uid, subject_id, revision, draft_json, published_alias, published_revision, published_json)
    VALUES (1000, ?, 1, ?, 'hank', 1, ?)`, HANK.subjectId, JSON.stringify(fields), JSON.stringify(fields));
}
