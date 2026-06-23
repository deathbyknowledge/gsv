import type { RefObject } from "preact";
import type { OnboardingSnapshot } from "../../../services/session/onboardingService";
import type { SessionSnapshot } from "../../../services/session/sessionService";
import { SessionError } from "../SessionChrome";
import { textInputValue } from "../sessionViewUtils";

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

  return (
    <aside class="onboarding-guide-panel" data-setup-guide-panel hidden={!showPanel}>
      <div class="onboarding-guide-head">
        <div>
          <p class="session-kicker">Setup guide</p>
          <h3>Ask for help shaping the plan</h3>
        </div>
        <p class="session-copy">Passwords and API keys stay manual. The guide only patches non-secret fields.</p>
      </div>
      <div class="onboarding-guide-log" data-setup-guide-log ref={guideLogRef}>
        {snapshot.messages.length === 0 && !snapshot.busy ? (
          <div class="onboarding-guide-empty">
            <strong>Ask for setup help</strong>
            <p>System files, AI model, timezone, and device setup can be adjusted here. Secrets stay in the form.</p>
          </div>
        ) : null}
        {snapshot.messages.map((entry, index) => (
          <article class={`onboarding-guide-message onboarding-guide-message-${entry.role}`} data-role={entry.role} key={`${entry.role}-${index}`}>
            <span>{entry.role === "user" ? "You" : "Guide"}</span>
            <p>{entry.content}</p>
          </article>
        ))}
        {snapshot.busy ? (
          <article class="onboarding-guide-message onboarding-guide-message-assistant is-pending" data-role="assistant">
            <span>Guide</span>
            <p>Working on it</p>
          </article>
        ) : null}
      </div>
      <SessionError message={showPanel ? snapshot.error : null} />
      <div class="onboarding-guide-form" data-setup-guide-form>
        <textarea
          data-setup-guide-input
          ref={guideInputRef}
          rows={3}
          autoComplete="off"
          aria-label="Message the setup guide"
          placeholder="Ask the guide to shape this setup"
          value={guideMessage}
          disabled={!showPanel || snapshot.busy || sessionSnapshot.phase === "authenticating"}
          onInput={(event) => onGuideMessage(textInputValue(event))}
          onKeyDown={onGuideKeyDown}
        />
        <button
          type="button"
          class="runtime-btn"
          data-setup-guide-send
          disabled={!showPanel || snapshot.busy || sessionSnapshot.phase === "authenticating"}
          onClick={onGuideSend}
        >
          Send
        </button>
      </div>
    </aside>
  );
}
