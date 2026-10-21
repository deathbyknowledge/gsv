import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import { FEEDBACK_ACTIVITY_MESSAGES, FEEDBACK_FEATURE, FEEDBACK_MAX_LENGTH, type FeedbackReport } from "@humansandmachines/gsv/services/feedback";
import { bodyFromText, type FeedbackActivity } from "@humansandmachines/gsv/protocol";
import { useGateway, WEB_PEER } from "../../../services/gateway/GatewayProvider";
import { useSession } from "../../../services/session/SessionProvider";
import { useNativeInput } from "../../../services/platform/PlatformProvider";
import { Spinner } from "../../../components/ui/Spinner";
import { loadShipActivity } from "../../../services/feedback/shipActivity";
import { useT } from "../../../i18n/locale";
import type { Distance } from "../Instrument";
import "./feedback.css";

export function Feedback({ view }: { view: Distance }) {
  const t = useT();
  const { client, connected } = useGateway();
  const { snapshot } = useSession();
  const native = useNativeInput();
  const available = snapshot.server?.features?.includes(FEEDBACK_FEATURE) ?? false;
  const preview = import.meta.env.VITE_GSV_PREVIEW === "true";
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [activityState, setActivityState] = useState<"off" | "loading" | "ready" | "error">("off");
  const [activity, setActivity] = useState<FeedbackActivity | null>(null);
  const activityRequest = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const submission = useRef<FeedbackReport | null>(null);
  const sending = useRef(false);
  const lifetime = useRef(new AbortController());
  const titleId = useId();
  const contactId = useId();
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
    if (sending.current || !available || !connected || !message.trim() || activityState === "loading" || activityState === "error") return;
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
      const { id, context, ...content } = submission.current;
      await client.request("sys.feedback", { id, context }, {
        body: bodyFromText(JSON.stringify(content)), signal: lifetime.current.signal,
      });
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

  if (!available && !preview) return null;
  return <>
    <button type="button" class="feedback-trigger" aria-haspopup="dialog" onClick={() => {
      if (state === "sent") setState("idle");
      setOpen(true);
    }}>{t("shell.feedback.trigger")}</button>
    <dialog ref={dialog} class="feedback-dialog" aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); setOpen(false); }}
      onKeyDown={(event) => event.stopPropagation()}>
      <header>
        <span id={titleId}>{t("shell.feedback.title")}</span>
        <button type="button" aria-label={t("shell.feedback.close")} onClick={() => setOpen(false)}>{t("shell.close")} <kbd>esc</kbd></button>
      </header>
      {state === "sent" ? <div class="feedback-sent" role="status">
        {!available && <p class="feedback-preview">{t("shell.feedback.previewSent")}</p>}
        <p>{t("shell.feedback.thanks")}</p>
        <button type="button" class="feedback-send" onClick={() => setOpen(false)}>{t("shell.feedback.done")}</button>
      </div> : <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <p class="feedback-intro">{t("shell.feedback.intro")}</p>
        <textarea aria-label={t("shell.feedback.title")} aria-describedby={available ? `${contactId} ${detailsId}` : contactId} autoFocus rows={6}
          maxLength={FEEDBACK_MAX_LENGTH} value={message} disabled={!available || state === "sending"}
          onInput={(event) => {
            setMessage(event.currentTarget.value);
            submission.current = null;
            if (state === "error") setState("idle");
          }} />
        <p id={contactId} class="feedback-contact">{t("shell.feedback.contact")}</p>
        {!available && <p class="feedback-preview" role="status">
          {t("shell.feedback.previewUnavailable")} <button type="button" onClick={() => setState("sent")}>{t("shell.feedback.viewConfirmation")}</button>
        </p>}
        <div class="feedback-activity">
          <label><input type="checkbox" checked={activityState !== "off"} disabled={!available || state === "sending" || !connected}
            onChange={(event) => { void selectActivity(event.currentTarget.checked); }} />
            {t("shell.feedback.includeActivity", { count: FEEDBACK_ACTIVITY_MESSAGES })}
          </label>
          {activityState === "loading" && <span role="status"><Spinner /> {t("shell.feedback.loadingActivity")}</span>}
          {activityState === "ready" && activity && <details>
            <summary>{t(activity.truncated ? "shell.feedback.reviewShortened" : "shell.feedback.review", { count: activity.messageCount })}</summary>
            <p>{t("shell.feedback.activityNote")}</p>
            <pre tabIndex={0}>{activity.text || t("shell.feedback.noActivity")}</pre>
          </details>}
          {activityState === "error" && <p role="alert">{t("shell.feedback.activityFailed")} <button type="button" onClick={() => { void selectActivity(true); }}>{t("shell.retryButton")}</button></p>}
        </div>
        <footer>
          {available && <span id={detailsId}>{t("shell.feedback.versionNote")}</span>}
          <button type="submit" class="feedback-send" aria-label={state === "sending" ? t("shell.feedback.sending") : undefined}
            aria-busy={state === "sending"} disabled={!available || !connected || !message.trim() || state === "sending" || activityState === "loading" || activityState === "error"}>
            {state === "sending" ? <Spinner /> : t("shell.feedback.send")}
          </button>
        </footer>
        {state === "error" && <p class="feedback-error" role="alert">{t("shell.feedback.sendFailed")}</p>}
        {!connected && <p class="feedback-error" role="status">{t("shell.feedback.waiting")}</p>}
      </form>}
    </dialog>
  </>;
}
