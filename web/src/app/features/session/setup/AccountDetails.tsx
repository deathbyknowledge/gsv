import type { OnboardingDetailStep, OnboardingDraft } from "@humansandmachines/gsv/protocol";
import { TextInput } from "../../../components/ui/TextInput";
import "./AccountDetails.css";

export function AccountDetails({
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
      <div class="account-details-fields">
        <TextInput
          label="Username"
          type="text"
          requirement="required"
          placeholder="e.g. hank"
          value={draft.account.username}
          inputProps={{ autoComplete: "username" }}
          onChange={(value) => updateDraft((current) => ({
            ...current,
            account: { ...current.account, username: value },
          }))}
        />
        <TextInput
          label="Personal agent username"
          type="text"
          requirement="optional"
          placeholder="e.g. friday"
          description="Leave blank to use the next available default name."
          value={draft.account.agentName}
          inputProps={{ autoComplete: "off" }}
          onChange={(value) => updateDraft((current) => ({
            ...current,
            account: { ...current.account, agentName: value },
          }))}
        />
        <TextInput
          label="Password"
          type="password"
          requirement="required"
          placeholder="••••••••"
          value={draft.account.password}
          inputProps={{ autoComplete: "new-password" }}
          onChange={(value) => updateDraft((current) => ({
            ...current,
            account: { ...current.account, password: value },
          }))}
        />
        <TextInput
          label="Confirm password"
          type="password"
          requirement="required"
          placeholder="••••••••"
          value={draft.account.passwordConfirm}
          inputProps={{ autoComplete: "new-password" }}
          onChange={(value) => updateDraft((current) => ({
            ...current,
            account: { ...current.account, passwordConfirm: value },
          }))}
        />
      </div>
      <div class="account-details-note">
        <strong>Keep this password safe.</strong>
        <p>GSV does not store a recoverable copy. Losing it can lock you out of this workspace.</p>
      </div>
    </section>
  );
}
