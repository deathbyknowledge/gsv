import { SessionError } from "./SessionChrome";
import { textInputValue } from "./sessionViewUtils";

type LoginScreenProps = {
  visible: boolean;
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

export function LoginScreen({
  visible,
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
  return (
    <div class="session-panel" data-session-login-view hidden={!visible}>
      <div class="session-panel-head">
        <h1>Welcome back</h1>
      </div>
      <form class="session-form" data-session-login-form onSubmit={onSubmit}>
        <label>
          Username
          <input data-session-username type="text" autoComplete="username" value={username} onInput={(event) => onUsername(textInputValue(event))} />
        </label>
        <label>
          Password
          <input data-session-password type="password" autoComplete="current-password" value={password} onInput={(event) => onPassword(textInputValue(event))} />
        </label>
        <details class="session-advanced">
          <summary>Use token instead</summary>
          <label>
            Token
            <input data-session-token type="password" autoComplete="off" value={token} onInput={(event) => onToken(textInputValue(event))} />
          </label>
        </details>
        <SessionError message={error} />
        <button type="submit" class="runtime-btn" data-session-submit disabled={busy}>Sign in</button>
      </form>
    </div>
  );
}
