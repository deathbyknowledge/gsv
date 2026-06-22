import { useRef, useState } from "preact/hooks";
import { SectionHeader } from "../../components/ui/SectionHeader";
import { TextInput } from "../../components/ui/TextInput";
import { Button } from "../../components/ui/Button";
import { StatusBar } from "../../components/ui/StatusBar";
import { AuthBackground } from "./backgrounds/AuthBackground";
import "../../../styles/gsv-fonts.css";
import "./session-theme.css";
import "./LoginScreen.css";

type LoginScreenProps = {
  visible: boolean;
  /** While booting/initializing, render the box as a progressive skeleton. */
  loading?: boolean;
  busy: boolean;
  error: string | null;
  username: string;
  password: string;
  token: string;
  onUsername: (value: string) => void;
  onPassword: (value: string) => void;
  onToken: (value: string) => void;
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
  error,
  username,
  password,
  token,
  onUsername,
  onPassword,
  onToken,
  onSubmit,
}: LoginScreenProps) {
  const [showToken, setShowToken] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <div class="gsv-auth-theme gsv-login" data-session-login-view hidden={!visible}>
      {/* Only mount the animated background while visible — otherwise its rAF
          loop keeps running behind the desktop/setup once login is CSS-hidden. */}
      {visible ? <AuthBackground variant="galaxy" /> : null}

      <div class="gsv-login-content">
        <div class="gsv-login-panel">
          <SectionHeader title="WELCOME BACK" titleSize="title" divider />

          <div class="gsv-login-body">
            <span class="gsv-section gsv-login-section">SIGN IN</span>

            {loading ? (
              <LoginSkeleton />
            ) : (
              <form ref={formRef} class="gsv-login-fields" onSubmit={onSubmit}>
              <TextInput
                label="USERNAME"
                placeholder="e.g. captain"
                value={username}
                onChange={onUsername}
              />
              <TextInput
                label="PASSWORD"
                type="password"
                placeholder="••••••••••••"
                value={password}
                clearable={false}
                onChange={onPassword}
              />

              {/* "Use token instead" — directly under the password input. */}
              <div class="gsv-login-tokenlink">
                <Button
                  variant="link"
                  label={showToken ? "USE PASSWORD INSTEAD" : "USE TOKEN INSTEAD"}
                  onClick={() => setShowToken((v) => !v)}
                />
              </div>

              {showToken ? (
                <TextInput
                  label="ACCESS TOKEN"
                  type="password"
                  placeholder="gsv_tok_…"
                  description="Paste a console token to sign in without a password."
                  value={token}
                  onChange={onToken}
                />
              ) : null}

              {error ? (
                <p class="gsv-login-error" role="alert">
                  {error}
                </p>
              ) : null}

              <div class="gsv-login-submit">
                <Button
                  variant="primary"
                  label="SIGN IN"
                  block
                  disabled={busy}
                  onClick={() => formRef.current?.requestSubmit()}
                />
              </div>
              </form>
            )}
          </div>

          <StatusBar label="GENERAL SYSTEMS VEHICLE · SECURE TERMINAL" />
        </div>
      </div>
    </div>
  );
}
