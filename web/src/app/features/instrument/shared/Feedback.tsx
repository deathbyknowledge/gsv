import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import { FEEDBACK_ACTIVITY_MESSAGES, FEEDBACK_FEATURE, FEEDBACK_MAX_LENGTH } from "@humansandmachines/gsv/services/feedback";
import type { FeedbackActivity, SysFeedbackArgs } from "@humansandmachines/gsv/protocol";
import { useGateway, WEB_PEER } from "../../../services/gateway/GatewayProvider";
import { useSession } from "../../../services/session/SessionProvider";
import { useNativeInput } from "../../../services/platform/PlatformProvider";
import { Spinner } from "../../../components/ui/Spinner";
import { loadShipActivity } from "../../../services/feedback/shipActivity";
import type { Distance } from "../Instrument";
import "./feedback.css";

export function Feedback({ view }: { view: Distance }) {
  const { client, connected } = useGateway();
  const { snapshot } = useSession();
  const native = useNativeInput();
  const available = snapshot.server?.features?.includes(FEEDBACK_FEATURE) ?? false;
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [activityState, setActivityState] = useState<"off" | "loading" | "ready" | "error">("off");
  const [activity, setActivity] = useState<FeedbackActivity | null>(null);
  const activityRequest = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const submission = useRef<SysFeedbackArgs | null>(null);
  const sending = useRef(false);
  const lifetime = useRef(new AbortController());
  const titleId = useId();
  const detailsId = useId();

  useLayoutEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) element.showModal();
    if (!open && element?.open) element.close();
  }, [open]);
  useEffect(() => () => { lifetime.current.abort(); activityRequest.current?.abort(); }, []);

  const selectActivity = async (checked: boolean) => {
    activityRequest.current?.abort();
    submission.current = null;
    setActivity(null);
    setActivityState(checked ? "loading" : "off");
    if (!checked) return;
    const controller = new AbortController();
    activityRequest.current = controller;
    try {
      const snapshot = await loadShipActivity(client, AbortSignal.any([
        controller.signal, lifetime.current.signal, AbortSignal.timeout(10_000),
      ]));
      if (controller.signal.aborted || lifetime.current.signal.aborted) return;
      setActivity(snapshot);
      setActivityState("ready");
    } catch {
      if (!controller.signal.aborted && !lifetime.current.signal.aborted) setActivityState("error");
    } finally {
      if (activityRequest.current === controller) activityRequest.current = null;
    }
  };

  const submit = async () => {
    if (sending.current || !connected || !message.trim() || activityState === "loading" || activityState === "error") return;
    sending.current = true;
    setState("sending");
    if (!submission.current) {
      submission.current = {
        id: crypto.randomUUID(), message: message.trim(),
        context: { view, platform: native ? "desktop" : "web", version: WEB_PEER.version },
      };
      if (activityState === "ready" && activity) submission.current.activity = activity;
    }
    try {
      await client.request("sys.feedback", submission.current, { signal: lifetime.current.signal });
      if (lifetime.current.signal.aborted) return;
      setMessage("");
      submission.current = null;
      setActivity(null);
      setActivityState("off");
      setState("sent");
    } catch {
      if (!lifetime.current.signal.aborted) setState("error");
    } finally {
      sending.current = false;
    }
  };

  if (!available) return null;
  return <>
    <button type="button" aria-haspopup="dialog" onClick={() => {
      if (state === "sent") setState("idle");
      setOpen(true);
    }}>feedback</button>
    <dialog ref={dialog} class="feedback-dialog" aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); setOpen(false); }}
      onKeyDown={(event) => event.stopPropagation()}>
      <header>
        <span id={titleId}>Feedback</span>
        <button type="button" aria-label="Close feedback" onClick={() => setOpen(false)}>close <kbd>esc</kbd></button>
      </header>
      {state === "sent" ? <div class="feedback-sent" role="status">
        <p>Thanks for the feedback.</p>
        <button type="button" class="feedback-send" onClick={() => setOpen(false)}>Done</button>
      </div> : <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <textarea aria-label="Feedback" aria-describedby={detailsId} autoFocus rows={6}
          maxLength={FEEDBACK_MAX_LENGTH} value={message} disabled={state === "sending"}
          onInput={(event) => {
            setMessage(event.currentTarget.value);
            submission.current = null;
            if (state === "error") setState("idle");
          }} />
        <div class="feedback-activity">
          <label><input type="checkbox" checked={activityState !== "off"} disabled={state === "sending" || !connected}
            onChange={(event) => { void selectActivity(event.currentTarget.checked); }} />
            Include last {FEEDBACK_ACTIVITY_MESSAGES} Ship messages
          </label>
          {activityState === "loading" && <span role="status"><Spinner /> Loading activity…</span>}
          {activityState === "ready" && activity && <details>
            <summary>Review {activity.messageCount} messages{activity.truncated ? " · shortened" : ""}</summary>
            <p>Includes thinking, tool inputs/results and runtime events.</p>
            <pre tabIndex={0}>{activity.text || "No recent activity."}</pre>
          </details>}
          {activityState === "error" && <p role="alert">Could not load Ship activity. <button type="button" onClick={() => { void selectActivity(true); }}>Retry</button></p>}
        </div>
        <footer>
          <span id={detailsId}>Includes your space and app version.</span>
          <button type="submit" class="feedback-send" aria-label={state === "sending" ? "Sending feedback" : undefined}
            aria-busy={state === "sending"} disabled={!connected || !message.trim() || state === "sending" || activityState === "loading" || activityState === "error"}>
            {state === "sending" ? <Spinner /> : "Send"}
          </button>
        </footer>
        {state === "error" && <p class="feedback-error" role="alert">Could not send. Try again.</p>}
        {!connected && <p class="feedback-error" role="status">Waiting for connection.</p>}
      </form>}
    </dialog>
  </>;
}
