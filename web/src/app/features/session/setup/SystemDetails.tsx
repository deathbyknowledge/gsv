import type { OnboardingDetailStep, OnboardingDraft } from "@humansandmachines/gsv/protocol";
import { useEffect } from "preact/hooks";
import { Checkbox } from "../../../components/ui/Checkbox";
import { Select } from "../../../components/ui/Select";
import { TextInput } from "../../../components/ui/TextInput";
import { Toggle } from "../../../components/ui/Toggle";
import { InfoTip } from "../../../components/ui/InfoTip";
import { aiProviderOptionsForValue, aiProviderSelectIndex } from "../../../domain/aiProviders";
import { advancedSectionsVisible } from "../sessionDomain";
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
  const aiProviderOptions = aiProviderOptionsForValue(draft.ai.provider);
  const aiProviderLabels = aiProviderOptions.map((option) => option.label);
  const aiProviderIndex = aiProviderSelectIndex(aiProviderOptions, draft.ai.provider);
  const defaultAiProvider = aiProviderOptions[0]?.value ?? "";

  useEffect(() => {
    if (!showAiRows || draft.ai.provider.trim() || !defaultAiProvider) {
      return;
    }
    updateDraft((current) => {
      if (!advancedSectionsVisible(current) || !current.ai.enabled || current.ai.provider.trim()) {
        return current;
      }
      return {
        ...current,
        ai: { ...current.ai, provider: defaultAiProvider },
      };
    });
  }, [defaultAiProvider, draft.ai.provider, showAiRows, updateDraft]);

  return (
    <section class="onboarding-section gsv-setup-preferences" data-setup-detail-step="system" hidden={draft.stage !== "details" || activeStep !== "system"}>
      <div class="gsv-setup-preference-group">
        <div class="gsv-setup-section-head">
          <h3>
            Admin security
            <InfoTip
              position="right"
              label="Explain admin security"
              text="A separate admin password adds a second check for sensitive system actions."
            />
          </h3>
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
      </div>

      <div class="gsv-setup-preference-group">
        <div class="gsv-setup-section-head">
          <h3>Timezone</h3>
          <p>Used for schedules, calendars, and timestamp displays.</p>
        </div>
        <div class="system-details-fields">
          <Select
            label="Timezone"
            block
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

      <div class="gsv-setup-preference-group" data-setup-ai-section hidden={!showAdvanced}>
        <div class="gsv-setup-section-head">
          <h3>
            AI defaults
            <InfoTip
              position="right"
              label="Explain AI defaults"
              text="These settings choose the default AI service GSV uses after setup. You can change them later from settings."
            />
          </h3>
          <p>Keep the default AI path, or choose the AI service and model from the start.</p>
        </div>
        <div class="system-details-fields">
          <div data-setup-ai-enabled>
            <Toggle
              label="Customize AI settings"
              on={draft.ai.enabled}
              disabled={!showAdvanced}
              onChange={(checked) => updateDraft((current) => ({
                ...current,
                ai: {
                  ...current.ai,
                  enabled: checked,
                  provider: checked && !current.ai.provider.trim()
                    ? defaultAiProvider
                    : current.ai.provider,
                },
              }))}
            />
          </div>
          <div data-setup-ai-provider-row hidden={!showAiRows}>
            <Select
              label="AI service"
              block
              options={aiProviderLabels}
              value={aiProviderIndex}
              disabled={!showAiRows}
              onChange={(index) => updateDraft((current) => ({
                ...current,
                ai: { ...current.ai, provider: aiProviderOptions[index]?.value ?? "" },
              }))}
            />
          </div>
          <div data-setup-ai-model-row hidden={!showAiRows}>
            <TextInput
              label="AI model"
              placeholder="gpt-5.4"
              disabled={!showAiRows}
              value={draft.ai.model}
              inputProps={{ "data-setup-ai-model": true, autoComplete: "off" }}
              onChange={(value) => updateDraft((current) => ({
                ...current,
                ai: { ...current.ai, model: value },
              }))}
            />
          </div>
          <div data-setup-ai-key-row hidden={!showAiRows}>
            <TextInput
              label="API key"
              type="password"
              placeholder="sk-…"
              disabled={!showAiRows}
              value={draft.ai.apiKey}
              inputProps={{ "data-setup-ai-key": true, autoComplete: "off" }}
              onChange={(value) => updateDraft((current) => ({
                ...current,
                ai: { ...current.ai, apiKey: value },
              }))}
            />
          </div>
        </div>
      </div>

      <div class="gsv-setup-preference-group" data-setup-source-section hidden={!showAdvanced}>
        <div class="gsv-setup-section-head">
          <h3>
            System files
            <InfoTip
              position="right"
              label="Explain system files"
              text="System files are the built-in apps and settings GSV starts with. Advanced users can point this at a Git repository or remote URL; Version can be a branch, tag, or commit."
            />
          </h3>
          <p>Use the official system files, or choose a repository and version you control.</p>
        </div>
        <div class="system-details-fields">
          <div data-setup-source-enabled>
            <Toggle
              label="Use custom system files"
              on={draft.source.enabled}
              disabled={!showAdvanced}
              onChange={(checked) => updateDraft((current) => ({
                ...current,
                source: { ...current.source, enabled: checked },
              }))}
            />
          </div>
          <div data-setup-source-row hidden={!showSourceRows}>
            <TextInput
              label="System files location"
              placeholder="deathbyknowledge/gsv"
              disabled={!showSourceRows}
              value={draft.source.value}
              inputProps={{ "data-setup-bootstrap-source": true, autoComplete: "off" }}
              onChange={(value) => updateDraft((current) => ({
                ...current,
                source: { ...current.source, value },
              }))}
            />
          </div>
          <div data-setup-source-ref-row hidden={!showSourceRows}>
            <TextInput
              label="Version"
              placeholder="main"
              disabled={!showSourceRows}
              value={draft.source.ref}
              inputProps={{ "data-setup-bootstrap-ref": true, autoComplete: "off" }}
              onChange={(value) => updateDraft((current) => ({
                ...current,
                source: { ...current.source, ref: value },
              }))}
            />
          </div>
        </div>
      </div>

      <div class="gsv-setup-preference-group" data-setup-node-section hidden={!showAdvanced}>
        <div class="gsv-setup-section-head">
          <h3>
            Device setup
            <InfoTip
              position="right"
              label="Explain device setup"
              text="A setup key lets another machine connect to this workspace. Only create one now if you are ready to connect a device."
            />
          </h3>
          <p>Create a setup key now if you want another machine to connect immediately.</p>
        </div>
        <div class="system-details-fields">
          <div data-setup-node-enabled>
            <Toggle
              label="Create a device setup key now"
              on={draft.device.enabled}
              disabled={!showAdvanced}
              onChange={(checked) => updateDraft((current) => ({
                ...current,
                device: { ...current.device, enabled: checked },
              }))}
            />
          </div>
          <div data-setup-node-device-row hidden={!showNodeRows}>
            <TextInput
              label="Device ID"
              placeholder="node-rearden"
              disabled={!showNodeRows}
              value={draft.device.deviceId}
              inputProps={{ "data-setup-node-device-id": true, autoComplete: "off" }}
              onChange={(value) => updateDraft((current) => ({
                ...current,
                device: { ...current.device, deviceId: value },
              }))}
            />
          </div>
          <div data-setup-node-label-row hidden={!showNodeRows}>
            <TextInput
              label="Label"
              placeholder="rearden"
              disabled={!showNodeRows}
              value={draft.device.label}
              inputProps={{ "data-setup-node-label": true, autoComplete: "off" }}
              onChange={(value) => updateDraft((current) => ({
                ...current,
                device: { ...current.device, label: value },
              }))}
            />
          </div>
          <div data-setup-node-expiry-row hidden={!showNodeRows}>
            <TextInput
              label="Expires in days"
              placeholder="30"
              disabled={!showNodeRows}
              value={draft.device.expiryDays}
              inputProps={{ "data-setup-node-expiry": true, autoComplete: "off", inputMode: "numeric" }}
              onChange={(value) => updateDraft((current) => ({
                ...current,
                device: { ...current.device, expiryDays: value },
              }))}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
