import { useEffect, useRef } from "preact/hooks";
import type { GSVClient } from "@humansandmachines/gsv/client";
import { committedSignalSchema } from "../chat/hooks/useChatConversation";
import { useNativeSpeech, type SpeechLanguage } from "./NativeSpeech";
import { speechChunks } from "./speechText";

export function useSpokenReplies(client: Pick<GSVClient, "onSignal">, conversationId: string | undefined, connected: boolean, language: SpeechLanguage | null) {
  const speech = useNativeSpeech();
  const current = useRef(speech);
  current.current = speech;
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (!conversationId) return;
    seen.current.clear();
    current.current?.typed();
    return () => { void current.current?.command({ kind: "cancel" }); };
  }, [conversationId]);
  useEffect(() => {
    if (!speech || !connected || !conversationId) return;
    // Only live canonical commits enter speech. History loads, drafts and Process records never do.
    return client.onSignal((signal, payload) => {
      if (signal !== "message.committed") return;
      const parsed = committedSignalSchema.safeParse(payload);
      if (!parsed.success) return;
      const { message } = parsed.data;
      if (message.conversationId !== conversationId || message.author.kind !== "process" || seen.current.has(message.id)) return;
      seen.current.add(message.id);
      if (seen.current.size > 2048) seen.current.delete(seen.current.values().next().value!);
      const voice = current.current;
      if (!voice?.shouldSpeak() || !language) return;
      const chunks = speechChunks(message.text, language);
      if (chunks.length) void voice.command({ kind: "speak", id: message.id, chunks, language });
    });
  }, [client, conversationId, connected, !!speech, language]);
}
