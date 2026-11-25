import { Alert } from "../../components/ui/Alert";
import { SectionHeader } from "../../components/ui/SectionHeader";
import { TextInput } from "../../components/ui/TextInput";
import { Button } from "../../components/ui/Button";
import { AuthLayout } from "./AuthLayout";
import { AppLink } from "../../services/navigation/appNavigation";
import { rich, useT } from "../../i18n/locale";
import type { EmailSignInView } from "./useEmailSignIn";
import "./LoginScreen.css";

type LoginScreenProps = {
  visible: boolean;
  /** While booting/initializing, render the box as a progressive skeleton. */
  loading?: boolean;
  busy: boolean;
  space: string;
  error: string | null;
  /** How the personal account signs in; the administrator always uses its password. */
  method: "email" | "password";
  /** Present where the Ship takes email sign-in. */
  email: EmailSignInView | null;
  onMethod: (method: "email" | "password") => void;
  administrator: boolean;
  password: string;
  onAdministrator: (value: boolean) => void;
  onPassword: (value: string) => void;
  onSubmit: (event: Event) => void;
};

/** On-brand skeleton (periwinkle shimmer) shown while the session is booting. */
function LoginSkeleton() {
  const t = useT();
  return (
    <div class="gsv-login-skeleton" role="status" aria-label={t("session.login.loading")} aria-busy="true">
      <div class="gsv-skel-field">
        <span class="gsv-skel gsv-skel-label" />
        <span class="gsv-skel gsv-skel-input" />
      </div>
      <span class="gsv-skel gsv-skel-btn" />
    </div>
  );
}

export function LoginScreen({
  visible,
  loading = false,
  busy,
  space,
  error,
  method,
  email,
  onMethod,
  administrator,
  password,
  onAdministrator,
  onPassword,
  onSubmit,
}: LoginScreenProps) {
  const t = useT();
  return (
    <AuthLayout background="galaxy" visible={visible} surfaceClass="gsv-auth-surface-login">
      <div class="gsv-login-panel" data-session-login-view>
          <SectionHeader title={t(administrator ? "session.login.adminTitle" : "session.login.welcomeBack")} titleSize="title" divider />

          <div class="gsv-login-body">
            {loading ? (
              <LoginSkeleton />
            ) : method === "email" && email ? (
              <EmailSignInForm view={email} error={email.error ?? error} busy={busy} onPassword={() => onMethod("password")} />
            ) : (
              <form class="gsv-login-fields" onSubmit={onSubmit}>
              <input type="hidden" name="username" autoComplete="username" value={administrator ? "root" : space} />
              <TextInput
                label={t("session.login.password")}
                type="password"
                placeholder="••••••••••••"
                value={password}
                clearable={false}
                onChange={onPassword}
                inputProps={{ autoComplete: "current-password", "data-session-password": true }}
              />

              {/* Historical placement of the removed token control: */}
              {/* "Use token instead" — directly under the password input. */}

              {error ? (
                <div class="gsv-login-error" role="alert">
                  <Alert variant="error" text={error} />
                </div>
              ) : null}

              <div class="gsv-login-submit">
                <Button
                  variant="primary"
                  label={t("session.login.signIn")}
                  block
                  disabled={busy}
                  type="submit"
                />
              </div>
              <div class="gsv-login-links">
                {email && <button type="button" class="gsv-auth-link" onClick={() => onMethod("email")}>{t("session.login.useEmail")}</button>}
                <AppLink href="/recover-member" class="gsv-auth-link gsv-login-recovery-link">{t(administrator ? "session.login.forgotAdminPassword" : "session.login.forgotPassword")}</AppLink>
              </div>
              </form>
            )}
          </div>

          <footer class="gsv-sublabel gsv-login-credit">
            <span>{rich(t("session.login.credit"), { maker: <a href="https://humansandmachin.es" target="_blank" rel="noreferrer">HUMANS &amp; MACHINES</a> })}</span>
            <button type="button" class="gsv-login-admin" aria-label={t(administrator ? "session.login.personalLabel" : "session.login.adminLabel")} disabled={busy || loading} onClick={() => onAdministrator(!administrator)}>{t(administrator ? "session.login.personal" : "session.login.admin")}</button>
          </footer>
        </div>
    </AuthLayout>
  );
}

/** A code to the owner's email, then the code; the email's button can finish it in this browser instead. */
function EmailSignInForm({ view, error, busy, onPassword }: { view: EmailSignInView; error: string | null; busy: boolean; onPassword: () => void }) {
  const t = useT();
  const working = busy || view.busy;
  const code = view.step === "code";
  return (
    <form class="gsv-login-fields" onSubmit={view.onSubmit} noValidate>
      {code ? <>
        <input type="hidden" name="username" autoComplete="username" value={view.email} />
        {view.notice && <p class="gsv-login-note" role="status">{view.notice}</p>}
        <TextInput
          label={t("session.login.code")}
          placeholder="000000"
          value={view.code}
          clearable={false}
          onChange={view.onCode}
          inputProps={{ autoComplete: "one-time-code", inputMode: "numeric", maxLength: 7, "data-session-code": true }}
        />
      </> : <TextInput
        label={t("session.login.email")}
        type="email"
        placeholder={t("session.login.emailPlaceholder")}
        value={view.email}
        clearable={false}
        onChange={view.onEmail}
        inputProps={{ autoComplete: "email", inputMode: "email", maxLength: 254, "data-session-email": true }}
      />}

      {error ? (
        <div class="gsv-login-error" role="alert">
          <Alert variant="error" text={error} />
        </div>
      ) : null}

      <div class="gsv-login-submit">
        <Button variant="primary" block type="submit" disabled={working}
          label={t(code ? "session.login.signIn" : view.busy ? "session.login.sending" : "session.login.sendCode")} />
      </div>
      <div class="gsv-login-links">
        {code && <button type="button" class="gsv-auth-link" disabled={working || !view.canResend} onClick={view.onResend}>{t("session.login.resend")}</button>}
        {code && <button type="button" class="gsv-auth-link" disabled={working} onClick={view.onOtherEmail}>{t("session.login.otherEmail")}</button>}
        <button type="button" class="gsv-auth-link" disabled={working} onClick={onPassword}>{t("session.login.usePassword")}</button>
      </div>
    </form>
  );
}
