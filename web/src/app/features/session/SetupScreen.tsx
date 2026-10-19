import { useId, useState } from "preact/hooks";
import { TextInput } from "../../components/ui/TextInput";
import { Alert } from "../../components/ui/Alert";
import { AuthLayout } from "./AuthLayout";
import { PolicyConsentLabel } from "./PolicyLinks";
import { SessionError } from "./SessionChrome";
import type { SetupAccount, SetupAccountErrors } from "./sessionDomain";
import "./SetupScreen.css";

type SetupScreenProps = {
  visible: boolean;
  busy: boolean;
  space: string;
  /** The owner was sent here straight from signup. */
  arrivedFromSignup?: boolean;
  step: "credentials" | "consent";
  /** False when signup already collected the terms agreement. */
  consentRequired: boolean;
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

export function SetupScreen({ visible, busy, space, arrivedFromSignup = false, step, consentRequired, password, passwordConfirm, consent, consentError, error, fieldErrors, onPassword, onPasswordConfirm, onConsent, onBack, onFieldBlur, onSubmitPointerDown, onSubmit }: SetupScreenProps) {
  const consentId = useId();
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const dot = space.indexOf(".");
  const [handle, domain] = dot > 0 ? [space.slice(0, dot), space.slice(dot)] : [space, ""];
  const credentials = step === "credentials";
  return <AuthLayout visible={visible} surfaceClass="gsv-auth-surface-setup">
    <section class="gsv-setup-panel" data-session-setup-view aria-labelledby="setup-heading">
      {arrivedFromSignup && credentials && !noticeDismissed && <div class="gsv-setup-notice" role="status">
        <Alert variant="success" text="Your Ship has been created." onDismiss={() => setNoticeDismissed(true)} />
      </div>}
      <div class={`gsv-setup-head${credentials ? "" : " is-consent"}`}>
        {consentRequired && <div class="gsv-setup-meta">
          <p class="gsv-setup-space">{space}</p>
          <p class="gsv-setup-progress">Step {credentials ? 1 : 2} of 2</p>
        </div>}
        <h1 id="setup-heading" data-setup-heading tabIndex={-1}>{credentials
          ? <><span class="gsv-setup-greeting">Welcome to</span> <span class="gsv-setup-host">{handle}<span class="gsv-setup-domain">{domain}</span></span></>
          : "Before you begin"}</h1>
        {credentials ? <p>Choose a password.</p> : null}
      </div>
      <form class="gsv-setup-form" data-session-setup-form aria-busy={busy} noValidate onSubmit={onSubmit}>
        {credentials ? <>
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
            <p>Ship is an AI assistant that can use your computer and connected services to get things done.</p>
            <p>Depending on what you allow, it can work with files, run commands, use websites and signed-in services, and send communications on your behalf.</p>
            <p>Ship is in early access and can make mistakes. Some actions can be difficult to undo, so keep backups of important data and review consequential actions carefully.</p>
          </div>
          <div class={`gsv-setup-consent${consentError ? " is-error" : ""}`}>
            <div class="gsv-setup-consent-row">
              <input id={consentId} type="checkbox" required checked={consent} disabled={busy}
                aria-labelledby={`${consentId}-label`}
                aria-invalid={consentError ? true : undefined}
                aria-describedby={consentError ? `${consentId}-error` : undefined}
                onChange={(event) => onConsent(event.currentTarget.checked)} />
              <PolicyConsentLabel id={consentId} />
            </div>
            {consentError ? <p class="gsv-setup-consent-error" id={`${consentId}-error`} role="alert">Confirm your age and agreement to continue.</p> : null}
          </div>
        </div>}
        <SessionError message={error} />
        <div class="gsv-setup-actions">
          {step === "consent" ? <button type="button" class="ibtn" disabled={busy} onClick={onBack}>Back</button> : null}
          <button type="submit" class="ibtn is-primary" data-setup-submit disabled={busy}
            onPointerDown={(event) => { if (event.button === 0) onSubmitPointerDown(); }}>
            {busy ? "Opening Ship…" : credentials && consentRequired ? "Continue" : "Activate Ship"}
          </button>
        </div>
      </form>
    </section>
  </AuthLayout>;
}
