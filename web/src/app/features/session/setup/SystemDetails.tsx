import type { OnboardingDetailStep, OnboardingDraft } from "@humansandmachines/gsv/protocol";
import { Checkbox } from "../../../components/ui/Checkbox";
import { Select } from "../../../components/ui/Select";
import { TextInput } from "../../../components/ui/TextInput";
import { OnboardingHelp } from "../SessionChrome";
import { advancedSectionsVisible } from "../sessionDomain";
import { checkedInputValue, textInputValue } from "../sessionViewUtils";
import "./SystemDetails.css";

export function SystemDetails({
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
  const timezoneIndex = Math.max(0, options.indexOf(draft.system.timezone));

  return (
    <section class="onboarding-section gsv-setup-preferences" data-setup-detail-step="system" hidden={draft.stage !== "details" || activeStep !== "system"}>
      <div class="gsv-setup-preference-group">
        <div class="gsv-setup-section-head">
          <h3>Admin security</h3>
          <p>Choose whether sensitive admin actions need a second password.</p>
        </div>
        <div class="system-details-fields">
          <div data-setup-admin-custom>
            <Checkbox
              label="Include extra security layer for admin tasks"
              checked={draft.admin.mode === "custom"}
              onChange={(checked) => updateDraft((current) => ({
                ...current,
                admin: {
                  ...current.admin,
                  mode: checked ? "custom" : "same",
                },
              }))}
            />
          </div>
          <div hidden={draft.admin.mode !== "custom"} data-setup-root-row>
            <TextInput
              label="Define admin password"
              type="password"
              placeholder="••••••••"
              disabled={draft.admin.mode !== "custom"}
              value={draft.admin.password}
              inputProps={{ "data-setup-root-password": true, autoComplete: "new-password" }}
              onChange={(value) => updateDraft((current) => ({
                ...current,
                admin: {
                  ...current.admin,
                  password: value,
                },
              }))}
            />
          </div>
          <div hidden={draft.admin.mode !== "custom"} data-setup-root-confirm-row>
            <TextInput
              label="Confirm admin password"
              type="password"
              placeholder="••••••••"
              disabled={draft.admin.mode !== "custom"}
              value={draft.admin.passwordConfirm}
              inputProps={{ "data-setup-root-password-confirm": true, autoComplete: "new-password" }}
              onChange={(value) => updateDraft((current) => ({
                ...current,
                admin: {
                  ...current.admin,
                  passwordConfirm: value,
                },
              }))}
            />
          </div>
        </div>
        <OnboardingHelp label="Explain admin security" tooltipId="setup-help-admin" title="Why?">
          A separate admin password adds a second check for sensitive system actions.
        </OnboardingHelp>
      </div>

      <div class="gsv-setup-preference-group">
        <div class="gsv-setup-section-head">
          <h3>Timezone</h3>
          <p>Used for schedules, calendars, and timestamp displays.</p>
        </div>
        <div class="system-details-fields">
          <Select
            label="Timezone"
            options={options}
            value={timezoneIndex}
            onChange={(index) => updateDraft((current) => ({
              ...current,
              system: {
                ...current.system,
                timezone: options[index],
              },
            }))}
          />
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
