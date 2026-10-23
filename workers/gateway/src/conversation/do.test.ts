import { env } from "cloudflare:workers";
import { createInstallationStorage } from "../installation/storage";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ArchivedMessage, Conversation } from "./do";
import type { ConversationMessage, SocialMessageMetadata } from "@humansandmachines/gsv/protocol";
import { getConversationById } from "../shared/utils";
import { ConversationStore } from "./store";

function conversation(name: string) {
  return getConversationById("inst_test", `conv:test:${name}:${crypto.randomUUID()}`);
}

function message(sequence: number) {
  return {
    messageId: `msg:${sequence}`,
    idempotencyKey: `input:${sequence}`,
    author: { kind: "user" as const, uid: 1000 },
    text: `message ${sequence}`,
    origin: { kind: "client" as const, clientId: "test" },
    processId: "proc:test",
    runId: `run:${sequence}`,
    createdAt: 1_700_000_000_000 + sequence,
  };
}

/** Archives `message` as one segment holding `stored`, the shape an older release wrote. */
async function archiveAs(stub: ReturnType<typeof conversation>, message: ConversationMessage, stored: ArchivedMessage) {
  const bytes = new TextEncoder().encode(JSON.stringify([stored]));
  const checksum = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
  const compressed = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  const key = `conversations/${encodeURIComponent(message.conversationId)}/segments/legacy.json.gz`;
  await createInstallationStorage(env.STORAGE, "inst_test").put(key, compressed, { customMetadata: { checksum } });
  await runInDurableObject(stub, (_instance: Conversation, state) => {
    state.storage.transactionSync(() => new ConversationStore(state.storage.sql).commitArchive({
      segmentId: "legacy", fromSequence: message.sequence, toSequence: message.sequence, messageCount: 1,
      objectKey: key, checksum, createdAt: message.createdAt,
    }, [message]));
  });
  return { key, compressed, checksum };
}

