import { createContext, type ComponentChildren } from "preact";
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { useQuery } from "@tanstack/preact-query";
import { useGateway } from "../gateway/GatewayProvider";
import { useChatOutbox } from "../chat/hooks/useChatOutbox";
import { consoleConfigQueryKey } from "../system/useConsoleData";
import { useNativeInput } from "./PlatformProvider";
import { useNativeSpeech, type SpeechLanguage } from "./NativeSpeech";
import { useNativeVoice, type VoiceComposer } from "./useNativeVoice";
import { useSpokenReplies } from "./useSpokenReplies";

export type ComposerVoiceOptions = Pick<Parameters<typeof useNativeVoice>[0], "prompt" | "scope" | "enabled" | "send">;
type Composer = { owner: symbol; options: { current: ComposerVoiceOptions } };
type Recipient = { pid: string; conversationId: string };
type Capture = ({ kind: "composer" } & Composer) | { kind: "handsfree" };
type VoiceControl = ReturnType<typeof useNativeVoice>;
type VoiceSession = {
  input: VoiceControl;
  capture: Capture | null;
  text: string;
  connected: boolean;
  language: SpeechLanguage | null;
  languageError: string | null;
  outbox: ReturnType<typeof useChatOutbox>;
  startComposer(composer: Composer): void;
  releaseComposer(owner: symbol): void;
  edit(text: string): void;
  discard(): void;
  send(): void;
};
const Context = createContext<VoiceSession | null>(null);
export const useNativeVoiceSession = () => useContext(Context);

/** One authenticated desktop session owns input, independently of the visible page. */
export function NativeVoiceSession({ children, onDirtyChange }: {
  children: ComponentChildren; onDirtyChange(dirty: boolean): void;
}) {
  const input = useNativeInput();
  return input ? <VoiceSessionOwner onDirtyChange={onDirtyChange}>{children}</VoiceSessionOwner> : <>{children}</>;
}

