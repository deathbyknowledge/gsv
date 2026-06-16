import type { RefObject } from "preact";
import type {
  OnboardingDetailStep,
  OnboardingDraft,
  OnboardingLane,
} from "@gsv/protocol/syscalls/system";
import type { OnboardingSnapshot } from "../../../onboarding-service";
import type { SessionSnapshot } from "../../../session-service";
import { OnboardingHelp, SessionError, SetupStageRail } from "./SessionChrome";
import {
  SETUP_LANE_META,
  advancedSectionsVisible,
  browserTimeZone,
  buildAiSummary,
  buildDeviceSummary,
  buildSourceSummary,
  currentDetailStep,
} from "./sessionDomain";
import { checkedInputValue, textInputValue } from "./sessionViewUtils";

type SetupScreenProps = {
  snapshot: SessionSnapshot;
  onboardingSnapshot: OnboardingSnapshot;
  setupError: string | null;
  guideMessage: string;
  guideInputRef: RefObject<HTMLTextAreaElement>;
  guideLogRef: RefObject<HTMLDivElement>;
  timezoneOptions: string[];
  onLane: (lane: OnboardingLane) => void;
  onBack: () => void;
  onNext: () => void;
  onSubmit: (event: Event) => void;
  onGuideToggle: () => void;
  onGuideMessage: (message: string) => void;
  onGuideSend: () => void;
  onGuideKeyDown: (event: KeyboardEvent) => void;
  updateDraft: (updater: (draft: OnboardingDraft) => OnboardingDraft) => void;
};

function SetupSidebar({ draft }: { draft: OnboardingDraft }) {
  const meta = SETUP_LANE_META[draft.lane];
  const detailStep = currentDetailStep(draft);
  const copy = draft.stage === "welcome" ? "Choose a setup path." : meta.estimate;

  return (
    <aside class="onboarding-sidebar">
      <div class="session-panel-head">
        <p class="session-kicker">First-time setup</p>
        <h1 data-setup-heading>Create account</h1>
        <p class="session-copy" data-setup-copy>{copy}</p>
      </div>
      <SetupStageRail stage={draft.stage} detailStep={detailStep} />
    </aside>
  );
}

function WelcomeStage({
  draft,
  onLane,
}: {
  draft: OnboardingDraft;
  onLane: (lane: OnboardingLane) => void;
}) {
  return (
    <section class="onboarding-stage onboarding-stage-welcome" data-setup-stage="welcome" hidden={draft.stage !== "welcome"}>
      <div class="onboarding-mode-grid">
        <button
          type="button"
          class={`onboarding-mode-card${draft.lane === "quick" ? " is-selected" : ""}`}
          data-setup-lane="quick"
          onClick={() => onLane("quick")}
        >
          <span class="onboarding-mode-kicker">Recommended</span>
          <strong>Quick start</strong>
          <p>Create the first account, keep the default AI path, and use the official system files.</p>
        </button>
        <button
          type="button"
          class={`onboarding-mode-card${draft.lane === "customize" || draft.lane === "advanced" ? " is-selected" : ""}`}
          data-setup-lane="customize"
          onClick={() => onLane("customize")}
        >
          <span class="onboarding-mode-kicker">More control</span>
          <strong>Custom</strong>
          <p>Choose AI defaults, system files, and optional device setup before first start.</p>
        </button>
      </div>
    </section>
  );
}

function AccountDetails({
  draft,
  activeStep,
  updateDraft,
}: {
  draft: OnboardingDraft;
  activeStep: OnboardingDetailStep;
  updateDraft: (updater: (draft: OnboardingDraft) => OnboardingDraft) => void;
}) {
  return (
    <section class="onboarding-section" data-setup-detail-step="account" hidden={draft.stage !== "details" || activeStep !== "account"}>
      <div class="session-field-grid">
        <label>
          Username
          <input
            data-setup-username
            type="text"
            autoComplete="username"
            placeholder="hank"
            value={draft.account.username}
            onInput={(event) => updateDraft((current) => ({
              ...current,
              account: {
                ...current.account,
                username: textInputValue(event),
              },
            }))}
          />
        </label>
        <label>
          Personal agent username
          <input
            data-setup-agent-name
            type="text"
            autoComplete="off"
            placeholder="friday"
            value={draft.account.agentName}
            onInput={(event) => updateDraft((current) => ({
              ...current,
              account: {
                ...current.account,
                agentName: textInputValue(event),
              },
            }))}
          />
          <small class="session-field-hint">Optional. Leave blank to use the next available default name.</small>
        </label>
        <label>
          Password
          <input
            data-setup-password
            type="password"
            autoComplete="new-password"
            value={draft.account.password}
            onInput={(event) => updateDraft((current) => ({
              ...current,
              account: {
                ...current.account,
                password: textInputValue(event),
              },
            }))}
          />
        </label>
        <label>
          Confirm password
          <input
            data-setup-password-confirm
            type="password"
            autoComplete="new-password"
            value={draft.account.passwordConfirm}
            onInput={(event) => updateDraft((current) => ({
              ...current,
              account: {
                ...current.account,
                passwordConfirm: textInputValue(event),
              },
            }))}
          />
        </label>
      </div>
      <div class="onboarding-field-note">
        <strong>Keep this password safe.</strong>
        <p>GSV does not store a recoverable copy. Losing it can lock you out of this workspace.</p>
      </div>
    </section>
  );
}

