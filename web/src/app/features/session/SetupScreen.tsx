import { useId } from "preact/hooks";
import { TextInput } from "../../components/ui/TextInput";
import { AuthLayout } from "./AuthLayout";
import { SessionError } from "./SessionChrome";
import { USERNAME_FORMAT_DESCRIPTION, type SetupAccount, type SetupAccountErrors } from "./sessionDomain";
import "./SetupScreen.css";

type SetupScreenProps = {
  visible: boolean;
  busy: boolean;
  space: string;
  username: string;
  password: string;
  passwordConfirm: string;
  consent: boolean;
  consentError: string | null;
  error: string | null;
  fieldErrors: SetupAccountErrors;
  onUsername: (value: string) => void;
  onPassword: (value: string) => void;
  onPasswordConfirm: (value: string) => void;
  onConsent: (checked: boolean) => void;
  onFieldBlur: (field: keyof SetupAccount) => void;
  onSubmit: (event: Event) => void;
};

export function SetupScreen({ visible, busy, space, username, password, passwordConfirm, consent, consentError, error, fieldErrors, onUsername, onPassword, onPasswordConfirm, onConsent, onFieldBlur, onSubmit }: SetupScreenProps) {
  const consentId = useId();
  return <AuthLayout visible={visible} surfaceClass="gsv-auth-surface-setup">
    <section class="gsv-setup-panel" data-session-setup-view aria-labelledby="setup-heading">
      <div class="gsv-setup-head">
        <p class="gsv-setup-space">{space}</p>
        <h1 id="setup-heading">Welcome to your space</h1>
        <p>Create your sign-in, then start talking with your Ship.</p>
      </div>
      <form class="gsv-setup-form" data-session-setup-form aria-busy={busy} noValidate onSubmit={onSubmit}>
        <TextInput label="Username" value={username} disabled={busy} info={USERNAME_FORMAT_DESCRIPTION}
          status={fieldErrors.username ? "error" : "none"} message={fieldErrors.username}
          placeholder="Choose a username" onChange={onUsername}
          inputProps={{ autoComplete: "username", maxLength: 32, "data-setup-username": true, onBlur: () => onFieldBlur("username") }} />
        <TextInput label="Password" type="password" value={password} disabled={busy} clearable={false}
          status={fieldErrors.password ? "error" : "none"} message={fieldErrors.password}
          placeholder="At least 8 characters" onChange={onPassword}
          inputProps={{ autoComplete: "new-password", maxLength: 1024, "data-setup-password": true, onBlur: () => onFieldBlur("password") }} />
        <TextInput label="Confirm password" type="password" value={passwordConfirm} disabled={busy} clearable={false}
          status={fieldErrors.passwordConfirm ? "error" : "none"} message={fieldErrors.passwordConfirm}
          placeholder="Enter your password again" onChange={onPasswordConfirm}
          inputProps={{ autoComplete: "new-password", maxLength: 1024, "data-setup-password-confirm": true, onBlur: () => onFieldBlur("passwordConfirm") }} />
        <p class="gsv-setup-note">This sign-in is for this space.</p>
        <div class="gsv-setup-agreement">
          <div class="gsv-setup-disclosure">
            <p>GSV is an AI assistant that can use your computer and connected services to get things done.</p>
            <p>Depending on what you allow, it can work with files, run commands, use websites and signed-in services, and send communications on your behalf.</p>
            <p>GSV is in early access and can make mistakes. Some actions can be difficult to undo, so keep backups of important data and review consequential actions carefully.</p>
          </div>
          <div class={`gsv-setup-consent${consentError ? " is-error" : ""}`}>
            <label for={consentId}>
              <input id={consentId} type="checkbox" required checked={consent} disabled={busy}
                aria-invalid={consentError ? true : undefined}
                aria-describedby={consentError ? `${consentId}-error` : undefined}
                onChange={(event) => onConsent(event.currentTarget.checked)} />
              <span>I confirm that I’m 18 or older and agree to the <a href="https://gsv.space/terms" target="_blank" rel="noopener noreferrer">Terms of Service</a> and acknowledge the <a href="https://gsv.space/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.</span>
            </label>
            {consentError ? <p class="gsv-setup-consent-error" id={`${consentId}-error`} role="alert">{consentError}</p> : null}
          </div>
        </div>
        <SessionError message={error} />
        <div class="gsv-setup-actions">
          <button type="submit" class="ibtn is-primary" data-setup-submit disabled={busy}>
            {busy ? "Opening your space…" : "Create account"}
          </button>
        </div>
      </form>
    </section>
  </AuthLayout>;
}
