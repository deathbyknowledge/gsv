import { useState } from "preact/hooks";
import { useSession } from "../../services/session/SessionProvider";
import { readAccountRecoveryAttempt, redeemAccountRecovery } from "../../services/session/accountRecovery";
import { AuthLayout } from "./AuthLayout";
import { TextInput } from "../../components/ui/TextInput";
import { Button } from "../../components/ui/Button";

export function AccountRecoveryScreen() {
  const { service, snapshot } = useSession();
  const [attempt] = useState(() => {
    try { return readAccountRecoveryAttempt(); } catch { return null; }
  });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: Event) => {
    event.preventDefault();
    if (!attempt || busy) return;
    setBusy(true); setError(null);
    try {
      await redeemAccountRecovery(service.client, snapshot.url, attempt, password);
      setPassword(""); setDone(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Root recovery failed"); }
    finally { setBusy(false); }
  };
  return <AuthLayout background="galaxy" visible surfaceClass="gsv-auth-surface-login"><div class="gsv-login-panel">
    <h1>Recover your GSV</h1>
    {done ? <><p>Your root password has changed. Sign in as root with the new password.</p><a href="/">Return to your GSV</a></> : !attempt
      ? <p>This recovery link is unavailable. Start another recovery from your operator’s owner sign-in page.</p>
      : <form class="gsv-login-fields" onSubmit={(event) => void submit(event)}>
        <p>Set a new root password. Existing root credentials will stop working; other people keep access to their accounts.</p>
        <TextInput label="NEW ROOT PASSWORD" type="password" value={password} onChange={setPassword} clearable={false}
          inputProps={{ autoComplete: "new-password", minLength: 8, maxLength: 1024 }} />
        {error && <p role="alert">{error}</p>}
        <Button variant="primary" type="submit" label={busy ? "RESETTING…" : "RESET ROOT PASSWORD"} disabled={busy || password.length < 8} />
      </form>}
  </div></AuthLayout>;
}
