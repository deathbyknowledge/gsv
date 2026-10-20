import { useState } from "preact/hooks";
import { useSession } from "../../services/session/SessionProvider";
import { createMemberRecoveryAttempt, readMemberRecoveryAttempt, redeemMemberRecovery, startMemberRecovery } from "../../services/session/memberRecovery";
import { AuthLayout } from "./AuthLayout";
import { TextInput } from "../../components/ui/TextInput";
import { Button } from "../../components/ui/Button";
import { SectionHeader } from "../../components/ui/SectionHeader";
import { SessionError } from "./SessionChrome";
import { AppLink } from "../../services/navigation/appNavigation";
import { useT } from "../../i18n/locale";
import "./LoginScreen.css";

export function MemberRecoveryScreen() {
  const t = useT();
  const { service, snapshot } = useSession();
  const [attempt, setAttempt] = useState(() => { try { return readMemberRecoveryAttempt(); } catch { return null; } });
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
      const next = createMemberRecoveryAttempt();
      setAttempt(next); setCode("");
      await startMemberRecovery(service.client, snapshot.url, next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("session.recovery.requestFailed")); }
    finally { setBusy(false); }
  };
  const redeem = async (event: Event) => {
    event.preventDefault();
    if (!attempt || busy) return;
    setBusy(true); setError(null);
    try {
      setDone(await redeemMemberRecovery(service.client, snapshot.url, attempt, code, password));
      setCode(""); setPassword("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("session.recovery.failed")); }
    finally { setBusy(false); }
  };
  return <AuthLayout background="galaxy" visible surfaceClass="gsv-auth-surface-login"><div class="gsv-login-panel">
    <SectionHeader title={t("session.recovery.title")} titleSize="title" divider />
    <div class="gsv-login-body gsv-recovery-body">
      {done ? <><p>{t("session.recovery.done")}</p><AppLink href="/" class="gsv-auth-link">{t("session.recovery.return")}</AppLink></> : <>
        <p>{t("session.recovery.intro")}</p>
        <form class="gsv-login-fields" onSubmit={(event) => void start(event)}>
          <Button variant="secondary" block type="submit" label={t(busy ? "session.recovery.wait" : attempt ? "session.recovery.requestNew" : "session.recovery.request")} disabled={busy} />
        </form>
        {attempt && <form class="gsv-login-fields" onSubmit={(event) => void redeem(event)}>
          <p>{t("session.recovery.codeHint")}</p>
          <TextInput label={t("session.recovery.code")} placeholder={t("session.recovery.codePlaceholder")} value={code} onChange={setCode} clearable={false} inputProps={{ autoComplete: "one-time-code", maxLength: 9 }} />
          <TextInput label={t("session.recovery.password")} placeholder="••••••••••••" type="password" value={password} onChange={setPassword} clearable={false} inputProps={{ autoComplete: "new-password", minLength: 8, maxLength: 1024 }} />
          <p>{t("session.recovery.warning")}</p>
          <Button variant="primary" block type="submit" label={t("session.recovery.reset")} disabled={busy || password.length < 8 || !code.trim()} />
        </form>}
        <SessionError message={error} />
        <AppLink href="/" class="gsv-auth-link">{t("session.recovery.return")}</AppLink>
      </>}
    </div>
  </div></AuthLayout>;
}
