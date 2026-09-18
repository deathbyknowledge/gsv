import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ConversationMessage } from "@humansandmachines/gsv/protocol";
import { sendChatMessage } from "../backend/chatService";
import type { ChatSendDraft } from "../domain/processes";
import { useGateway } from "../../gateway/GatewayProvider";
import { randomId } from "../../ids";

export type OutgoingChatMessage = {
  id: string;
  draft: ChatSendDraft;
  createdAt: number;
  status: "uploading" | "sending" | "failed";
  messageId?: string;
  error?: string;
};

/** Own pending sends until acknowledgement; retries retain the original recipient, files and send identity. */
export function useChatOutbox(acceptMessage: (message: ConversationMessage) => void) {
  const { client } = useGateway();
  return useChatOutboxRuntime(acceptMessage, client);
}

export function useChatOutboxRuntime(
  acceptMessage: (message: ConversationMessage) => void,
  client: Parameters<typeof sendChatMessage>[0],
) {
  const [messages, setMessages] = useState<OutgoingChatMessage[]>([]);
  const active = useRef<{ id: string; controller: AbortController } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.controller.abort(new Error("Upload cancelled"));
    };
  }, []);

  const dispatch = useCallback((message: OutgoingChatMessage) => {
    if (active.current) return false;
    const pending = { id: message.id, controller: new AbortController() };
    active.current = pending;
    const update = (patch: Partial<OutgoingChatMessage>) => {
      if (mounted.current) setMessages((current) => current.map((row) => row.id === message.id ? { ...row, ...patch } : row));
    };
    setMessages((current) => [
      ...current.filter((row) => row.id !== message.id),
      { ...message, status: message.draft.media?.length ? "uploading" : "sending", error: undefined },
    ]);
    void (async () => {
      try {
        const result = await sendChatMessage(client, message.draft, {
          signal: pending.controller.signal,
          onPrepared: (messageId) => update({ messageId }),
          onUploaded: () => update({ status: "sending" }),
        });
        if (mounted.current) {
          acceptMessage(result.message);
          setMessages((current) => current.filter((row) => row.id !== message.id));
        }
      } catch (error) {
        update({ status: "failed", error: error instanceof Error ? error.message : "The message did not go through." });
      } finally {
        if (active.current === pending) active.current = null;
      }
    })();
    return true;
  }, [acceptMessage, client]);

  const send = useCallback((draft: ChatSendDraft) => {
    const id = randomId();
    return dispatch({ id, draft: { ...draft, idempotencyKey: id }, createdAt: Date.now(), status: "sending" });
  }, [dispatch]);

  const retry = useCallback((message: OutgoingChatMessage) => {
    if (message.status !== "failed") return false;
    return dispatch(message);
  }, [dispatch]);

  const cancelUpload = useCallback((id: string) => {
    if (active.current?.id === id) active.current.controller.abort(new Error("Upload cancelled. You can retry this message."));
  }, []);

  const discard = useCallback((id: string) => {
    if (active.current?.id === id) return;
    setMessages((current) => current.filter((row) => row.id !== id));
  }, []);

  return { messages, send, retry, cancelUpload, discard, sending: messages.some((row) => row.status !== "failed") };
}
