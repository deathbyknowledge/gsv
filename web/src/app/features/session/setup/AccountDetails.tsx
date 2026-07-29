import type { OnboardingDetailStep, OnboardingDraft } from "@humansandmachines/gsv/protocol";
import { TextInput } from "../../../components/ui/TextInput";
import { Alert } from "../../../components/ui/Alert";
import { USERNAME_FORMAT_DESCRIPTION, isValidUsername } from "../sessionDomain";
import "./AccountDetails.css";

const FORMAT_ERROR = "1-32 chars: lowercase letters, numbers, _ or -, starting with a letter or _.";

export function AccountDetails({
  draft,
  activeStep,
  updateDraft,
}: {
  draft: OnboardingDraft;
  activeStep: OnboardingDetailStep;
  updateDraft: (updater: (draft: OnboardingDraft) => OnboardingDraft) => void;
}) {
  const usernameValue = draft.account.username;
  const usernameInvalid = usernameValue.length > 0 && !isValidUsername(usernameValue);
  const agentValue = draft.account.agentName;
  const agentInvalid = agentValue.trim().length > 0 && !isValidUsername(agentValue);

  return (
    <section class="onboarding-section" data-setup-detail-step="account" hidden={draft.stage !== "details" || activeStep !== "account"}>
      <div class="account-details-fields">
        <TextInput
          label="Username"
          type="text"
          requirement="required"
          placeholder="e.g. hank"
          info={USERNAME_FORMAT_DESCRIPTION}
          value={draft.account.username}
          status={usernameInvalid ? "error" : "none"}
          message={usernameInvalid ? FORMAT_ERROR : ""}
          inputProps={{ autoComplete: "username" }}
          onChange={(value) => updateDraft((current) => ({
            ...current,
            account: { ...current.account, username: value.toLowerCase() },
          }))}
        />
        <TextInput
          label="Personal agent username"
          type="text"
          requirement="optional"
          placeholder="e.g. friday"
          info={`Leave blank to use the next available default name. ${USERNAME_FORMAT_DESCRIPTION}`}
          value={draft.account.agentName}
          status={agentInvalid ? "error" : "none"}
          message={agentInvalid ? FORMAT_ERROR : ""}
          inputProps={{ autoComplete: "off" }}
          onChange={(value) => updateDraft((current) => ({
            ...current,
            account: { ...current.account, agentName: value.toLowerCase() },
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
      <Alert
        variant="attention"
        title="Keep this password safe."
        text="GSV does not store a recoverable copy. Losing it can lock you out of this workspace."
      />
    </section>
  );
}
