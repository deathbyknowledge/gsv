import type { RefObject } from "preact";
import type { OnboardingSnapshot } from "../../../services/session/onboardingService";
import type { SessionSnapshot } from "../../../services/session/sessionService";
import { SessionError } from "../SessionChrome";
import { textInputValue } from "../sessionViewUtils";
import "./GuidePanel.css";

/**
 * GuidePanel — the "Ask the guide" setup assistant.
 *
 * Design-system note: this panel is an intentional INVERTED micro-surface
 * (light background, dark text) so the chat reads against the dark wizard. The
 * controls here are deliberately raw rather than design-system components:
 *   - the chat <textarea> needs a forwarded ref (guideInputRef), Enter-to-send
 *     (onKeyDown), and a fully parent-controlled value that clears on send —
 *     none of which the DS <TextArea> exposes today, and its internal
 *     value-shadowing state would also break the clear-on-send behaviour;
 *   - the send/close buttons would render with dark-theme tokens on this light
 *     surface, so DS <Button>/<IconButton> can't drop in without overrides.
 * The correct fix is a light/inverted DS theme variant (a separate, larger
 * effort); until then these raw controls are a documented exception.
 */
export function GuidePanel({
  snapshot,
  sessionSnapshot,
  guideMessage,
  guideInputRef,
  guideLogRef,
  onGuideMessage,
  onGuideSend,
  onGuideKeyDown,
  onClose,
}: {
  snapshot: OnboardingSnapshot;
  sessionSnapshot: SessionSnapshot;
  guideMessage: string;
  guideInputRef: RefObject<HTMLTextAreaElement>;
  guideLogRef: RefObject<HTMLDivElement>;
  onGuideMessage: (message: string) => void;
  onGuideSend: () => void;
  onGuideKeyDown: (event: KeyboardEvent) => void;
  onClose: () => void;
}) {
  const showPanel = snapshot.draft.stage !== "welcome" && snapshot.draft.mode === "guided";
  const disabled = !showPanel || snapshot.busy || sessionSnapshot.phase === "authenticating";

  return (
    <aside class="gsv-guide-panel" data-setup-guide-panel hidden={!showPanel}>
      <div class="gsv-guide-head">
        <div class="gsv-guide-head-text">
          <p class="gsv-guide-kicker">Setup guide</p>
          <h3 class="gsv-guide-title">Ask for help shaping the plan</h3>
          <p class="gsv-guide-copy">Questions? The assistant can help you pick the right option. For your safety, secret fields remain in the form.</p>
        </div>
        <button type="button" class="gsv-guide-close" aria-label="Close setup assistant" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.6" stroke-linecap="square">
            <line x1="3" y1="3" x2="13" y2="13" />
            <line x1="13" y1="3" x2="3" y2="13" />
          </svg>
        </button>
      </div>
      <div class="gsv-guide-log" data-setup-guide-log ref={guideLogRef}>
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
