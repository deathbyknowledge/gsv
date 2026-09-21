import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { GestureIllustration } from "./GestureIllustration";
import { gestureFeedback } from "./NativeGestureFeedback";
import { InputSoundSettings } from "./InputSoundSettings";
import { playInputCue } from "./inputSounds";
import { practiceCorrection, practiceHold } from "./practiceFeedback";
import { useNativeVoice, type VoiceComposer } from "./useNativeVoice";
import type { GestureCandidate, PracticeTarget, SegmentAction } from "./PlatformProvider";
import type { GestureLesson } from "./gestureScene";

type Step = { title: string; label: string; target: PracticeTarget; lesson: GestureLesson; instruction: string; hint?: string; action?: GestureCandidate };
const steps: readonly Step[] = [
  { title: "Two hands. Two roles.", label: "Hands", target: "none", lesson: "roles", instruction: "Your right hand gives commands. Your left hand joins in to scroll and switch hands-free off." },
  { title: "One finger to listen", label: "Listen", target: "listen", lesson: 1, action: "start_transcription", instruction: "Show any one finger on your right hand. Hold until the indicator fills and you hear the cue.", hint: "Then make a fist. This resets your hand for the next command." },
  { title: "Say a few words", label: "Dictate", target: "dictate", lesson: "rest", instruction: "Speak naturally. Your words appear below.", hint: "Listening uses your microphone. Transcription runs on this computer." },
  { title: "Two fingers to send", label: "Send", target: "send", lesson: 2, action: "send", instruction: "Hold any two fingers to send. Listening continues." },
  { title: "Three to delete", label: "Delete", target: "delete", lesson: 3, action: "delete_backward", instruction: "Dictate a few more words, then hold three fingers to remove the last character.", hint: "Any combination of three fingers works." },
  { title: "Four to clear", label: "Clear", target: "clear", lesson: 4, action: "clear_dictation", instruction: "Dictate something else, then hold four fingers for a second.", hint: "Only dictated words clear. Text you typed stays." },
  { title: "One finger to pause", label: "Pause", target: "pause", lesson: 1, action: "stop_transcription", instruction: "Hold one finger again to stop listening.", hint: "The camera stays ready. One finger starts listening again." },
  { title: "Tilt to scroll", label: "Scroll", target: "scroll", lesson: "scroll", instruction: "Open your left palm and close your right fist. Hold them level, let them settle, then tilt the line between them.", hint: "Try moving the messages. Level your hands or release the pose to stop." },
  { title: "Both fists to finish", label: "Off", target: "off", lesson: 0, action: "disarm", instruction: "Hold both fists to turn hands-free off. The camera and microphone stop together.", hint: "When off, gestures do nothing. Enable hands-free again from the controls." },
];
const practiceMessages = ["Your messages stay in place.", "Tilt your hands to move through them.", "Level your hands to pause.", "Release either hand to stop.", "Your real conversation is unchanged."];

