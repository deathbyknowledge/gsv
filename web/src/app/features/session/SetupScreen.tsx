import { TextInput } from "../../components/ui/TextInput";
import { AuthLayout } from "./AuthLayout";
import { SessionError } from "./SessionChrome";
import { USERNAME_FORMAT_DESCRIPTION } from "./sessionDomain";
import "./SetupScreen.css";

type SetupScreenProps = {
  visible: boolean;
  busy: boolean;
  space: string;
  username: string;
  password: string;
  error: string | null;
  onUsername: (value: string) => void;
  onPassword: (value: string) => void;
  onSubmit: (event: Event) => void;
};

export function SetupScreen({ visible, busy, space, username, password, error, onUsername, onPassword, onSubmit }: SetupScreenProps) {
  return <AuthLayout visible={visible} surfaceClass="gsv-auth-surface-setup">
    <section class="gsv-setup-panel" data-session-setup-view aria-labelledby="setup-heading">
      <div class="gsv-setup-head">
        <p class="gsv-setup-space">{space}</p>
        <h1 id="setup-heading">Welcome to your space</h1>
        <p>Create your sign-in, then start talking with your Ship.</p>
      </div>
      <form class="gsv-setup-form" data-session-setup-form aria-busy={busy} onSubmit={onSubmit}>
        <TextInput label="Username" value={username} disabled={busy} info={USERNAME_FORMAT_DESCRIPTION}
          placeholder="Choose a username" onChange={onUsername}
          inputProps={{ autoComplete: "username", maxLength: 32, "data-setup-username": true }} />
        <TextInput label="Password" type="password" value={password} disabled={busy} clearable={false}
          placeholder="At least 8 characters" onChange={onPassword}
          inputProps={{ autoComplete: "new-password", maxLength: 1024, "data-setup-password": true }} />
        <p class="gsv-setup-note">This sign-in is for this space.</p>
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
