import type { RefObject } from "preact";
import type { SessionSnapshot } from "../../services/session/sessionService";
import { CompleteStageRail, OnboardingHelp, SessionError } from "./SessionChrome";
import { setupResultViewModel, type AdminMode } from "./sessionDomain";

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

  return (
    <div class="session-panel session-panel-wide onboarding-panel onboarding-status-panel onboarding-complete-panel" data-session-setup-complete hidden={!visible}>
      <div class="session-setup-form onboarding-layout">
        <aside class="onboarding-sidebar">
          <div class="session-panel-head">
            <p class="session-kicker">First-time setup</p>
            <h1>Complete</h1>
            <p class="session-copy">Your workspace is ready.</p>
          </div>
          <CompleteStageRail />
        </aside>
        <div class="onboarding-workspace">
          <main class="onboarding-main onboarding-status-main">
            <section class="onboarding-stage onboarding-status-stage">
              <div class="onboarding-lane-banner">
                <span>Complete</span>
              </div>
              <div class="setup-step-copy onboarding-complete-copy">
                <h2>Your workspace is ready</h2>
                <p class="session-copy">Your account and system files are ready. Open the desktop now; command line tools and device setup are available below.</p>
              </div>
              <div class="session-result-grid">
                <div class="session-result-card">
                  <span>Account</span>
                  <strong data-setup-result-username>{result.username}</strong>
                </div>
                <div class="session-result-card">
                  <span>Admin security</span>
                  <strong data-setup-result-root>{result.rootLabel}</strong>
                </div>
                <div class="session-result-card">
                  <span>System files</span>
                  <strong data-setup-result-source>{result.sourceLabel}</strong>
                </div>
                <div class="session-result-card">
                  <span>Version</span>
                  <strong data-setup-result-ref>{result.refLabel}</strong>
                </div>
              </div>
              <div class="session-token-panel">
                <div class="session-token-head">
                  <div>
                    <p class="session-kicker">Command line tools</p>
                    <h2 data-setup-result-cli-label>{result.cliLabel}</h2>
                  </div>
                  <OnboardingHelp label="Explain command line tools" tooltipId="setup-help-cli" title="For terminal use">
                    These commands install GSV tools on this machine so you can manage or connect to the workspace from a terminal.
                  </OnboardingHelp>
                  <button type="button" class="runtime-btn session-btn-secondary" data-setup-copy-cli onClick={onCopyCli}>Copy command</button>
                </div>
                <textarea class="session-token-value" data-setup-result-cli-command ref={cliCommandRef} readOnly value={result.cliCommand} />
                <p class="session-token-meta" data-setup-result-cli-meta>{result.cliMeta}</p>
              </div>
              <div class="session-token-panel" data-setup-node-result hidden={!result.node.visible}>
                <div class="session-token-head">
                  <div>
                    <p class="session-kicker">Device setup</p>
                    <h2 data-setup-result-node-label>{result.node.label}</h2>
                  </div>
                  <button type="button" class="runtime-btn session-btn-secondary" data-setup-copy-token onClick={onCopyToken}>Copy setup steps</button>
                </div>
                <textarea class="session-token-value" data-setup-result-node-token ref={nodeCommandRef} readOnly value={result.node.command} />
                <p class="session-token-meta" data-setup-result-node-meta>{result.node.meta}</p>
              </div>
            </section>
            <SessionError className="session-error onboarding-alert" message={completeError} />
            <div class="session-actions onboarding-actions">
              <div />
              <div class="onboarding-primary-actions">
                <button
                  type="button"
                  class="runtime-btn"
                  data-session-setup-continue
                  ref={continueButtonRef}
                  disabled={busy}
                  onClick={onContinue}
                >
                  Open desktop
                </button>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
