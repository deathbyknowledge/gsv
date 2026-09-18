import type { ConversationSendResult } from "@humansandmachines/gsv/protocol";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRoot, deferred } from "../../../testing/testHarness";
import { sendChatMessage } from "../backend/chatService";
import { useChatOutbox } from "./useChatOutbox";

vi.mock("../../gateway/GatewayProvider", () => ({ useGateway: () => ({ client: {} }) }));
vi.mock("../backend/chatService", () => ({ sendChatMessage: vi.fn() }));
const send = vi.mocked(sendChatMessage);

beforeEach(() => { send.mockReset(); vi.stubGlobal("document", {}); });
afterEach(() => { vi.unstubAllGlobals(); });

async function mountedOutbox() {
  const root = createTestRoot("chat outbox");
  const accepted = vi.fn();
  let current: ReturnType<typeof useChatOutbox>;
  function Harness() { current = useChatOutbox(accepted); return null; }
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
    const upload = deferred<ConversationSendResult>();
    send.mockImplementationOnce((_client, _draft, options) => {
      options?.signal?.addEventListener("abort", () => upload.reject(options.signal?.reason), { once: true });
      return upload.promise;
    });
    const outbox = await mountedOutbox();
    try {
      const file = new File(["image"], "photo.png", { type: "image/png" });
      const media = [{ body: file, filename: file.name, type: "image" as const, mimeType: file.type }];
      await act(() => { expect(outbox.current.send({ pid: "ship", conversationId: "ship-conversation",
        message: "Read this", selectedTarget: "macbook", media })).toBe(true); });
      const pending = outbox.current.messages[0]!;
      expect(pending.status).toBe("uploading");
      expect(pending.draft.media?.[0]?.body).toBe(file);
      await act(() => { expect(outbox.current.send({ pid: "helper", message: "Another message" })).toBe(false); });
      expect(send).toHaveBeenCalledTimes(1);
      await act(() => { outbox.current.cancelUpload(pending.id); });
      await vi.waitFor(() => expect(outbox.current.messages[0]?.status).toBe("failed"));
      expect(outbox.current.messages[0]?.error).toContain("Upload cancelled");

      const acknowledgement = deferred<ConversationSendResult>();
      send.mockImplementationOnce((_client, _draft, options) => {
        options?.onPrepared?.("message:one");
        options?.onUploaded?.();
        return acknowledgement.promise;
      });
      await act(() => { expect(outbox.current.retry(outbox.current.messages[0]!)).toBe(true); });
      expect(send.mock.calls[1]?.[1]).toEqual(send.mock.calls[0]?.[1]);
      expect(outbox.current.messages).toHaveLength(1);
      expect(outbox.current.messages[0]).toMatchObject({ id: pending.id, status: "sending", messageId: "message:one" });
      await act(async () => { acknowledgement.resolve(result()); await acknowledgement.promise; });
      expect(outbox.accepted).toHaveBeenCalledExactlyOnceWith(result().message);
      expect(outbox.current.messages).toEqual([]);
    } finally { await outbox.unmount(); }
  });

  it("keeps an earlier failure available when a newer message is acknowledged", async () => {
    send.mockRejectedValueOnce(new Error("Connection lost"));
    const outbox = await mountedOutbox();
    try {
      await act(() => { outbox.current.send({ pid: "ship", message: "First" }); });
      await vi.waitFor(() => expect(outbox.current.messages[0]?.status).toBe("failed"));
      const first = outbox.current.messages[0]!;
      send.mockResolvedValueOnce(result("Second"));
      await act(() => { outbox.current.send({ pid: "ship", message: "Second" }); });
      await vi.waitFor(() => expect(outbox.accepted).toHaveBeenCalledTimes(1));
      expect(outbox.current.messages).toEqual([first]);
      expect(send.mock.calls[1]?.[1].idempotencyKey).not.toBe(first.draft.idempotencyKey);
      await act(() => { outbox.current.discard(first.id); });
      expect(outbox.current.messages).toEqual([]);
    } finally { await outbox.unmount(); }
  });

  it("aborts uploads on unmount and ignores a late acknowledgement", async () => {
    const acknowledgement = deferred<ConversationSendResult>();
    send.mockReturnValueOnce(acknowledgement.promise);
    const outbox = await mountedOutbox();
    await act(() => { outbox.current.send({ pid: "ship", message: "One" }); });
    const signal = send.mock.calls[0]?.[2]?.signal;
    await outbox.unmount();
    expect(signal?.aborted).toBe(true);
    acknowledgement.resolve(result("One"));
    await acknowledgement.promise;
    expect(outbox.accepted).not.toHaveBeenCalled();
  });
});
