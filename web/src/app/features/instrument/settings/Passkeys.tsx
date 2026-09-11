import { useQuery, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { enrollPasskey, supportsPasskeys } from "../../../services/session/passkeys";
import { SettingsError, useSettingsDirty, type SettingsSectionProps } from "./settingsShared";

export function Passkeys({ account, active, onDirty }: SettingsSectionProps) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const queryKey = ["settings", "passkeys", account.uid];
  const keys = useQuery({ queryKey, queryFn: () => client.account.passkey.list({}), enabled: connected && active });
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useSettingsDirty(Boolean(label || busy), onDirty);
  const available = connected && !busy;
  const supported = supportsPasskeys();
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(null); setSaved(false);
    try { await work(); }
    catch (cause) { setError(cause instanceof Error ? cause : new Error("Passkey update failed")); }
    finally { setBusy(false); await cache.invalidateQueries({ queryKey }); }
  };
  return <section aria-labelledby="settings-passkeys-title"><h1 id="settings-passkeys-title">Sign-in</h1>
    <p class="settings-intro">Use a passkey to sign in to your GSV. Your password remains available as a fallback.</p>
    <SettingsError error={error ?? keys.error} />
    {saved && <p role="status">Passkey added.</p>}
    <form class="settings-form" onSubmit={(event) => { event.preventDefault(); void run(async () => { await enrollPasskey(client, label.trim()); setLabel(""); setSaved(true); }); }}>
      <label>Passkey name<input value={label} maxLength={80} required disabled={!available || !supported} placeholder="For example, personal laptop" onInput={(event) => setLabel(event.currentTarget.value)} /></label>
      <button class="ibtn" type="submit" disabled={!available || !supported || !label.trim()}>add passkey</button>
      {!supported && <p class="settings-muted">This browser does not support passkeys. You can keep signing in with your password.</p>}
    </form>
    {keys.data?.passkeys.length === 0 && <p>No passkeys are enrolled.</p>}
    {keys.data?.passkeys.map((key) => <div class="settings-form" key={key.id}><strong>{key.label}</strong>
      <span class="settings-muted">{key.lastUsedAt === null ? " · not used yet" : ` · last used ${new Date(key.lastUsedAt).toLocaleDateString()}`}</span>
      {removing === key.id ? <div><p>Remove this passkey? You can still use your password and other enrolled passkeys.</p>
        <button class="settings-text-action settings-danger" type="button" disabled={!available} onClick={() => void run(async () => { await client.account.passkey.revoke({ id: key.id }); setRemoving(null); })}>remove passkey</button>
        <button class="settings-text-action" type="button" disabled={!available} onClick={() => setRemoving(null)}>cancel</button>
      </div> : <button class="settings-text-action" type="button" disabled={!available} onClick={() => setRemoving(key.id)}>remove</button>}
    </div>)}
  </section>;
}
