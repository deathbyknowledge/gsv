import { useState } from "preact/hooks";
import { useSession } from "../../services/session/SessionProvider";
import { readAccountRecoveryAttempt, redeemAccountRecovery } from "../../services/session/accountRecovery";
import { AuthLayout } from "./AuthLayout";
import { TextInput } from "../../components/ui/TextInput";
import { Button } from "../../components/ui/Button";
import { SectionHeader } from "../../components/ui/SectionHeader";
import { SessionError } from "./SessionChrome";
import { AppLink } from "../../services/navigation/appNavigation";
import { useT } from "../../i18n/locale";
import "./LoginScreen.css";

export function AccountRecoveryScreen() {
  const t = useT();
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
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("session.rootRecovery.failed")); }
    finally { setBusy(false); }
  };
  return <AuthLayout background="galaxy" visible surfaceClass="gsv-auth-surface-login"><div class="gsv-login-panel">
    <SectionHeader title={t("session.rootRecovery.title")} titleSize="title" divider />
    <div class="gsv-login-body gsv-recovery-body">
      {done ? <><p>{t("session.rootRecovery.done")}</p><AppLink href="/" class="gsv-auth-link">{t("session.recovery.return")}</AppLink></> : !attempt
        ? <p>{t("session.rootRecovery.unavailable")}</p>
        : <form class="gsv-login-fields" onSubmit={(event) => void submit(event)}>
          <p>{t("session.rootRecovery.intro")}</p>
          <TextInput label={t("session.rootRecovery.password")} placeholder="••••••••••••" type="password" value={password} onChange={setPassword} clearable={false}
            inputProps={{ autoComplete: "new-password", minLength: 8, maxLength: 1024 }} />
          <SessionError message={error} />
          <Button variant="primary" block type="submit" label={t(busy ? "session.rootRecovery.resetting" : "session.rootRecovery.reset")} disabled={busy || password.length < 8} />
        </form>}
      {!done && <AppLink href="/" class="gsv-auth-link">{t("session.recovery.return")}</AppLink>}
    </div>
  </div></AuthLayout>;
}
