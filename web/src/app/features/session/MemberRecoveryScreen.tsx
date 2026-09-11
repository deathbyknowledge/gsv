import { useState } from "preact/hooks";
import { useSession } from "../../services/session/SessionProvider";
import { createMemberRecoveryAttempt, readMemberRecoveryAttempt, redeemMemberRecovery, startMemberRecovery } from "../../services/session/memberRecovery";
import { AuthLayout } from "./AuthLayout";
import { TextInput } from "../../components/ui/TextInput";
import { Button } from "../../components/ui/Button";

export function MemberRecoveryScreen() {
  const { service, snapshot } = useSession();
  const [attempt, setAttempt] = useState(() => { try { return readMemberRecoveryAttempt(); } catch { return null; } });
  const [username, setUsername] = useState(attempt?.username ?? "");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = async (event: Event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const next = createMemberRecoveryAttempt(username);
      setAttempt(next); setCode("");
      await startMemberRecovery(service.client, snapshot.url, next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not request recovery"); }
    finally { setBusy(false); }
  };
  const redeem = async (event: Event) => {
    event.preventDefault();
    if (!attempt || busy) return;
    setBusy(true); setError(null);
    try {
      setDone(await redeemMemberRecovery(service.client, snapshot.url, attempt, code, password));
      setCode(""); setPassword("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Recovery failed"); }
    finally { setBusy(false); }
  };
  return <AuthLayout background="galaxy" visible surfaceClass="gsv-auth-surface-login"><div class="gsv-login-panel">
    <h1>Recover your account</h1>
    {done ? <><p>Your password has changed. Sign in as {done} with the new password.</p><a href="/">Return to your GSV</a></> : <>
      <p>Use a messenger you previously confirmed in this space. To recover root, use your operator’s owner sign-in page.</p>
      <form class="gsv-login-fields" onSubmit={(event) => void start(event)}>
        <TextInput label="USERNAME" value={username} onChange={setUsername} inputProps={{ autoComplete: "username", pattern: "[a-z_][a-z0-9_-]{0,31}", maxLength: 32 }} />
        <Button variant="secondary" type="submit" label={busy ? "PLEASE WAIT…" : attempt ? "REQUEST A NEW CODE" : "REQUEST A CODE"} disabled={busy || !username.trim()} />
      </form>
      {attempt && <form class="gsv-login-fields" onSubmit={(event) => void redeem(event)}>
        <p>If {attempt.username} has a confirmed messenger, check it for a code. Enter it here within five minutes. If delivery fails, wait at least one minute before requesting a new code, or ask root to reset your password.</p>
        <TextInput label="RECOVERY CODE" value={code} onChange={setCode} clearable={false} inputProps={{ autoComplete: "one-time-code", maxLength: 9 }} />
        <TextInput label="NEW PASSWORD" type="password" value={password} onChange={setPassword} clearable={false} inputProps={{ autoComplete: "new-password", minLength: 8, maxLength: 1024 }} />
        <p>Existing credentials and messenger links for this account will stop working. Link your messenger again after signing in.</p>
        <Button variant="primary" type="submit" label="RESET PASSWORD" disabled={busy || password.length < 8 || !code.trim()} />
      </form>}
      {error && <p role="alert">{error}</p>}
      <a href="/">Return to sign-in</a>
    </>}
  </div></AuthLayout>;
}
