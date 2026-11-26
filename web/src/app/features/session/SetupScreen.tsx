import { useId, useState } from "preact/hooks";
import { TextInput } from "../../components/ui/TextInput";
import { Alert } from "../../components/ui/Alert";
import { AuthLayout } from "./AuthLayout";
import { PolicyConsentLabel } from "./PolicyLinks";
import { SessionError } from "./SessionChrome";
import type { SetupAccount } from "./sessionDomain";
import { rich, useT } from "../../i18n/locale";
import "./SetupScreen.css";

type SetupScreenProps = {
  visible: boolean;
  busy: boolean;
  space: string;
  /** The owner was sent here straight from signup. */
  arrivedFromSignup?: boolean;
  /** The owner signs in by email, so setup asks for no password. */
  emailSignIn?: boolean;
  /** Setup asks nothing at all, so it started on its own; the form only offers a retry. */
  asksNothing?: boolean;
  /** The Ship is opening: nothing to fill in. */
  opening?: boolean;
  step: "credentials" | "consent";
  /** False when signup already collected the terms agreement. */
  consentRequired: boolean;
  password: string;
  passwordConfirm: string;
  consent: boolean;
  consentError: string | null;
  error: string | null;
  fieldErrors: Partial<Record<keyof SetupAccount, string>>;
  onPassword: (value: string) => void;
  onPasswordConfirm: (value: string) => void;
  onConsent: (checked: boolean) => void;
  onBack: () => void;
  onFieldBlur: (field: keyof SetupAccount, next: EventTarget | null) => void;
  onSubmitPointerDown: () => void;
  onSubmit: (event: Event) => void;
};

export function SetupScreen({ visible, busy, space, arrivedFromSignup = false, emailSignIn = false, asksNothing = false, opening = false, step, consentRequired, password, passwordConfirm, consent, consentError, error, fieldErrors, onPassword, onPasswordConfirm, onConsent, onBack, onFieldBlur, onSubmitPointerDown, onSubmit }: SetupScreenProps) {
  const t = useT();
  const consentId = useId();
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const dot = space.indexOf(".");
  const [handle, domain] = dot > 0 ? [space.slice(0, dot), space.slice(dot)] : [space, ""];
  const credentials = step === "credentials";
  const greeting = rich(t("session.setup.welcome"), { space: <span class="gsv-setup-host">{handle}<span class="gsv-setup-domain">{domain}</span></span> });
  if (opening) return <AuthLayout visible={visible} surfaceClass="gsv-auth-surface-setup">
    <section class="gsv-setup-panel" data-session-setup-view data-setup-opening aria-labelledby="setup-heading" aria-busy="true">
      <div class="gsv-setup-head">
        <h1 id="setup-heading" class="gsv-setup-greeting">{greeting}</h1>
        <p role="status">{t("session.setup.opening")}<span class="gsv-setup-loading-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span></p>
      </div>
    </section>
  </AuthLayout>;
  return <AuthLayout visible={visible} surfaceClass="gsv-auth-surface-setup">
    <section class="gsv-setup-panel" data-session-setup-view aria-labelledby="setup-heading">
      {arrivedFromSignup && credentials && !asksNothing && !noticeDismissed && <div class="gsv-setup-notice" role="status">
        <Alert variant="success" text={t("session.setup.created")} onDismiss={() => setNoticeDismissed(true)} />
      </div>}
      <div class={`gsv-setup-head${credentials ? "" : " is-consent"}`}>
        {consentRequired && <p class="gsv-setup-space">{space}</p>}
        <h1 id="setup-heading" class={credentials ? "gsv-setup-greeting" : undefined} data-setup-heading tabIndex={-1}>{credentials
          ? greeting
          : t("session.setup.beforeYouBegin")}</h1>
        {credentials && !asksNothing ? <p>{t(emailSignIn ? "session.setup.emailSignIn" : "session.setup.choosePassword")}</p> : null}
      </div>
      <form class="gsv-setup-form" data-session-setup-form aria-busy={busy} noValidate onSubmit={onSubmit}>
        {credentials ? emailSignIn ? null : <>
          <input type="hidden" name="username" autoComplete="username" value={space} />
          <TextInput label={t("session.setup.password")} type="password" value={password} disabled={busy} clearable={false}
            status={fieldErrors.password ? "error" : "none"} message={fieldErrors.password}
            placeholder={t("session.setup.passwordPlaceholder")} onChange={onPassword}
            inputProps={{ autoComplete: "new-password", maxLength: 1024, "data-setup-password": true, onBlur: (event) => onFieldBlur("password", event.relatedTarget) }} />
          <TextInput label={t("session.setup.confirmPassword")} type="password" value={passwordConfirm} disabled={busy} clearable={false}
            status={fieldErrors.passwordConfirm ? "error" : "none"} message={fieldErrors.passwordConfirm}
            placeholder={t("session.setup.confirmPlaceholder")} onChange={onPasswordConfirm}
            inputProps={{ autoComplete: "new-password", maxLength: 1024, "data-setup-password-confirm": true, onBlur: (event) => onFieldBlur("passwordConfirm", event.relatedTarget) }} />
        </> : <div class="gsv-setup-agreement">
          <div class="gsv-setup-disclosure">
            <p>{t("session.setup.aboutShip")}</p>
            <p>{t("session.setup.aboutAccess")}</p>
            <p>{t("session.setup.aboutRisk")}</p>
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
            {consentError ? <p class="gsv-setup-consent-error" id={`${consentId}-error`} role="alert">{consentError}</p> : null}
          </div>
        </div>}
        <SessionError message={error} />
        <div class="gsv-setup-actions">
          {step === "consent" ? <button type="button" class="ibtn" disabled={busy} onClick={onBack}>{t("session.back")}</button> : null}
          <button type="submit" class="ibtn is-primary" data-setup-submit disabled={busy}
            onPointerDown={(event) => { if (event.button === 0) onSubmitPointerDown(); }}>
            {busy ? <span role="status" aria-label={t("session.setup.opening")}>
              <span aria-hidden="true">{t("session.setup.opening")}<span class="gsv-setup-loading-dots"><span>.</span><span>.</span><span>.</span></span></span>
            </span> : t(asksNothing ? "session.retry" : credentials && consentRequired ? "session.continue" : "session.setup.activate")}
          </button>
        </div>
      </form>
    </section>
  </AuthLayout>;
}
