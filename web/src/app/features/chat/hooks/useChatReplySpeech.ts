import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { createPresenceSpeechOutput } from "../../presence/speechOutput";
import type { ChatTranscriptRow } from "../domain/transcript";

type UseChatReplySpeechArgs = {
  conversationId?: string | null;
  processId: string;
  rows: readonly ChatTranscriptRow[];
};

const CHAT_SPEAK_REPLIES_STORAGE_KEY = "gsv.chat.speakReplies";

function loadSpeakRepliesPreference(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(CHAT_SPEAK_REPLIES_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function saveSpeakRepliesPreference(enabled: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(CHAT_SPEAK_REPLIES_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Local storage can be unavailable in private or restricted browser contexts.
  }
}

function latestSpeakableAssistantRow(
  rows: readonly ChatTranscriptRow[],
): ChatTranscriptRow | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (
      row.role === "assistant"
      && row.text.trim().length > 0
      && row.status !== "error"
      && row.status !== "streaming"
      && !row.streaming
    ) {
      return row;
    }
  }
  return null;
}

function speechKey(
  row: ChatTranscriptRow,
  processId: string,
  conversationId: string | null | undefined,
): string {
  return [
    processId,
    conversationId ?? "default",
    row.runId ?? "",
    row.messageId ?? "",
    row.id,
    row.text.length,
  ].join(":");
}

export function useChatReplySpeech({
  conversationId,
  processId,
  rows,
}: UseChatReplySpeechArgs) {
  const { client } = useGateway();
  const [speakReplies, setSpeakRepliesState] = useState(loadSpeakRepliesPreference);
  const [speechStatus, setSpeechStatus] = useState(() => speakReplies ? "Speak replies on" : "Speech off");
  const speakRepliesRef = useRef(speakReplies);
  const destroyedRef = useRef(false);
  const lastSpokenKeyRef = useRef("");

  useEffect(() => {
    speakRepliesRef.current = speakReplies;
  }, [speakReplies]);

  const speechOutput = useMemo(() => createPresenceSpeechOutput({
    gatewayClient: client,
    getSpeakReplies: () => speakRepliesRef.current,
    isDestroyed: () => destroyedRef.current,
    setSpeechStatus,
  }), [client]);

  useEffect(() => {
    destroyedRef.current = false;
    return () => {
      destroyedRef.current = true;
      speechOutput.cancel();
    };
  }, [speechOutput]);

  useEffect(() => {
    lastSpokenKeyRef.current = "";
    speechOutput.cancel(speakRepliesRef.current ? "Speak replies on" : "Speech off");
  }, [conversationId, processId, speechOutput]);

  useEffect(() => {
    if (!speakReplies) {
      speechOutput.cancel("Speech off");
      return;
    }
    setSpeechStatus("Speak replies on");
  }, [speakReplies, speechOutput]);

  useEffect(() => {
    const row = latestSpeakableAssistantRow(rows);
    if (!row || !processId) {
      return;
    }
    const key = speechKey(row, processId, conversationId);
    if (!speakReplies) {
      lastSpokenKeyRef.current = key;
      return;
    }
    if (lastSpokenKeyRef.current === key) {
      return;
    }
    lastSpokenKeyRef.current = key;
    void speechOutput.speakReply(row.text);
  }, [conversationId, processId, rows, speakReplies, speechOutput]);

  const setSpeakReplies = useCallback((enabled: boolean) => {
    setSpeakRepliesState(enabled);
    saveSpeakRepliesPreference(enabled);
    if (!enabled) {
      speechOutput.cancel("Speech off");
      return;
    }
    const row = latestSpeakableAssistantRow(rows);
    if (row && processId) {
      lastSpokenKeyRef.current = speechKey(row, processId, conversationId);
    }
    setSpeechStatus("Speak replies on");
  }, [conversationId, processId, rows, speechOutput]);

  const cancelSpeech = useCallback(() => {
    speechOutput.cancel();
  }, [speechOutput]);

  const isSpeaking = useCallback(() => {
    return speechOutput.isPlaying();
  }, [speechOutput]);

  return {
    cancelSpeech,
    isSpeaking,
    setSpeakReplies,
    speakReplies,
    speechStatus,
  };
}
