import { useEffect, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useBrowserNavigation } from "../../../services/platform/BrowserNavigation";
import { startOwnerLink } from "../../../services/session/ownerLink";
import { useT } from "../../../i18n/locale";

export function PersonalPasswordReset({ active }: { active: boolean }) {
  const t = useT();
  const { client, connected } = useGateway();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (!active) setPassword(""); }, [active]);
  const reset = async (event: Event) => {
    event.preventDefault();
    if (busy || !connected || password.length < 8) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      await client.account.password.set({ password });
      setPassword(""); setSaved(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("settings.signIn.resetFailed")); }
    finally { setBusy(false); }
  };
  return <form class="settings-form" onSubmit={(event) => void reset(event)}>
    <h2>{t("settings.signIn.personal")}</h2>
    <p>{t("settings.signIn.resetHint")}</p>
    <label>{t("settings.signIn.newPassword")}<input type="password" autoComplete="new-password" minLength={8} maxLength={1024} value={password} disabled={busy || !connected} onInput={(event) => setPassword(event.currentTarget.value)} /></label>
    {error && <p class="settings-error" role="alert">{error}</p>}
    {saved && <p role="status">{t("settings.signIn.changed")}</p>}
    <button class="ibtn" type="submit" disabled={!connected || busy || password.length < 8}>{t(busy ? "settings.signIn.resetting" : "settings.signIn.reset")}</button>
  </form>;
}

export function OwnerAccess() {
  const t = useT();
  const { client, connected } = useGateway();
  const navigate = useBrowserNavigation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const link = async () => {
    setBusy(true); setError(null);
    try {
      await navigate(await startOwnerLink(client));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("settings.recovery.failed")); }
    finally { setBusy(false); }
  };
  return <section class="settings-form"><h2>{t("settings.recovery.title")}</h2>
    <p>{t("settings.recovery.hint")}</p>
    {error && <p class="settings-error" role="alert">{error}</p>}
    <button class="ibtn" type="button" disabled={!connected || busy} onClick={() => void link()}>{t(busy ? "settings.recovery.opening" : "settings.recovery.setUp")}</button>
  </section>;
}