function SystemDetails({
  draft,
  activeStep,
  timezoneOptions,
  updateDraft,
}: {
  draft: OnboardingDraft;
  activeStep: OnboardingDetailStep;
  timezoneOptions: string[];
  updateDraft: (updater: (draft: OnboardingDraft) => OnboardingDraft) => void;
}) {
  const showAdvanced = advancedSectionsVisible(draft);
  const showAiRows = showAdvanced && draft.ai.enabled;
  const showSourceRows = showAdvanced && draft.source.enabled;
  const showNodeRows = showAdvanced && draft.device.enabled;
  const options = timezoneOptions.includes(draft.system.timezone)
    ? timezoneOptions
    : [...timezoneOptions, draft.system.timezone].filter(Boolean).sort((left, right) => left.localeCompare(right));

  return (
    <section class="onboarding-section onboarding-preferences" data-setup-detail-step="system" hidden={draft.stage !== "details" || activeStep !== "system"}>
      <div class="onboarding-preference-group">
        <div class="onboarding-section-head">
          <h3>Admin security</h3>
          <p>Choose whether sensitive admin actions need a second password.</p>
        </div>
        <div class="session-field-grid">
          <label class="session-toggle">
            <span>Include extra security layer for admin tasks</span>
            <input
              data-setup-admin-custom
              type="checkbox"
              checked={draft.admin.mode === "custom"}
              onChange={(event) => updateDraft((current) => ({
                ...current,
                admin: {
                  ...current.admin,
                  mode: checkedInputValue(event) ? "custom" : "same",
                },
              }))}
            />
          </label>
          <label data-setup-root-row hidden={draft.admin.mode !== "custom"}>
            Define admin password
            <input
              data-setup-root-password
              type="password"
              autoComplete="new-password"
              disabled={draft.admin.mode !== "custom"}
              value={draft.admin.password}
              onInput={(event) => updateDraft((current) => ({
                ...current,
                admin: {
                  ...current.admin,
                  password: textInputValue(event),
                },
              }))}
            />
          </label>
          <label data-setup-root-confirm-row hidden={draft.admin.mode !== "custom"}>
            Confirm admin password
            <input
              data-setup-root-password-confirm
              type="password"
              autoComplete="new-password"
              disabled={draft.admin.mode !== "custom"}
              value={draft.admin.passwordConfirm}
              onInput={(event) => updateDraft((current) => ({
                ...current,
                admin: {
                  ...current.admin,
                  passwordConfirm: textInputValue(event),
                },
              }))}
            />
          </label>
        </div>
        <OnboardingHelp label="Explain admin security" tooltipId="setup-help-admin" title="Why?">
          A separate admin password adds a second check for sensitive system actions.
        </OnboardingHelp>
      </div>

      <div class="onboarding-preference-group">
        <div class="onboarding-section-head">
          <h3>Timezone</h3>
          <p>Used for schedules, calendars, and timestamp displays.</p>
        </div>
        <div class="session-field-grid">
          <label>
            Timezone
            <select
              data-setup-timezone
              value={draft.system.timezone}
              onChange={(event) => updateDraft((current) => ({
                ...current,
                system: {
                  ...current.system,
                  timezone: textInputValue(event),
                },
              }))}
            >
              {options.map((zone) => (
                <option value={zone} key={zone}>{zone}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div class="onboarding-custom-options" data-setup-ai-section hidden={!showAdvanced}>
        <div class="onboarding-section-head">
          <h3>AI defaults</h3>
          <p>Keep the default AI path, or choose the AI service and model from the start.</p>
        </div>
        <OnboardingHelp label="Explain AI defaults" tooltipId="setup-help-ai" title="What does this change?">
          These settings choose the default AI service GSV uses after setup. You can change them later from settings.
        </OnboardingHelp>
        <div class="session-field-grid">
          <label class="session-toggle">
            <span>Customize AI settings</span>
            <input
              data-setup-ai-enabled
              type="checkbox"
              disabled={!showAdvanced}
              checked={draft.ai.enabled}
              onChange={(event) => updateDraft((current) => ({
                ...current,
                ai: {
                  ...current.ai,
                  enabled: checkedInputValue(event),
                },
              }))}
            />
          </label>
          <label data-setup-ai-provider-row hidden={!showAiRows}>
            AI service
            <input
              data-setup-ai-provider
              type="text"
              placeholder="openai"
              autoComplete="off"
              disabled={!showAiRows}
              value={draft.ai.provider}
              onInput={(event) => updateDraft((current) => ({
                ...current,
                ai: {
                  ...current.ai,
                  provider: textInputValue(event),
                },
              }))}
            />
          </label>
          <label data-setup-ai-model-row hidden={!showAiRows}>
            AI model
            <input
              data-setup-ai-model
              type="text"
              placeholder="gpt-5.4"
              autoComplete="off"
              disabled={!showAiRows}
              value={draft.ai.model}
              onInput={(event) => updateDraft((current) => ({
                ...current,
                ai: {
                  ...current.ai,
                  model: textInputValue(event),
                },
              }))}
            />
          </label>
          <label data-setup-ai-key-row hidden={!showAiRows}>
            API key
            <input
              data-setup-ai-key
              type="password"
              autoComplete="off"
              disabled={!showAiRows}
              value={draft.ai.apiKey}
              onInput={(event) => updateDraft((current) => ({
                ...current,
                ai: {
                  ...current.ai,
                  apiKey: textInputValue(event),
                },
              }))}
            />
          </label>
        </div>
      </div>

      <div class="onboarding-custom-options" data-setup-source-section hidden={!showAdvanced}>
        <div class="onboarding-section-head">
          <h3>System files</h3>
          <p>Use the official system files, or choose a repository and version you control.</p>
        </div>
        <OnboardingHelp label="Explain system files" tooltipId="setup-help-source" title="For advanced setup">
          System files are the built-in apps and settings GSV starts with. Advanced users can point this at a Git repository or remote URL; Version can be a branch, tag, or commit.
        </OnboardingHelp>
        <div class="session-field-grid">
          <label class="session-toggle">
            <span>Use custom system files</span>
            <input
              data-setup-source-enabled
              type="checkbox"
              disabled={!showAdvanced}
              checked={draft.source.enabled}
              onChange={(event) => updateDraft((current) => ({
                ...current,
                source: {
                  ...current.source,
                  enabled: checkedInputValue(event),
                },
              }))}
            />
          </label>
          <label data-setup-source-row hidden={!showSourceRows}>
            System files location
            <input
              data-setup-bootstrap-source
              type="text"
              autoComplete="off"
              placeholder="deathbyknowledge/gsv"
              disabled={!showSourceRows}
              value={draft.source.value}
              onInput={(event) => updateDraft((current) => ({
                ...current,
                source: {
                  ...current.source,
                  value: textInputValue(event),
                },
              }))}
            />
          </label>
          <label data-setup-source-ref-row hidden={!showSourceRows}>
            Version
            <input
              data-setup-bootstrap-ref
              type="text"
              autoComplete="off"
              placeholder="main"
              disabled={!showSourceRows}
              value={draft.source.ref}
              onInput={(event) => updateDraft((current) => ({
                ...current,
                source: {
                  ...current.source,
                  ref: textInputValue(event),
                },
              }))}
            />
          </label>
        </div>
      </div>

      <div class="onboarding-custom-options" data-setup-node-section hidden={!showAdvanced}>
        <div class="onboarding-section-head">
          <h3>Device setup</h3>
          <p>Create a setup key now if you want another machine to connect immediately.</p>
        </div>
        <OnboardingHelp label="Explain device setup" tooltipId="setup-help-node" title="Setup key">
          A setup key lets another machine connect to this workspace. Only create one now if you are ready to connect a device.
        </OnboardingHelp>
        <div class="session-field-grid">
          <label class="session-toggle">
            <span>Create a device setup key now</span>
            <input
              data-setup-node-enabled
              type="checkbox"
              disabled={!showAdvanced}
              checked={draft.device.enabled}
              onChange={(event) => updateDraft((current) => ({
                ...current,
                device: {
                  ...current.device,
                  enabled: checkedInputValue(event),
                },
              }))}
            />
          </label>
          <label data-setup-node-device-row hidden={!showNodeRows}>
            Device ID
            <input
              data-setup-node-device-id
              type="text"
              autoComplete="off"
              placeholder="node-rearden"
              disabled={!showNodeRows}
              value={draft.device.deviceId}
              onInput={(event) => updateDraft((current) => ({
                ...current,
                device: {
                  ...current.device,
                  deviceId: textInputValue(event),
                },
              }))}
            />
          </label>
          <label data-setup-node-label-row hidden={!showNodeRows}>
            Label
            <input
              data-setup-node-label
              type="text"
              autoComplete="off"
              placeholder="rearden"
              disabled={!showNodeRows}
              value={draft.device.label}
              onInput={(event) => updateDraft((current) => ({
                ...current,
                device: {
                  ...current.device,
                  label: textInputValue(event),
                },
              }))}
            />
          </label>
          <label data-setup-node-expiry-row hidden={!showNodeRows}>
            Expires in days
            <input
              data-setup-node-expiry
              type="number"
              min="1"
              inputMode="numeric"
              autoComplete="off"
              placeholder="30"
              disabled={!showNodeRows}
              value={draft.device.expiryDays}
              onInput={(event) => updateDraft((current) => ({
                ...current,
                device: {
                  ...current.device,
                  expiryDays: textInputValue(event),
                },
              }))}
            />
          </label>
        </div>
      </div>
    </section>
  );
}

function DetailsStage({
  draft,
  timezoneOptions,
  updateDraft,
}: {
  draft: OnboardingDraft;
  timezoneOptions: string[];
  updateDraft: (updater: (draft: OnboardingDraft) => OnboardingDraft) => void;
}) {
  const activeStep = currentDetailStep(draft);
  const isSystem = activeStep === "system";
  const title = isSystem ? "Preferences" : "Desktop account";
  const description = isSystem
    ? draft.lane === "quick"
      ? "Confirm timezone and decide whether admin actions need a separate password."
      : "Confirm timezone, admin security, and any custom AI, system files, or device settings."
    : "Create the first desktop account and secure it with a password.";

  return (
    <section class="onboarding-stage onboarding-stage-details" data-setup-stage="details" hidden={draft.stage !== "details"}>
      <div class="onboarding-lane-banner">
        <span data-setup-lane-kicker>{isSystem ? "Preferences" : "Login credentials"}</span>
      </div>
      <div class="setup-step-copy" data-setup-detail-copy>
        <h2 data-setup-lane-title>{title}</h2>
        <p class="session-copy" data-setup-lane-description>{description}</p>
      </div>
      <AccountDetails draft={draft} activeStep={activeStep} updateDraft={updateDraft} />
      <SystemDetails draft={draft} activeStep={activeStep} timezoneOptions={timezoneOptions} updateDraft={updateDraft} />
    </section>
  );
}

function ReviewStage({ draft }: { draft: OnboardingDraft }) {
  const meta = SETUP_LANE_META[draft.lane];
  const username = draft.account.username.trim();
  const agentName = draft.account.agentName.trim();
  const accountSummary = agentName
    ? `${username} \u00b7 agent ${agentName}`
    : `${username} \u00b7 default personal agent`;

  return (
    <section class="onboarding-stage onboarding-stage-review" data-setup-stage="review" hidden={draft.stage !== "review"}>
      <div class="onboarding-lane-banner">
        <span>Review and start</span>
      </div>
      <div class="setup-step-copy">
        <h2>Setup plan</h2>
        <p class="session-copy">This is the setup plan that will be applied before the desktop opens.</p>
      </div>
      <div class="onboarding-summary-grid">
        <article class="onboarding-summary-card">
          <span>Path</span>
          <strong data-setup-summary-lane>{meta.label}</strong>
          <p data-setup-summary-lane-copy>{meta.reviewCopy}</p>
        </article>
        <article class="onboarding-summary-card">
          <span>Account</span>
          <strong data-setup-summary-account>{accountSummary}</strong>
          <p>First desktop user and personal agent account.</p>
        </article>
        <article class="onboarding-summary-card">
          <span>Admin security</span>
          <strong data-setup-summary-admin>
            {draft.admin.mode === "custom" ? "Extra admin security layer configured" : "Account password protects admin tasks"}
          </strong>
          <p>How sensitive admin actions are protected.</p>
        </article>
        <article class="onboarding-summary-card">
          <span>Timezone</span>
          <strong data-setup-summary-timezone>{draft.system.timezone.trim() || browserTimeZone()}</strong>
          <p>Calendar basis for schedules and timestamps.</p>
        </article>
        <article class="onboarding-summary-card">
          <span>AI</span>
          <strong data-setup-summary-ai>{buildAiSummary(draft)}</strong>
          <p>Initial AI service and model behavior.</p>
        </article>
        <article class="onboarding-summary-card">
          <span>System files</span>
          <strong data-setup-summary-source>{buildSourceSummary(draft)}</strong>
          <p>The system files loaded during setup.</p>
        </article>
        <article class="onboarding-summary-card">
          <span>Device setup</span>
          <strong data-setup-summary-device>{buildDeviceSummary(draft)}</strong>
          <p>Optional setup key for connecting another machine.</p>
        </article>
      </div>
      <aside class="onboarding-review-notes">
        <div>
          <strong>You can change this later</strong>
          <p>AI defaults and system settings can be adjusted from the desktop after setup.</p>
        </div>
        <div>
          <strong>What are system files?</strong>
          <p>They define the built-in apps and settings GSV starts with.</p>
        </div>
      </aside>
    </section>
  );
}

function GuidePanel({
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

export function SetupScreen({
  snapshot,
  onboardingSnapshot,
  setupError,
  guideMessage,
  guideInputRef,
  guideLogRef,
  timezoneOptions,
  onLane,
  onBack,
  onNext,
  onSubmit,
  onGuideToggle,
  onGuideMessage,
  onGuideSend,
  onGuideKeyDown,
  updateDraft,
}: SetupScreenProps) {
  const { draft } = onboardingSnapshot;
  const busy = snapshot.phase === "authenticating";
  const showGuideToggle = draft.stage !== "welcome";
  const showNext = draft.stage === "details";
  const showSubmit = draft.stage === "review";
  const showBack = draft.stage !== "welcome";
  const guideButtonText = draft.mode === "guided" ? "Hide guide" : "Ask the guide";

  return (
    <div class="session-panel session-panel-wide onboarding-panel" data-session-setup-view hidden={snapshot.phase !== "setup"}>
      <form class="session-setup-form onboarding-layout" data-session-setup-form data-setup-stage={draft.stage} onSubmit={onSubmit}>
        <SetupSidebar draft={draft} />
        <div class="onboarding-workspace">
          <main class="onboarding-main">
            <WelcomeStage draft={draft} onLane={onLane} />
            <DetailsStage draft={draft} timezoneOptions={timezoneOptions} updateDraft={updateDraft} />
            <ReviewStage draft={draft} />
            <SessionError className="session-error onboarding-alert" message={setupError} />
            <div class="session-actions onboarding-actions">
              <button type="button" class="runtime-btn session-btn-secondary" data-setup-back hidden={!showBack} disabled={busy} onClick={onBack}>Back</button>
              <div class="onboarding-primary-actions">
                <button type="button" class="runtime-btn" data-setup-next hidden={!showNext} disabled={busy} onClick={onNext}>Next</button>
                <button type="submit" class="runtime-btn" data-setup-submit hidden={!showSubmit} disabled={busy}>Start setup</button>
                <button
                  type="button"
                  class="runtime-btn session-btn-secondary"
                  data-setup-guide-toggle
                  hidden={!showGuideToggle}
                  onClick={onGuideToggle}
                >
                  {guideButtonText}
                </button>
              </div>
            </div>
          </main>
          <GuidePanel
            snapshot={onboardingSnapshot}
            sessionSnapshot={snapshot}
            guideMessage={guideMessage}
            guideInputRef={guideInputRef}
            guideLogRef={guideLogRef}
            onGuideMessage={onGuideMessage}
            onGuideSend={onGuideSend}
            onGuideKeyDown={onGuideKeyDown}
          />
        </div>
      </form>
    </div>
  );
}
