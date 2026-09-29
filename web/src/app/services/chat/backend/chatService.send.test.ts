import { describe, expect, it, vi } from "vitest";
import { GSVClient } from "@humansandmachines/gsv/client";
import type { ConversationSendResult } from "@humansandmachines/gsv/protocol";
import { conversationSendMessageId } from "@humansandmachines/gsv/protocol/stable-id";
import { sendChatMessage } from "./chatService";

describe("chat message target context", () => {
  it("sends the optional target as metadata while preserving user text and retry identity", async () => {
    const client = new GSVClient();
    const result: ConversationSendResult = {
      message: { id: "message", conversationId: "conversation", sequence: 1, author: { kind: "user", uid: 1000 },
        text: "Clean up my downloads.", selectedTarget: "macbook", origin: { kind: "client" }, createdAt: 1 },
      handlerPid: "ship", runId: "run",
    };
    const send = vi.spyOn(client.conversation, "send").mockResolvedValue(result);
    const draft = { pid: "ship", conversationId: "conversation", message: "Clean up my downloads.", idempotencyKey: "retry" };
    await expect(sendChatMessage(client, { ...draft, selectedTarget: "macbook" })).resolves.toEqual(result);
    expect(send).toHaveBeenLastCalledWith({ conversationId: "conversation", text: draft.message, selectedTarget: "macbook", idempotencyKey: "retry" });
    await sendChatMessage(client, draft);
    expect(send.mock.calls.at(-1)?.[0].selectedTarget).toBeUndefined();
  });

  it("provides the exact committed message identity before dispatching the send", async () => {
    const client = new GSVClient();
    const draft = { pid: "ship", message: "Read this", idempotencyKey: "one-send" };
    vi.spyOn(client.conversation, "forProcess").mockResolvedValue({ conversation: {
      id: "resolved-ship", kind: "ship", ownerUid: 1000, handlerPid: "ship", title: null,
      latestSequence: 0, createdAt: 1, updatedAt: 1,
    } });
    const prepared = vi.fn();
    const expectedId = await conversationSendMessageId("resolved-ship", "one-send");
    const send = vi.spyOn(client.conversation, "send").mockImplementation(async () => {
      expect(prepared).toHaveBeenCalledExactlyOnceWith(expectedId);
      throw new Error("Connection lost before acknowledgement");
    });
    await expect(sendChatMessage(client, draft, { onPrepared: prepared })).rejects.toThrow("Connection lost");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "resolved-ship", idempotencyKey: "one-send" }));
  });
});
