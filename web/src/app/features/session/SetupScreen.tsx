import { useId } from "preact/hooks";
import { TextInput } from "../../components/ui/TextInput";
import { AuthLayout } from "./AuthLayout";
import { PrivacyPolicyLink, TermsOfServiceLink } from "./PolicyLinks";
import { SessionError } from "./SessionChrome";
import type { SetupAccount, SetupAccountErrors } from "./sessionDomain";
import "./SetupScreen.css";

type SetupScreenProps = {
  visible: boolean;
  busy: boolean;
  space: string;
  step: "credentials" | "consent";
  password: string;
  passwordConfirm: string;
  consent: boolean;
  consentError: string | null;
  error: string | null;
  fieldErrors: SetupAccountErrors;
  onPassword: (value: string) => void;
  onPasswordConfirm: (value: string) => void;
  onConsent: (checked: boolean) => void;
  onBack: () => void;
  onFieldBlur: (field: keyof SetupAccount, next: EventTarget | null) => void;
  onSubmitPointerDown: () => void;
  onSubmit: (event: Event) => void;
};

export function SetupScreen({ visible, busy, space, step, password, passwordConfirm, consent, consentError, error, fieldErrors, onPassword, onPasswordConfirm, onConsent, onBack, onFieldBlur, onSubmitPointerDown, onSubmit }: SetupScreenProps) {
  const consentId = useId();
  return <AuthLayout visible={visible} surfaceClass="gsv-auth-surface-setup">
    <section class="gsv-setup-panel" data-session-setup-view aria-labelledby="setup-heading">
      <div class={`gsv-setup-head${step === "consent" ? " is-consent" : ""}`}>
        <div class="gsv-setup-meta">
          <p class="gsv-setup-space">{space}</p>
          <p class="gsv-setup-progress">Step {step === "credentials" ? 1 : 2} of 2</p>
        </div>
        <h1 id="setup-heading" data-setup-heading tabIndex={-1}>{step === "credentials" ? "Welcome to your space" : "Before you begin"}</h1>
        {step === "credentials" ? <p>Choose a password for your space.</p> : null}
      </div>
      <form class="gsv-setup-form" data-session-setup-form aria-busy={busy} noValidate onSubmit={onSubmit}>
        {step === "credentials" ? <>
          <input type="hidden" name="username" autoComplete="username" value={space} />
          <TextInput label="Password" type="password" value={password} disabled={busy} clearable={false}
            status={fieldErrors.password ? "error" : "none"} message={fieldErrors.password}
            placeholder="At least 8 characters" onChange={onPassword}
            inputProps={{ autoComplete: "new-password", maxLength: 1024, "data-setup-password": true, onBlur: (event) => onFieldBlur("password", event.relatedTarget) }} />
          <TextInput label="Confirm password" type="password" value={passwordConfirm} disabled={busy} clearable={false}
            status={fieldErrors.passwordConfirm ? "error" : "none"} message={fieldErrors.passwordConfirm}
            placeholder="Enter your password again" onChange={onPasswordConfirm}
            inputProps={{ autoComplete: "new-password", maxLength: 1024, "data-setup-password-confirm": true, onBlur: (event) => onFieldBlur("passwordConfirm", event.relatedTarget) }} />
        </> : <div class="gsv-setup-agreement">
          <div class="gsv-setup-disclosure">
            <p>GSV is an AI assistant that can use your computer and connected services to get things done.</p>
            <p>Depending on what you allow, it can work with files, run commands, use websites and signed-in services, and send communications on your behalf.</p>
            <p>GSV is in early access and can make mistakes. Some actions can be difficult to undo, so keep backups of important data and review consequential actions carefully.</p>
          </div>
          <div class={`gsv-setup-consent${consentError ? " is-error" : ""}`}>
            <div class="gsv-setup-consent-row">
              <input id={consentId} type="checkbox" required checked={consent} disabled={busy}
                aria-labelledby={`${consentId}-label`}
                aria-invalid={consentError ? true : undefined}
                aria-describedby={consentError ? `${consentId}-error` : undefined}
                onChange={(event) => onConsent(event.currentTarget.checked)} />
              <span id={`${consentId}-label`}><label for={consentId}>I confirm that I’m 18 or older and agree to the </label>
                <TermsOfServiceLink /> <label for={consentId}>and acknowledge the </label><PrivacyPolicyLink />.</span>
            </div>
            {consentError ? <p class="gsv-setup-consent-error" id={`${consentId}-error`} role="alert">Confirm your age and agreement to continue.</p> : null}
          </div>
        </div>}
        <SessionError message={error} />
        <div class="gsv-setup-actions">
          {step === "consent" ? <button type="button" class="ibtn" disabled={busy} onClick={onBack}>Back</button> : null}
          <button type="submit" class="ibtn is-primary" data-setup-submit disabled={busy}
            onPointerDown={(event) => { if (event.button === 0) onSubmitPointerDown(); }}>
            {busy ? "Opening your space…" : step === "credentials" ? "Continue" : "Create account"}
          </button>
        </div>
      </form>
    </section>
  </AuthLayout>;
}