export function GestureTutorial({ scope, onClose }: { scope: string; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const value = useRef("");
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [complete, setComplete] = useState(false);
  const finished = complete && step === steps.length - 1;
  const [recognized, setRecognized] = useState(0);
  const [completed, setCompleted] = useState<Set<number>>(() => new Set());
  const [actions, setActions] = useState<Record<SegmentAction, number>>({ send: 0, delete: 0, clear: 0 });
  const transition = useRef(0);
  const entered = useRef({ sequence: 0, actions, gesture: 0, hadDraft: false, scrolled: false });
  const composer = useRef<VoiceComposer>({
    selection: () => ({ value: value.current, start: textarea.current?.selectionStart ?? value.current.length, end: textarea.current?.selectionEnd ?? value.current.length }),
    setValue(text, caret) {
      value.current = text;
      if (textarea.current) {
        textarea.current.value = text;
        if (caret !== undefined) textarea.current.setSelectionRange(caret, caret);
      }
      setDraft(text);
    },
  });
  // This hook owns a fresh native lease and only these local callbacks. It never receives the conversation sender.
  const control = useNativeVoice({
    prompt: composer, scope: `practice:${scope}`, enabled: true, practice: true,
    send(text) { if (!text.trim()) return false; setSent(text); return true; },
    scroll(delta) { if (scrollArea.current) scrollArea.current.scrollTop += delta; },
    onAction(action) { setActions((current) => ({ ...current, [action]: current[action] + 1 })); },
  });
  const { snapshot, error } = control;
  const voice = snapshot?.voice;
  const camera = snapshot?.gestures_enabled ?? false;
  const listening = voice?.phase === "listening";
  const feedback = snapshot ? gestureFeedback(snapshot) : null;
  const progress = useRef({ snapshot, actions });
  progress.current = { snapshot, actions };
  const lesson = steps[step];
  const notice = error || snapshot?.notice;
  const close = () => {
    transition.current++;
    if (camera || voice) playInputCue("off");
    onClose();
  };
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => { transition.current++; if (element.open) element.close(); };
  }, []);
  useLayoutEffect(() => { heading.current?.focus({ preventScroll: true }); }, [step, finished]);
  const go = async (next: number) => {
    const change = ++transition.current;
    const baseline = { sequence: progress.current.snapshot?.gesture_action_sequence ?? 0, actions: progress.current.actions, gesture: 0, hadDraft: Boolean(value.current.trim()), scrolled: false };
    if (!await control.command({ kind: "practice", expected: steps[next].target }) || change !== transition.current) return false;
    entered.current = baseline;
    setComplete(false);
    setRecognized(0);
    setStep(next);
    return true;
  };
  useEffect(() => {
    if (snapshot && snapshot.gesture_practice?.expected !== lesson.target) {
      void control.command({ kind: "practice", expected: lesson.target });
    }
  }, [snapshot?.lease]);
  const finishStep = () => {
    setComplete(true);
    setCompleted((current) => new Set([...current, step]));
  };
  const restart = async () => {
    if (!await go(0)) return;
    value.current = "";
    setDraft("");
    setSent(null);
    setActions({ send: 0, delete: 0, clear: 0 });
    setCompleted(new Set());
    control.reconnect();
  };
  useEffect(() => {
    if (!snapshot || snapshot.gesture_practice?.expected !== lesson.target || step === 0 || complete) return;
    if (draft.trim()) entered.current.hadDraft = true;
    if (snapshot.gesture_action_sequence > entered.current.sequence && snapshot.gesture_action === lesson.action) {
      entered.current.gesture = snapshot.gesture_action_sequence;
      setRecognized(snapshot.gesture_action_sequence);
    }
    if (step === 7 && snapshot.scroll_velocity) entered.current.scrolled = true;
    const accepted = entered.current.gesture > 0;
    const done = step === 1 ? accepted && listening
      : step === 2 ? false
      : step === 3 ? accepted && actions.send > entered.current.actions.send
      : step === 4 ? accepted && entered.current.hadDraft && actions.delete > entered.current.actions.delete
      : step === 5 ? accepted && entered.current.hadDraft && actions.clear > entered.current.actions.clear
      : step === 6 ? accepted && !voice && !notice
      : step === 7 ? entered.current.scrolled && !snapshot.scroll_velocity
      : accepted && !camera && !voice;
    const reset = !lesson.action || lesson.action === "disarm"
      || snapshot.gesture_reset_after_action >= entered.current.gesture;
    if (done && reset) finishStep();
  }, [step, snapshot, draft, actions, complete, listening, notice]);
  useEffect(() => {
    if (step !== 2 || complete || !listening || !draft.trim() || notice) return;
    // Let the person finish a phrase instead of changing lessons on its first partial word.
    const timer = window.setTimeout(finishStep, 1400);
    return () => window.clearTimeout(timer);
  }, [step, complete, listening, draft, notice]);
  useEffect(() => {
    if (!complete || finished || !snapshot || notice || !camera) return;
    let timer = 0;
    const schedule = () => {
      window.clearTimeout(timer);
      if (!document.hidden) timer = window.setTimeout(() => void go(step + 1), 900);
    };
    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [complete, finished, step, snapshot?.lease, notice, camera]);

  const state = listening ? "Listening" : camera ? "Ready" : "Off";
  const preparing = (camera && snapshot?.gesture_status !== "ready") || (voice && !listening);
  const correction = snapshot ? practiceCorrection(snapshot, lesson.target) : null;
  const holding = snapshot ? practiceHold(snapshot, lesson.target) : null;
  const resetting = recognized > 0 && lesson.action !== "disarm";
  const awaitingFist = snapshot?.gesture_needs_reset ?? false;
  const liveMessage = notice ? "Input needs attention" : !snapshot ? "Connecting input…"
    : feedback?.progress != null ? holding ?? feedback.message
    : correction ? correction
    : awaitingFist ? "Close your right hand to reset"
    : complete ? resetting ? "✓ Fist detected · next step…" : "✓ Done · next step…"
    : resetting ? "✓ Fist detected · waiting for the action to finish"
    : !camera && !voice ? "Camera and microphone off"
    : preparing && voice ? "Preparing microphone…"
    : !camera && listening ? "Listening · camera off" : feedback?.message;
  const completedLessons = steps.slice(1).filter((_, index) => completed.has(index + 1)).length;
  return <dialog ref={dialog} class="native-tutorial" aria-labelledby="native-tutorial-title" data-instrument-dialog data-complete={finished ? "true" : undefined}
    onCancel={(event) => { event.preventDefault(); close(); }} onKeyDown={(event) => event.stopPropagation()}>
    <header class="native-tutorial-head">
      <span>Hands-free</span>
      <button type="button" onClick={close}>close <kbd>esc</kbd></button>
    </header>
    {finished ? <>
      <section class="native-tutorial-completion">
        <span class="native-completion-mark" aria-hidden="true">✓</span>
        <p class="native-tutorial-count">{completedLessons === steps.length - 1 ? "Tutorial complete" : `${completedLessons} of ${steps.length - 1} lessons completed`}</p>
        <h2 ref={heading} id="native-tutorial-title" tabIndex={-1}>{completedLessons === steps.length - 1 ? "You’re ready." : "Tutorial finished."}</h2>
        <p>Camera and microphone are off.</p>
        <p class="native-panel-footnote">Enable hands-free from the prompt whenever you want to use it.</p>
      </section>
      <footer class="native-tutorial-footer">
        <button type="button" onClick={() => void restart()}>restart tutorial</button>
        <button type="button" class="native-primary" onClick={close}>done</button>
      </footer>
    </> : <>
    <nav class="native-tutorial-steps" aria-label="Tutorial steps">
      {steps.map((entry, index) => <button type="button" key={entry.label} aria-current={step === index ? "step" : undefined}
        aria-label={`${index + 1}. ${entry.label}${completed.has(index) ? ", completed" : ""}`}
        onClick={() => void go(index)}>
        <span>{completed.has(index) ? "✓" : index + 1}</span><small>{entry.label}</small>
      </button>)}
    </nav>
    <div class="native-tutorial-body">
      <section class="native-tutorial-visual" aria-label="Gesture demonstration">
        <GestureIllustration lesson={resetting || awaitingFist ? "rest" : lesson.lesson} label={resetting || awaitingFist ? "Close your action hand into a fist to reset" : lesson.instruction} />
      </section>
      <section class="native-tutorial-lesson">
        <p class="native-tutorial-count">{String(step + 1).padStart(2, "0")} / {String(steps.length).padStart(2, "0")}</p>
        <h2 ref={heading} id="native-tutorial-title" tabIndex={-1}>{lesson.title}</h2>
        <p>{lesson.instruction}</p>
        {lesson.hint && <p class="native-panel-footnote">{lesson.hint}</p>}
        {step === 0 ? <>
          <div class="native-role-key"><span>right <b>action</b></span><span>left <b>control</b></span></div>
          <p class="native-panel-footnote">Start enables the camera. Close to stop.</p>
          <InputSoundSettings />
        </> : <>
          {step >= 2 && step <= 6 && <textarea ref={textarea} id="native-practice-draft" class="native-practice-draft" rows={3} value={draft} aria-label="Dictation"
            placeholder={listening ? "Speak a few words…" : "Your words appear here"}
            onInput={(event) => {
              const text = event.currentTarget.value;
              value.current = text;
              setDraft(text);
              control.onInput(text);
            }} />}
          {step === 3 && <div class="native-practice-sent" aria-live="polite">
            <span>Sent message</span><p>{sent ?? "Your sent words will appear here."}</p>
          </div>}
          {step === 7 && <div ref={scrollArea} class="native-practice-scroll" aria-label="Messages" tabIndex={0}>
            {practiceMessages.map((message, index) => <p key={message}><span>{index + 1}</span>{message}</p>)}
          </div>}
          {(!camera || voice || (step >= 2 && step <= 6)) && <div class="native-practice-controls">
            {!camera && <button type="button" disabled={!snapshot} onClick={() => void control.command({ kind: "gestures", enabled: true })}>enable camera</button>}
            {step >= 2 && step <= 6 && !voice && <button type="button" disabled={!snapshot} onClick={control.start}>listen</button>}
            {voice && <button type="button" disabled={voice.phase === "finishing"} onClick={listening ? control.stop : control.cancel}>{listening ? "pause" : "cancel"}</button>}
          </div>}
        </>}
        {notice && <p class="native-input-error" role="alert">{notice}</p>}
        {!snapshot && <button type="button" onClick={control.reconnect}>reconnect input</button>}
      </section>
    </div>
    <section class="native-tutorial-live" aria-label="Live gesture feedback">
      <div class="native-tutorial-states" aria-label="Hands-free state">
        {["Off", "Ready", "Listening"].map((label) => <span key={label} data-current={!preparing && state === label ? "true" : undefined}>{label}</span>)}
      </div>
      <div class="native-tutorial-feedback" role="status">
        <span class={complete && !notice && !correction ? "native-tutorial-success" : undefined}>{liveMessage}</span>
        <progress max={1000} value={feedback?.progress ?? (complete ? 1000 : 0)} aria-label="Gesture hold" />
      </div>
    </section>
    <footer class="native-tutorial-footer">
      <button type="button" disabled={step === 0} onClick={() => void go(step - 1)}>← back</button>
      <div>
        {step === 0 ? <>
          <button type="button" onClick={() => void go(1)}>browse lessons</button>
          <button type="button" class="native-primary" disabled={!snapshot} onClick={async () => {
            if (await go(1)) void control.command({ kind: "gestures", enabled: true });
          }}>start →</button>
        </> : step === steps.length - 1 ? <span>Hold both fists to finish</span> : <>
          {!complete && <button type="button" onClick={() => void go(step + 1)}>skip step</button>}
          {complete && <span class="native-tutorial-success" role="status">next step…</span>}
        </>}
      </div>
    </footer>
    </>}
  </dialog>;
}