function VoiceSessionOwner({ children, onDirtyChange }: {
  children: ComponentChildren; onDirtyChange(dirty: boolean): void;
}) {
  const { client, connected } = useGateway();
  const speech = useNativeSpeech();
  const [capture, publishCapture] = useState<Capture | null>(null);
  const captureRef = useRef(capture);
  const setCapture = useCallback((value: Capture | null) => { captureRef.current = value; publishCapture(value); }, []);
  const [text, publishText] = useState("");
  const textRef = useRef("");
  const recipient = useRef<Recipient | null>(null);
  const setText = useCallback((value: string) => { textRef.current = value; publishText(value); }, []);
  const controller = useRef<VoiceControl | null>(null);
  const destination = useQuery({
    queryKey: ["conversation", "ship"],
    enabled: connected && !!speech?.preferences.enabled,
    queryFn: async () => {
      const { conversation } = await client.conversation.ship({});
      if (conversation.kind !== "ship") throw new Error("Your personal Ship conversation is unavailable.");
      return conversation;
    },
  });
  const languagePreference = useQuery({
    queryKey: [...consoleConfigQueryKey, "language", destination.data?.ownerUid],
    enabled: connected && !!speech?.preferences.enabled && !!destination.data,
    queryFn: async () => {
      const key = `users/${destination.data!.ownerUid}/locale/language`;
      const { entries } = await client.sys.config.get({ key });
      return entries.find((entry) => entry.key === key)?.value ?? "";
    },
  });
  const requestedLanguage = (languagePreference.data || navigator.language || "en").split("-")[0].toLowerCase();
  const language = languagePreference.data === undefined ? null : requestedLanguage === "es" ? "es"
    : requestedLanguage === "en" || !languagePreference.data ? "en" : null;
  const languageError = languagePreference.error?.message ?? (languagePreference.data !== undefined && !language
    ? "Spoken replies currently support English and Spanish. Your response language is not supported yet." : null);
  // Conversation signals own the transcript; this outbox retains only delivery and retry state.
  const outbox = useChatOutbox(useCallback(() => {}, []));
  const current = useRef({ connected, outbox, destination, speech });
  current.current = { connected, outbox, destination, speech };
  const sendHandsfree = (value: string) => {
    if (!recipient.current || !current.current.connected || !value.trim()) return false;
    return current.current.outbox.send({ ...recipient.current, message: value.trim() });
  };
  const prompt = useMemo(() => {
    const handsfree: VoiceComposer = {
      commands: false,
      selection: () => ({ value: textRef.current, start: textRef.current.length, end: textRef.current.length }),
      setValue: setText,
    };
    return { get current() {
      const source = captureRef.current;
      return source?.kind === "handsfree" ? handsfree : source?.options.current.prompt.current ?? null;
    } };
  }, [setText]);
  const input = useNativeVoice({
    prompt, scope: "desktop-session", enabled: true, global: true,
    prepareHandsfree: () => {
      if (!current.current.connected) return "Reconnecting to your Ship. Your voice draft is still here.";
      if (!current.current.destination.data) {
        void current.current.destination.refetch();
        return current.current.destination.error?.message ?? "Your Ship is getting ready. Try the shortcut again in a moment.";
      }
      if (current.current.outbox.sending) return "Your last message is still sending. Try again in a moment.";
      if (!textRef.current.trim()) {
        const ship = current.current.destination.data;
        recipient.current = { pid: ship.handlerPid, conversationId: ship.id };
      }
      setCapture({ kind: "handsfree" });
      return null;
    },
    send: (value) => {
      const source = captureRef.current;
      return source?.kind === "composer" && source.options.current.enabled && source.options.current.send(value);
    },
    sendGlobal: sendHandsfree,
  });
  controller.current = input;
  useSpokenReplies(client, destination.data?.id, connected && !!speech?.preferences.enabled, language);

  const actions = useMemo(() => ({
    startComposer(composer: Composer) {
      const voice = controller.current;
      if (!voice || voice.capturing || !current.current.connected || !composer.options.current.enabled) return;
      setCapture({ kind: "composer", ...composer });
      voice.start();
    },
    releaseComposer(owner: symbol) {
      const source = captureRef.current;
      if (source?.kind !== "composer" || source.owner !== owner) return;
      controller.current?.cancel();
      setCapture(null);
    },
    edit(value: string) {
      if (captureRef.current?.kind === "handsfree" && controller.current?.capturing) return;
      setText(value);
    },
    discard() {
      if (captureRef.current?.kind === "handsfree") {
        controller.current?.cancel();
        setCapture(null);
      }
      setText("");
      recipient.current = null;
    },
    send() {
      if (captureRef.current?.kind === "handsfree" && controller.current?.capturing) { controller.current.finish(); return; }
      if (sendHandsfree(textRef.current)) {
        current.current.speech?.voiceSent();
        current.current.speech?.cue("sent");
        controller.current?.clearError();
        setText("");
      }
    },
  }), [setCapture, setText]);

  useLayoutEffect(() => { if (!connected) controller.current?.cancel(); }, [connected]);
  const dirty = !!text.trim() || outbox.messages.length > 0 || (capture?.kind === "handsfree" && input.capturing);
  useLayoutEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useLayoutEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const failed = useRef(new Set<string>());
  useEffect(() => {
    for (const message of outbox.messages) {
      if (message.status === "failed" && !failed.current.has(message.id)) {
        failed.current.add(message.id);
        current.current.speech?.cue("attention");
      }
    }
    failed.current = new Set(outbox.messages.filter((message) => message.status === "failed").map((message) => message.id));
  }, [outbox.messages]);
  return <Context.Provider value={{ input, capture, text, connected, language, languageError, outbox, ...actions }}>{children}</Context.Provider>;
}

/** Chat lends its composer only for local dictation; handsfree never borrows that draft. */
export function useComposerVoice(options: ComposerVoiceOptions) {
  const session = useNativeVoiceSession();
  if (!session) throw new Error("Native voice controls require a desktop voice session.");
  const owner = useRef(Symbol("composer"));
  const latest = useRef(options);
  latest.current = options;
  const { releaseComposer } = session;
  useLayoutEffect(() => () => releaseComposer(owner.current), [releaseComposer, options.enabled, options.scope]);
  const owned = session.capture?.kind === "composer" && session.capture.owner === owner.current;
  const { input } = session;
  return {
    ...input,
    capturing: owned && input.capturing,
    blocked: !owned && input.capturing,
    snapshot: input.snapshot && { ...input.snapshot, voice: owned ? input.snapshot.voice : null, notice: session.capture?.kind === "handsfree" ? null : input.snapshot.notice },
    error: session.capture?.kind === "handsfree" ? null : input.error,
    start: () => session.startComposer({ owner: owner.current, options: latest }),
    stop: () => { if (owned) input.stop(); },
    send: () => { if (owned) input.send(); },
    cancel: () => { if (owned) input.cancel(); },
    onInput: (value: string) => { if (owned) input.onInput(value); },
    interceptSubmit: () => owned && input.interceptSubmit(),
  };
}
