import { Alert } from "../../components/ui/Alert";
import { SectionHeader } from "../../components/ui/SectionHeader";
import { TextInput } from "../../components/ui/TextInput";
import { Button } from "../../components/ui/Button";
import { AuthLayout } from "./AuthLayout";
import { AppLink } from "../../services/navigation/appNavigation";
import { rich, useT } from "../../i18n/locale";
import "./LoginScreen.css";

type LoginScreenProps = {
  visible: boolean;
  /** While booting/initializing, render the box as a progressive skeleton. */
  loading?: boolean;
  busy: boolean;
  space: string;
  error: string | null;
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
              {!administrator && <AppLink href="/recover-member" class="gsv-auth-link gsv-login-recovery-link">{t("session.login.forgotPassword")}</AppLink>}
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
