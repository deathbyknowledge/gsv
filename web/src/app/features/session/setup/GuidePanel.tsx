import type { RefObject } from "preact";
import type { OnboardingSnapshot } from "../../../services/session/onboardingService";
import type { SessionSnapshot } from "../../../services/session/sessionService";
import { SessionError } from "../SessionChrome";
import { textInputValue } from "../sessionViewUtils";
import "./GuidePanel.css";

export function GuidePanel({
  snapshot,
  sessionSnapshot,
  guideMessage,
  guideInputRef,
  guideLogRef,
  onGuideMessage,
  onGuideSend,
  onGuideKeyDown,
}: {
  snapshot: OnboardingSnapshot;
  sessionSnapshot: SessionSnapshot;
  guideMessage: string;
  guideInputRef: RefObject<HTMLTextAreaElement>;
  guideLogRef: RefObject<HTMLDivElement>;
  onGuideMessage: (message: string) => void;
  onGuideSend: () => void;
  onGuideKeyDown: (event: KeyboardEvent) => void;
}) {
  const showPanel = snapshot.draft.stage !== "welcome" && snapshot.draft.mode === "guided";
  const disabled = !showPanel || snapshot.busy || sessionSnapshot.phase === "authenticating";

  return (
    <aside class="gsv-guide-panel" data-setup-guide-panel hidden={!showPanel}>
      <div class="gsv-guide-head">
        <p class="gsv-guide-kicker">Setup guide</p>
        <h3 class="gsv-guide-title">Ask for help shaping the plan</h3>
        <p class="gsv-guide-copy">Passwords and API keys stay manual. The guide only patches non-secret fields.</p>
      </div>
      <div class="gsv-guide-log" data-setup-guide-log ref={guideLogRef}>
        {snapshot.messages.length === 0 && !snapshot.busy ? (
          <div class="gsv-guide-empty">
            <strong>Ask for setup help</strong>
            <p>System files, AI model, timezone, and device setup can be adjusted here. Secrets stay in the form.</p>
          </div>
        ) : null}
        {snapshot.messages.map((entry, index) => (
          <article class={`gsv-guide-msg gsv-guide-msg-${entry.role}`} data-role={entry.role} key={`${entry.role}-${index}`}>
            <span class="gsv-guide-msg-who">{entry.role === "user" ? "You" : "Guide"}</span>
            <p>{entry.content}</p>
          </article>
        ))}
        {snapshot.busy ? (
          <article class="gsv-guide-msg gsv-guide-msg-assistant is-pending" data-role="assistant">
            <span class="gsv-guide-msg-who">Guide</span>
            <p>Working on it</p>
          </article>
        ) : null}
      </div>
      <SessionError message={showPanel ? snapshot.error : null} />
      <div class="gsv-guide-form" data-setup-guide-form>
        <textarea
          class="gsv-guide-input"
          data-setup-guide-input
          ref={guideInputRef}
          rows={3}
          autoComplete="off"
          aria-label="Message the setup guide"
          placeholder="Ask the guide to shape this setup"
          value={guideMessage}
          disabled={disabled}
          onInput={(event) => onGuideMessage(textInputValue(event))}
          onKeyDown={onGuideKeyDown}
        />
        <button
          type="button"
          class="gsv-guide-send"
          data-setup-guide-send
          disabled={disabled}
          onClick={onGuideSend}
        >
          Send
        </button>
      </div>
    </aside>
  );
}
