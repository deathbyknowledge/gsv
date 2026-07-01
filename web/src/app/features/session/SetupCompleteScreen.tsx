import type { RefObject } from "preact";
import type { SessionSnapshot } from "../../services/session/sessionService";
import { Button } from "../../components/ui/Button";
import { StatusDot } from "../../components/ui/StatusDot";
import { AuthLayout } from "./AuthLayout";
import { SessionError } from "./SessionChrome";
import { setupResultViewModel, type AdminMode } from "./sessionDomain";
import "./SetupCompleteScreen.css";

type SetupCompleteScreenProps = {
  visible: boolean;
  snapshot: SessionSnapshot;
  adminMode: AdminMode;
  completeError: string | null;
  busy: boolean;
  continueButtonRef: RefObject<HTMLButtonElement>;
  cliCommandRef: RefObject<HTMLTextAreaElement>;
  nodeCommandRef: RefObject<HTMLTextAreaElement>;
  onContinue: () => void;
  onCopyCli: () => void;
  onCopyToken: () => void;
};

export function SetupCompleteScreen({
  visible,
  snapshot,
  adminMode,
  completeError,
  busy,
  continueButtonRef,
  cliCommandRef,
  nodeCommandRef,
  onContinue,
  onCopyCli,
  onCopyToken,
}: SetupCompleteScreenProps) {
  const result = setupResultViewModel(snapshot, adminMode);
  const sourceIsUrl = /^https?:\/\//i.test(result.sourceLabel);

  return (
    <AuthLayout background="galaxy" visible={visible} surfaceClass="gsv-auth-surface-setup">
      <div class="gsv-complete" data-session-setup-complete>
        <div class="gsv-complete-head">
          <span class="gsv-complete-badge" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3.5 8.5 L6.5 11.5 L12.5 4.5" />
            </svg>
          </span>
          <span class="gsv-complete-kicker gsv-sublabel">First-time setup · Complete</span>
          <h2 class="gsv-complete-title gsv-prose-display">Your workspace is ready</h2>
        </div>

        <div class="gsv-complete-account">
          <span class="gsv-complete-k gsv-label">Account</span>
          <span class="gsv-complete-v gsv-paragraph-small" data-setup-result-username>{result.username}</span>
        </div>

        <div class="gsv-complete-actions">
          <button
            type="button"
            class={`gsv-btn gsv-btn-primary${busy ? " is-disabled" : ""}`}
            data-session-setup-continue
            ref={continueButtonRef}
            disabled={busy}
            onClick={busy ? undefined : onContinue}
          >
            <span class="gsv-btn-label">Open desktop</span>
          </button>
        </div>

        <section class="gsv-complete-more">
          <div class="gsv-complete-more-head">
            <h3 class="gsv-complete-more-title gsv-prose-heading">Get more out of GSV</h3>
            <span class="gsv-complete-more-tag gsv-sublabel">Optional</span>
          </div>

          <div class="gsv-complete-more-item">
            <div class="gsv-complete-more-item-head">
              <span class="gsv-complete-more-item-title gsv-prose" data-setup-result-cli-label>
                Install it on your machine to run commands via terminal
              </span>
              <Button
                variant="secondary"
                label="Copy command"
                onClick={onCopyCli}
                dataAttrs={{ "data-setup-copy-cli": true }}
              />
            </div>
            <textarea
              class="gsv-complete-code gsv-scroll"
              data-setup-result-cli-command
              ref={cliCommandRef}
              readOnly
              value={result.cliCommand}
            />
            <p class="gsv-complete-meta gsv-prose-sm" data-setup-result-cli-meta>{result.cliMeta}</p>
          </div>

          <div class="gsv-complete-more-item" data-setup-node-result hidden={!result.node.visible}>
            <div class="gsv-complete-more-item-head">
              <span class="gsv-complete-more-item-title gsv-prose" data-setup-result-node-label>
                Connect other devices
              </span>
              <Button
                variant="secondary"
                label="Copy setup steps"
                onClick={onCopyToken}
                dataAttrs={{ "data-setup-copy-token": true }}
              />
            </div>
            <textarea
              class="gsv-complete-code gsv-scroll"
              data-setup-result-node-token
              ref={nodeCommandRef}
              readOnly
              value={result.node.command}
            />
            <p class="gsv-complete-meta gsv-prose-sm" data-setup-result-node-meta>{result.node.meta}</p>
          </div>
        </section>

        <SessionError className="gsv-complete-alert" message={completeError} />

        <footer class="gsv-complete-statusbar gsv-sublabel">
          <span class="gsv-complete-status-online">
            <StatusDot tone="online" size={7} />
            GSV Online
          </span>
          <span class="gsv-complete-status-seg gsv-complete-status-seg-grow">
            <b>System files</b>
            {sourceIsUrl ? (
              <a
                class="gsv-complete-status-val gsv-complete-status-link"
                href={result.sourceLabel}
                target="_blank"
                rel="noopener noreferrer"
                data-setup-result-source
              >
                {result.sourceLabel.replace(/^https?:\/\//i, "").replace(/^github\.com\//i, "")}
              </a>
            ) : (
              <span class="gsv-complete-status-val" data-setup-result-source>{result.sourceLabel}</span>
            )}
          </span>
          <span class="gsv-complete-status-seg">
            <b>Version</b>
            <span class="gsv-complete-status-val" data-setup-result-ref>{result.refLabel}</span>
          </span>
        </footer>
      </div>
    </AuthLayout>
  );
}
