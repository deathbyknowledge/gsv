import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Conversation } from "./do";
import { getConversationById } from "../shared/utils";

function conversation(name: string) {
  return getConversationById("singleton", `conv:test:${name}:${crypto.randomUUID()}`);
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

describe("Conversation Durable Object", () => {
  it("stores canonical messages idempotently and rejects changed replays", async () => {
    const stub = conversation("append");
    await stub.initialize({ ownerUid: 1000, kind: "home" });

    const first = await stub.append(message(1));
    const replay = await stub.append(message(1));
    expect(first.created).toBe(true);
    expect(replay).toEqual({ message: first.message, created: false });
    await expect(runInDurableObject(stub, (instance: Conversation) => (
      instance.append({ ...message(1), text: "changed" })
    ))).rejects.toThrow("idempotency key payload changed");

    const history = await stub.history();
    expect(history.messages).toEqual([first.message]);
    expect(history.latestSequence).toBe(1);
    expect(history.hasMore).toBe(false);
  });

  it("moves old messages to immutable R2 segments without changing pagination", async () => {
    const stub = conversation("archive");
    await stub.initialize({ ownerUid: 1000, kind: "home" });
    for (let index = 1; index <= 1_001; index += 1) {
      await stub.append(message(index));
    }
    await stub.compact();

    const latest = await stub.history({ limit: 2 });
    expect(latest.messages.map((item) => item.text)).toEqual(["message 1000", "message 1001"]);
    expect(latest.hasMore).toBe(true);
    const archived = await stub.history({ beforeSequence: 3, limit: 2 });
    expect(archived.messages.map((item) => item.text)).toEqual(["message 1", "message 2"]);
    expect(await stub.append(message(1))).toEqual({
      message: archived.messages[0],
      created: false,
    });
  }, 30_000);

  it("copies process media into conversation ownership before recording it", async () => {
    const stub = conversation("media");
    await stub.initialize({ ownerUid: 1000, kind: "home" });
    const sourceKey = "var/media/1001/proc:test/image";
    await env.STORAGE.put(sourceKey, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
    });

    const appended = await stub.append({
      ...message(1),
      media: [{ type: "image", mimeType: "image/png", key: sourceKey, path: `/${sourceKey}` }],
      mediaOwner: { pid: "proc:test", uid: 1001, gid: 1001, home: "/home/agent" },
    });
    const media = appended.message.media?.[0];
    expect(media?.conversationId).toBe(appended.message.conversationId);
    expect(media?.key).toMatch(/^conversations\/.*\/media\//);
    expect(media?.path).toBeUndefined();

    await env.STORAGE.delete(sourceKey);
    const stored = await stub.readMedia({ key: media!.key! });
    expect(stored.mimeType).toBe("image/png");
    expect(stored.size).toBe(3);
    expect([...new Uint8Array(await new Response(stored.stream).arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("stores one immutable resource reference without copying its bytes", async () => {
    const stub = conversation("resource");
    await stub.initialize({ ownerUid: 1000, kind: "home" });
    const suffix = crypto.randomUUID().replaceAll("-", "").repeat(2);
    const key = `home/agent/.gsv/media/archived-media:${suffix}`;
    await env.STORAGE.put(key, new Uint8Array([4, 5, 6]), {
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
    const object = await env.STORAGE.head(key);
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
    const copies = await env.STORAGE.list({
      prefix: `conversations/${encodeURIComponent(appended.message.conversationId)}/media/`,
    });
    expect(copies.objects).toHaveLength(0);
    const retained = await env.STORAGE.get(key);
    expect(retained && [...new Uint8Array(await retained.arrayBuffer())]).toEqual([4, 5, 6]);
    await env.STORAGE.delete(key);
  });

  it("cannot read a different conversation's media", async () => {
    const first = conversation("first-media");
    const second = conversation("second-media");
    await first.initialize({ ownerUid: 1000, kind: "home" });
    await second.initialize({ ownerUid: 1000, kind: "work" });
    await expect(runInDurableObject(second, (instance: Conversation) => (
      instance.readMedia({ key: "conversations/conv%3Aother/media/msg/0" })
    ))).rejects.toThrow("Conversation media key is invalid");
  });
});