describe("Conversation Durable Object", () => {
  it("searches literal words and prefixes with stable pagination and plain snippets", async () => {
    const stub = conversation("search");
    await stub.initialize({ ownerUid: 1000, kind: "ship" });
    for (const [index, text] of ["Rotterdam concerts", "Rotterdam events <script>quoted</script>", "Café in Rotterdam", "Unrelated Berlin"].entries()) {
      await stub.append({ ...message(index), text });
    }
    const first = await stub.search({ query: "rotter", limit: 2 });
    expect(first.hits.map((hit) => hit.sequence)).toEqual([3, 2]);
    expect(first.hits[1].snippet).toBe("Rotterdam events <script>quoted</script>");
    expect(first.nextBeforeSequence).toBe(2);
    const next = await stub.search({ query: "rotter", beforeSequence: first.nextBeforeSequence!, limit: 2 });
    expect(next.hits.map((hit) => hit.sequence)).toEqual([1]);
    expect(next.nextBeforeSequence).toBeNull();
    expect((await stub.search({ query: "cafe rotter" })).hits.map((hit) => hit.sequence)).toEqual([3]);
    expect((await stub.search({ query: 'Rotterdam OR Berlin' })).hits).toEqual([]);
    expect((await stub.search({ query: '" OR "' })).hits).toEqual([]);
    await expect(runInDurableObject(stub, (instance: Conversation) => instance.search({ query: " " }))).rejects.toThrow("Search requires");
    await expect(runInDurableObject(stub, (instance: Conversation) => instance.search({ query: "r".repeat(257) }))).rejects.toThrow("Search requires");
    await expect(runInDurableObject(stub, (instance: Conversation) => instance.search({ query: "Rotterdam", limit: 51 }))).rejects.toThrow("Search limit");
  });

  it("discards only unaccepted intake history and keeps a durable fence against late appends", async () => {
    const stub = conversation("intake-retention");
    await stub.initialize({ ownerUid: 1000, kind: "contact", intakeId: "approach:expired" });
    await stub.append(message(1));
    expect((await stub.search({ query: "message" })).hits).toHaveLength(1);
    await stub.discardIntake({ ownerUid: 1000, id: "approach:expired" });
    await stub.discardIntake({ ownerUid: 1000, id: "approach:expired" });
    await evictDurableObject(stub);
    await expect(runInDurableObject(stub, (instance: Conversation) => instance.append(message(1)))).rejects.toThrow("expired");
    await expect(runInDurableObject(stub, (instance: Conversation) => instance.initialize({ ownerUid: 1000, kind: "contact" }))).rejects.toThrow("expired");
    await expect(runInDurableObject(stub, (instance: Conversation) => instance.search({ query: "message" }))).rejects.toThrow("expired");
    await runInDurableObject(stub, (_instance: Conversation, state) => {
      for (const table of ["messages", "message_receipts", "message_origins", "message_search"]) {
        expect(state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).one().count).toBe(0);
      }
    });

    const accepted = conversation("accepted-intake");
    await accepted.initialize({ ownerUid: 1000, kind: "contact", intakeId: "approach:accepted" });
    await accepted.append(message(1));
    await accepted.initialize({ ownerUid: 1000, kind: "contact" });
    await expect(runInDurableObject(accepted, (instance: Conversation) => instance.discardIntake({ ownerUid: 1000, id: "approach:accepted" }))).rejects.toThrow("not an unaccepted");
    expect((await accepted.history()).messages).toHaveLength(1);
  });

  it("measures the bounded first-message index and metadata footprint", async () => {
    const stub = conversation("intake-capacity");
    await stub.initialize({ ownerUid: 1000, kind: "contact", intakeId: "approach:capacity" });
    const measurement = await runInDurableObject(stub, async (instance: Conversation, state) => {
      const before = state.storage.sql.databaseSize;
      await instance.append({ ...message(1), text: "request detail ".repeat(2184).slice(0, 32_768) });
      return { before, after: state.storage.sql.databaseSize };
    });
    expect(measurement.after - measurement.before).toBeLessThan(256 * 1024);
    console.info("first-contact Conversation capacity (fixture bytes)", measurement);
  });

  it("stores canonical messages idempotently and rejects changed replays", async () => {
    const stub = conversation("append");
    await stub.initialize({ ownerUid: 1000, kind: "ship" });

    const first = await stub.append(message(1));
    const replay = await stub.append(message(1));
    expect(first.created).toBe(true);
    expect(replay).toEqual({ message: first.message, created: false });
    await expect(runInDurableObject(stub, (instance: Conversation) => (
      instance.append({ ...message(1), text: "changed" })
    ))).rejects.toThrow("idempotency key payload changed");
    await expect(runInDurableObject(stub, (instance: Conversation) => (
      instance.append({ ...message(1), selectedTarget: "macbook" })
    ))).rejects.toThrow("idempotency key payload changed");

    const history = await stub.history();
    expect(history.messages).toEqual([first.message]);
    expect(history.latestSequence).toBe(1);
    expect(history.hasMore).toBe(false);
    expect((await stub.search({ query: "message" })).hits).toHaveLength(1);
  });

  it("builds a bounded preview around a match without storing a text copy in the index", async () => {
    const stub = conversation("snippet");
    await stub.initialize({ ownerUid: 1000, kind: "ship" });
    await stub.append({ ...message(1), text: `${"e\u0301🙂 ".repeat(200)}A café in Rotterdam.${" more context".repeat(100)}` });
    const result = await stub.search({ query: "cafe" });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].snippet).toContain("A café in Rotterdam.");
    expect([...result.hits[0].snippet].length).toBeLessThanOrEqual(362);
    expect(result.hits[0].snippet.startsWith("…")).toBe(true);
    expect(result.hits[0].snippet.endsWith("…")).toBe(true);
  });

  it("moves old messages to immutable R2 segments without changing pagination", async () => {
    const stub = conversation("archive");
    await stub.initialize({ ownerUid: 1000, kind: "ship" });
    const social: SocialMessageMetadata = {
      threadId: "thread:one", reference: { did: "did:plc:oneaaaaaaaaaaaaaaaaaaaaa", messageId: "origin:one" },
      provenance: { kind: "human" },
    };
    await runInDurableObject(stub, async (instance: Conversation) => {
      for (let index = 1; index <= 1_001; index += 1) {
        await instance.append({ ...message(index), selectedTarget: index === 1 ? "macbook" : undefined, social: index === 1 ? social : undefined });
      }
    });
    await stub.compact();

    const latest = await stub.history({ limit: 2 });
    expect(latest.messages.map((item) => item.text)).toEqual(["message 1000", "message 1001"]);
    expect(latest.hasMore).toBe(true);
    const archived = await stub.history({ beforeSequence: 3, limit: 2 });
    expect(archived.messages.map((item) => item.text)).toEqual(["message 1", "message 2"]);
    expect(archived.messages[0]?.selectedTarget).toBe("macbook");
    expect(archived.messages[1]?.selectedTarget).toBeUndefined();
    const aroundArchiveBoundary = await stub.history({ afterSequence: 498, limit: 4 });
    expect(aroundArchiveBoundary.messages.map((message) => message.sequence)).toEqual([499, 500, 501, 502]);
    expect(aroundArchiveBoundary.hasMore).toBe(true);
    expect((await stub.history({ afterSequence: 1_000, limit: 4 })).messages.map((message) => message.sequence)).toEqual([1_001]);
    expect(await stub.append({ ...message(1), selectedTarget: "macbook", social })).toEqual({
      message: archived.messages[0],
      created: false,
    });
    expect((await stub.search({ query: "message 1", beforeSequence: 2 })).hits).toEqual([{
      id: "msg:1", sequence: 1, author: archived.messages[0].author,
      createdAt: archived.messages[0].createdAt, snippet: "message 1",
    }]);

    await runInDurableObject(stub, async (_instance: Conversation, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'message_search_content'").toArray()).toEqual([]);
      const constrained = new ConversationStore(state.storage.sql, 0);
      for (let sequence = 1_002; sequence <= 1_021; sequence++) {
        state.storage.transactionSync(() => constrained.append({ ...message(sequence), payloadHash: "fixture" }));
      }
    });
    expect((await stub.search({ query: "message 1", beforeSequence: 2 })).hits).toEqual([]);
    expect((await stub.history({ beforeSequence: 3, limit: 2 })).messages).toEqual(archived.messages);
    expect(await stub.append({ ...message(1), selectedTarget: "macbook", social }))
      .toEqual({ message: archived.messages[0], created: false });
    expect((await stub.search({ query: "message 1", beforeSequence: 2 })).hits).toEqual([]);
    expect(archived.messages[0]?.social).toEqual(social);
    expect(await stub.resolveOrigin(social.reference, social.threadId)).toEqual({ messageId: "msg:1", sequence: 1 });
    expect(await stub.resolveOrigin(social.reference, "thread:other")).toBeNull();
    expect(await stub.append({ ...message(1), selectedTarget: "macbook", social })).toEqual({
      message: archived.messages[0],
      created: false,
    });
    await expect(runInDurableObject(stub, (instance: Conversation) => instance.append({
      ...message(1), selectedTarget: "macbook", social: { ...social, provenance: { kind: "process", processId: "proc:forged" } },
    }))).rejects.toThrow("idempotency key payload changed");
  }, 30_000);

  it("reads experimental archive text without exposing retired metadata or rewriting bytes", async () => {
    const stub = conversation("legacy-request-archive");
    await stub.initialize({ ownerUid: 1000, kind: "ship" });
    const input = { ...message(1), text: "Help me create a routine.\n\nOnly on Mondays.", selectedTarget: "gsv" };
    const appended = await stub.append(input);
    const { key, compressed, checksum } = await archiveAs(stub, appended.message, { ...appended.message, action: { kind: "routine.create", note: "Only on Mondays." } });
    const storage = createInstallationStorage(env.STORAGE, "inst_test");

    const history = await stub.history();
    expect(history.messages).toEqual([appended.message]);
    expect(history.messages[0]).not.toHaveProperty("action");
    expect((await stub.history({ afterSequence: 0 })).messages).toEqual(history.messages);
    expect(await stub.append(input)).toEqual({ created: false, message: appended.message });
    expect(await (await storage.get(key))!.arrayBuffer()).toEqual(compressed);
    expect((await storage.head(key))?.customMetadata?.checksum).toBe(checksum);
  });

  it("reads a contact's archive from before DIDs without its Ship's ids", async () => {
    const stub = conversation("archive-before-dids");
    await stub.initialize({ ownerUid: 1000, kind: "contact" });
    const author = { kind: "contact" as const, contactId: "contact:mara", displayName: "Mara" };
    const appended = await stub.append({ ...message(1), author, text: "Before the move" });
    await archiveAs(stub, appended.message, {
      ...appended.message,
      author: { ...author, shipId: "ship:mara", subjectId: "subject:mara" },
      social: {
        threadId: "thread:mara", reference: { actor: { shipId: "ship:mara", subjectId: "subject:mara" }, messageId: "origin:mara" },
        provenance: { kind: "human" },
      },
    });
    expect((await stub.history()).messages).toEqual([appended.message]);
  });

  it("keeps origin details from before DIDs hot until the move names them", async () => {
    const stub = conversation("awaiting-move");
    await stub.initialize({ ownerUid: 1000, kind: "contact" });
    const segments = () => runInDurableObject(stub, (_instance: Conversation, state) =>
      state.storage.sql.exec("SELECT segment_id FROM archive_segments").toArray().length);
    await runInDurableObject(stub, (_instance: Conversation, state) => {
      for (let sequence = 1; sequence <= 1_001; sequence++) {
        state.storage.sql.exec(`INSERT INTO messages (message_id, idempotency_key, author_json, text, origin_json, created_at, legacy_social_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, `msg:${sequence}`, `input:${sequence}`, JSON.stringify(message(sequence).author), `message ${sequence}`,
        JSON.stringify({ kind: "client" }), sequence, sequence === 1 ? "{\"reference\":{\"actor\":{}}}" : null);
      }
    });
    await stub.compact();
    expect(await segments()).toBe(0);
    await runInDurableObject(stub, (_instance: Conversation, state) => {
      state.storage.sql.exec("UPDATE messages SET legacy_social_json = NULL");
    });
    await stub.compact();
    expect(await segments()).toBe(1);
  });

  it("keeps legacy conversation-owned media readable", async () => {
    const stub = conversation("legacy-media");
    await stub.initialize({ ownerUid: 1000, kind: "ship" });
    const appended = await stub.append(message(1));
    const key = `conversations/${encodeURIComponent(appended.message.conversationId)}/media/legacy/0`;
    await createInstallationStorage(env.STORAGE, "inst_test").put(key, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
      customMetadata: {
        purpose: "conversation-media",
        conversationId: appended.message.conversationId,
      },
    });

    const stored = await stub.readMedia({ key });
    expect(stored.mimeType).toBe("image/png");
    expect(stored.size).toBe(3);
    expect([...new Uint8Array(await new Response(stored.stream).arrayBuffer())]).toEqual([1, 2, 3]);
    await createInstallationStorage(env.STORAGE, "inst_test").delete(key);
  });

  it("stores one immutable resource reference without copying its bytes", async () => {
    const stub = conversation("resource");
    await stub.initialize({ ownerUid: 1000, kind: "ship" });
    const suffix = crypto.randomUUID().replaceAll("-", "").repeat(2);
    const key = `home/agent/.gsv/media/archived-media:${suffix}`;
    await createInstallationStorage(env.STORAGE, "inst_test").put(key, new Uint8Array([4, 5, 6]), {
      httpMetadata: { contentType: "image/png" },
      customMetadata: {
        purpose: "resource",
        uid: "1001",
        gid: "1001",
        mode: "400",
        sourceEtag: "source-revision",
        sourceContentType: "image/png",
      },
    });
    const object = await createInstallationStorage(env.STORAGE, "inst_test").head(key);
    if (!object) throw new Error("resource fixture was not stored");
    const resource = {
      type: "resource" as const,
      ref: {
        type: "file" as const,
        target: "gsv",
        path: `/${key}`,
        revision: object.httpEtag,
        contentType: "image/png",
        size: 3,
      },
      mediaType: "image" as const,
      filename: "proof.png",
    };

    const appended = await stub.append({
      ...message(1),
      media: [resource],
      mediaOwner: { pid: "proc:test", uid: 1001, gid: 1001, home: "/home/agent" },
    });

    expect(appended.message.media).toEqual([resource]);
    const copies = await createInstallationStorage(env.STORAGE, "inst_test").list({
      prefix: `conversations/${encodeURIComponent(appended.message.conversationId)}/media/`,
    });
    expect(copies.objects).toHaveLength(0);
    const retained = await createInstallationStorage(env.STORAGE, "inst_test").get(key);
    expect(retained && [...new Uint8Array(await retained.arrayBuffer())]).toEqual([4, 5, 6]);
    await createInstallationStorage(env.STORAGE, "inst_test").delete(key);
  });

  it("cannot read a different conversation's media", async () => {
    const first = conversation("first-media");
    const second = conversation("second-media");
    await first.initialize({ ownerUid: 1000, kind: "ship" });
    await second.initialize({ ownerUid: 1000, kind: "work" });
    await expect(runInDurableObject(second, (instance: Conversation) => (
      instance.readMedia({ key: "conversations/conv%3Aother/media/msg/0" })
    ))).rejects.toThrow("Conversation media key is invalid");
  });
});
