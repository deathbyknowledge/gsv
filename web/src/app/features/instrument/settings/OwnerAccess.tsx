import { useEffect, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useBrowserNavigation } from "../../../services/platform/BrowserNavigation";
import { startOwnerLink } from "../../../services/session/ownerLink";
import { TextInput } from "../../../components/ui/TextInput";
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
    <TextInput type="password" label={t("settings.signIn.newPassword")} placeholder="" value={password} disabled={busy || !connected} inputProps={{ autoComplete: "new-password", minLength: 8, maxLength: 1024 }} onChange={setPassword} />
    {error && <p class="settings-error" role="alert">{error}</p>}
    {saved && <p role="status">{t("settings.signIn.changed")}</p>}
    <button class="ibtn" type="submit" disabled={!connected || busy || password.length < 8}>{t(busy ? "settings.signIn.resetting" : "settings.signIn.reset")}</button>
  </form>;
}

/**
 * Someone who signs in by email may add a password, for example for the command line. A password they already have is
 * reset by email from the sign-in screen, so this only ever sets the first one.
 */
export function AccountPassword({ active }: { active: boolean }) {
  const t = useT();
  const { client, connected } = useGateway();
  const [set, setSet] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  useEffect(() => {
    if (!active || !connected) return;
    let current = true;
    void client.account.password.status({}).then((status) => { if (current) setSet(status.set); }, () => { if (current) setSet(null); });
    return () => { current = false; };
  }, [active, connected, client]);
  useEffect(() => { if (!active) { setPassword(""); setAdded(false); setError(null); } }, [active]);
  const add = async (event: Event) => {
    event.preventDefault();
    if (busy || !connected || password.length < 8) return;
    setBusy(true); setError(null);
    try {
      await client.account.password.set({ password });
      setPassword(""); setAdded(true); setSet(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("settings.account.passwordFailed")); }
    finally { setBusy(false); }
  };
  if (set === null) return null;
  return <form class="settings-form" onSubmit={(event) => void add(event)}>
    <h2>{t("settings.account.passwordTitle")}</h2>
    {added && <p role="status">{t("settings.account.passwordAdded")}</p>}
    <p class="settings-intro">{t(set ? "settings.account.passwordSet" : "settings.account.passwordUnset")}</p>
    {!set && <>
      <input type="hidden" name="username" autoComplete="username" value={window.location.host} />
      <TextInput type="password" label={t("settings.account.newPassword")} placeholder="" value={password} disabled={busy || !connected}
        message={password && password.length < 8 ? t("settings.account.passwordShort") : undefined}
        inputProps={{ autoComplete: "new-password", minLength: 8, maxLength: 1024 }} onChange={setPassword} />
      {error && <p class="settings-error" role="alert">{error}</p>}
      <button class="ibtn" type="submit" disabled={!connected || busy || password.length < 8}>{t(busy ? "settings.account.addingPassword" : "settings.account.addPassword")}</button>
    </>}
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
