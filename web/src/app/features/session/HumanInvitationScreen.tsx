import { useState } from "preact/hooks";
import { useSession } from "../../services/session/SessionProvider";
import { readHumanInvitationAttempt, redeemHumanInvitation } from "../../services/session/accountRecovery";
import { AuthLayout } from "./AuthLayout";
import { TextInput } from "../../components/ui/TextInput";
import { Button } from "../../components/ui/Button";
import { SectionHeader } from "../../components/ui/SectionHeader";
import { SessionError } from "./SessionChrome";
import { SessionLink } from "./sessionNavigation";
import "./LoginScreen.css";

export function HumanInvitationScreen() {
  const { service, snapshot } = useSession();
  const [attempt] = useState(() => { try { return readHumanInvitationAttempt(); } catch { return null; } });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: Event) => {
    event.preventDefault();
    if (!attempt || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await redeemHumanInvitation(service.client, snapshot.url, attempt, password);
      setPassword(""); setUsername(result.username);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Joining this space failed"); }
    finally { setBusy(false); }
  };
  return <AuthLayout background="galaxy" visible surfaceClass="gsv-auth-surface-login"><div class="gsv-login-panel">
    <SectionHeader title="JOIN THIS SPACE" titleSize="title" divider />
    <div class="gsv-login-body gsv-recovery-body">
      {username ? <><p>Your account is ready. Sign in as <strong>{username}</strong> with the password you chose.</p><SessionLink href="/" class="gsv-auth-link">Return to sign-in</SessionLink></> : !attempt
        ? <p>This invitation is unavailable. Ask the owner for a new invitation.</p>
        : <form class="gsv-login-fields" onSubmit={(event) => void submit(event)}>
          <p>Choose a password for your local account in this space. The invitation fixes your username.</p>
          <TextInput label="YOUR PASSWORD" placeholder="••••••••••••" type="password" value={password} onChange={setPassword} clearable={false}
            inputProps={{ autoComplete: "new-password", minLength: 8, maxLength: 1024 }} />
          <SessionError message={error} />
          <Button variant="primary" block type="submit" label={busy ? "JOINING…" : "JOIN THIS SPACE"} disabled={busy || password.length < 8} />
        </form>}
      {!username && <SessionLink href="/" class="gsv-auth-link">Return to sign-in</SessionLink>}
    </div>
  </div></AuthLayout>;
}
