import { GSVClient } from "@humansandmachines/gsv/client";
import type { ConversationSendResult } from "@humansandmachines/gsv/protocol";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestRoot, deferred } from "../../../testing/testHarness";
import { useChatOutboxRuntime } from "./useChatOutbox";

beforeEach(() => { vi.stubGlobal("document", {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mountedOutbox(client: GSVClient) {
  const root = createTestRoot("chat outbox");
  const accepted = vi.fn();
  let current: ReturnType<typeof useChatOutboxRuntime>;
  function Harness() { current = useChatOutboxRuntime(accepted, client); return null; }
  await root.render(<Harness />);
  return { get current() { return current; }, accepted, unmount: () => root.unmount() };
}

function result(text = "Read this"): ConversationSendResult {
  return { message: { id: "message:one", conversationId: "ship-conversation", sequence: 1,
    author: { kind: "user", uid: 1000 }, text, origin: { kind: "client" }, createdAt: 1 },
    handlerPid: "ship", runId: "run:one" };
}

describe("pending chat sends", () => {
  it("retains files, target and idempotency through a cancelled upload and retry", async () => {
    const client = new GSVClient();
    const upload = deferred<Awaited<ReturnType<GSVClient["request"]>>>();
    const acknowledgement = deferred<ConversationSendResult>();
    const send = vi.spyOn(client.conversation, "send").mockReturnValue(acknowledgement.promise);
    let uploadCount = 0;
    let uploadSignal: AbortSignal | undefined;
    const paths: string[] = [];
    const request = vi.spyOn(client, "request").mockImplementation(async (call, args, options) => {
      const { path } = z.object({ path: z.string() }).parse(args);
      if (call === "fs.transfer.receive") {
        paths.push(path);
        if (uploadCount++ === 0) {
          uploadSignal = options?.signal;
          uploadSignal?.addEventListener("abort", () => upload.resolve({ data: { ok: false, error: "Upload cancelled" } }), { once: true });
          return upload.promise;
        }
        return { data: { ok: true, path, bytesWritten: 5 } };
      }
      if (call === "fs.transfer.stat") return { data: { ok: true, path, isFile: true, size: 5, contentType: "image/png", revision: "file-revision" } };
      if (call === "fs.delete") return { data: { ok: true } };
      throw new Error(`Unexpected request ${call}`);
    });
    const outbox = await mountedOutbox(client);
    try {
      const file = new File(["image"], "photo.png", { type: "image/png" });
      const media = [{ body: file, filename: file.name, type: "image" as const, mimeType: file.type }];
      await act(() => { expect(outbox.current.send({ pid: "ship", conversationId: "ship-conversation",
        message: "Read this", selectedTarget: "macbook", media })).toBe(true); });
      const pending = outbox.current.messages[0]!;
      expect(pending.status).toBe("uploading");
      expect(pending.draft.media?.[0]?.body).toBe(file);
      await act(() => { expect(outbox.current.send({ pid: "helper", message: "Another message" })).toBe(false); });
      await vi.waitFor(() => expect(uploadSignal).toBeDefined());
      await act(() => { outbox.current.cancelUpload(pending.id); });
      expect(uploadSignal?.aborted).toBe(true);
      await vi.waitFor(() => expect(outbox.current.messages[0]?.status).toBe("failed"));
      expect(outbox.current.messages[0]?.error).toContain("Upload cancelled");
      expect(request).toHaveBeenCalledWith("fs.delete", { path: paths[0] });
      expect(send).not.toHaveBeenCalled();

      await act(() => { expect(outbox.current.retry(outbox.current.messages[0]!)).toBe(true); });
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: "Read this", selectedTarget: "macbook",
        idempotencyKey: pending.draft.idempotencyKey, media: [expect.objectContaining({ filename: "photo.png" })] }));
      expect(paths).toEqual([paths[0], paths[0]]);
      expect(outbox.current.messages).toHaveLength(1);
      expect(outbox.current.messages[0]).toMatchObject({ id: pending.id, status: "sending" });
      await act(async () => { acknowledgement.resolve(result()); await acknowledgement.promise; });
      await vi.waitFor(() => expect(outbox.accepted).toHaveBeenCalledExactlyOnceWith(result().message));
      expect(outbox.current.messages).toEqual([]);
    } finally { await outbox.unmount(); }
  });

  it("keeps an earlier failure available when a newer message is acknowledged", async () => {
    const client = new GSVClient();
    const send = vi.spyOn(client.conversation, "send").mockRejectedValueOnce(new Error("Connection lost"));
    const outbox = await mountedOutbox(client);
    try {
      await act(() => { outbox.current.send({ pid: "ship", conversationId: "ship-conversation", message: "First" }); });
      await vi.waitFor(() => expect(outbox.current.messages[0]?.status).toBe("failed"));
      const first = outbox.current.messages[0]!;
      send.mockResolvedValueOnce(result("Second"));
      await act(() => { outbox.current.send({ pid: "ship", conversationId: "ship-conversation", message: "Second" }); });
      await vi.waitFor(() => expect(outbox.accepted).toHaveBeenCalledTimes(1));
      expect(outbox.current.messages).toEqual([first]);
      expect(send.mock.calls[1]?.[0].idempotencyKey).not.toBe(first.draft.idempotencyKey);
      await act(() => { outbox.current.discard(first.id); });
      expect(outbox.current.messages).toEqual([]);
    } finally { await outbox.unmount(); }
  });

  it("ignores an acknowledgement arriving after unmount", async () => {
    const client = new GSVClient();
    const acknowledgement = deferred<ConversationSendResult>();
    const send = vi.spyOn(client.conversation, "send").mockReturnValueOnce(acknowledgement.promise);
    const outbox = await mountedOutbox(client);
    await act(() => { outbox.current.send({ pid: "ship", conversationId: "ship-conversation", message: "One" }); });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await outbox.unmount();
    acknowledgement.resolve(result("One"));
    await acknowledgement.promise;
    expect(outbox.accepted).not.toHaveBeenCalled();
  });
});
