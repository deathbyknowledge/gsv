import { Alert } from "../../components/ui/Alert";
import { SectionHeader } from "../../components/ui/SectionHeader";
import { TextInput } from "../../components/ui/TextInput";
import { Button } from "../../components/ui/Button";
import { AuthLayout } from "./AuthLayout";
import { SessionLink } from "./sessionNavigation";
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
  return (
    <div class="gsv-login-skeleton" role="status" aria-label="Loading" aria-busy="true">
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
  return (
    <AuthLayout background="galaxy" visible={visible} surfaceClass="gsv-auth-surface-login">
      <div class="gsv-login-panel" data-session-login-view>
          <SectionHeader title={administrator ? "ADMINISTRATOR SIGN-IN" : "WELCOME BACK"} titleSize="title" divider />

          <div class="gsv-login-body">
            {loading ? (
              <LoginSkeleton />
            ) : (
              <form class="gsv-login-fields" onSubmit={onSubmit}>
              <input type="hidden" name="username" autoComplete="username" value={administrator ? "root" : space} />
              <TextInput
                label="PASSWORD"
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
                  label="SIGN IN"
                  block
                  disabled={busy}
                  type="submit"
                />
              </div>
              {!administrator && <SessionLink href="/recover-member" class="gsv-auth-link gsv-login-recovery-link">Forgot your password?</SessionLink>}
              </form>
            )}
          </div>

          <footer class="gsv-sublabel gsv-login-credit">
            <span>BY <a href="https://humansandmachin.es" target="_blank" rel="noreferrer">HUMANS &amp; MACHINES</a></span>
            <button type="button" class="gsv-login-admin" aria-label={administrator ? "Back to personal sign-in" : "Administrator sign-in"} disabled={busy || loading} onClick={() => onAdministrator(!administrator)}>{administrator ? "personal sign-in" : "admin"}</button>
          </footer>
        </div>
    </AuthLayout>
  );
}
