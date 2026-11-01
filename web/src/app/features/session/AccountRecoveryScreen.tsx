import { useState } from "preact/hooks";
import { useSession } from "../../services/session/SessionProvider";
import { isPersonalAccountUnavailable, readAccountRecoveryAttempt, redeemAccountRecovery, type RecoveryAccount } from "../../services/session/accountRecovery";
import { AuthLayout } from "./AuthLayout";
import { TextInput } from "../../components/ui/TextInput";
import { Button } from "../../components/ui/Button";
import { SectionHeader } from "../../components/ui/SectionHeader";
import { SessionError } from "./SessionChrome";
import { AppLink } from "../../services/navigation/appNavigation";
import { useT } from "../../i18n/locale";
import "./LoginScreen.css";

/** The verified owner's emailed link: a new personal password, or the administrator's if that is what was lost. */
export function AccountRecoveryScreen() {
  const t = useT();
  const { service, snapshot } = useSession();
  const [attempt] = useState(() => {
    try { return readAccountRecoveryAttempt(); } catch { return null; }
  });
  const [account, setAccount] = useState<RecoveryAccount>(attempt?.account ?? "personal");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const administrator = account === "administrator";
  const submit = async (event: Event) => {
    event.preventDefault();
    if (!attempt || busy) return;
    setBusy(true); setError(null);
    try {
      await redeemAccountRecovery(service.client, snapshot.url, attempt, password, account);
      setPassword(""); setDone(true);
    } catch (cause) {
      if (cause instanceof Error && isPersonalAccountUnavailable(cause)) {
        setAccount("administrator");
        setError(t("session.ownerRecovery.personalUnavailable"));
      } else setError(cause instanceof Error ? cause.message : t("session.ownerRecovery.failed"));
    } finally { setBusy(false); }
  };
  return <AuthLayout background="galaxy" visible surfaceClass="gsv-auth-surface-login"><div class="gsv-login-panel">
    <SectionHeader title={t(administrator ? "session.rootRecovery.title" : "session.ownerRecovery.title")} titleSize="title" divider />
    <div class="gsv-login-body gsv-recovery-body">
      {done ? <><p>{t(administrator ? "session.rootRecovery.done" : "session.ownerRecovery.done")}</p><AppLink href="/" class="gsv-auth-link">{t("session.recovery.return")}</AppLink></> : !attempt
        ? <p>{t("session.ownerRecovery.unavailable")}</p>
        : <form class="gsv-login-fields" onSubmit={(event) => void submit(event)}>
          <p>{t(administrator ? "session.rootRecovery.intro" : "session.ownerRecovery.intro")}</p>
          <TextInput label={t(administrator ? "session.rootRecovery.password" : "session.recovery.password")} placeholder="••••••••••••" type="password" value={password} onChange={setPassword} clearable={false}
            inputProps={{ autoComplete: "new-password", minLength: 8, maxLength: 1024 }} />
          <SessionError message={error} />
          <Button variant="primary" block type="submit" label={t(busy ? "session.rootRecovery.resetting" : administrator ? "session.rootRecovery.reset" : "session.ownerRecovery.reset")} disabled={busy || password.length < 8} />
          <button type="button" class="gsv-auth-link gsv-recovery-account" data-recovery-account disabled={busy} onClick={() => { setAccount(administrator ? "personal" : "administrator"); setError(null); }}>
            {t(administrator ? "session.ownerRecovery.usePersonal" : "session.ownerRecovery.useAdministrator")}
          </button>
        </form>}
      {!done && <AppLink href="/" class="gsv-auth-link">{t("session.recovery.return")}</AppLink>}
    </div>
  </div></AuthLayout>;
}
