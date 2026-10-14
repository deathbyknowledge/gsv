import { useEffect, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useBrowserNavigation } from "../../../services/platform/BrowserNavigation";
import { startOwnerLink } from "../../../services/session/ownerLink";

export function PersonalPasswordReset({ active }: { active: boolean }) {
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
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Password reset failed"); }
    finally { setBusy(false); }
  };
  return <form class="settings-form" onSubmit={(event) => void reset(event)}>
    <h2>Personal sign-in</h2>
    <p>Reset the password for your personal account. This signs out its sessions and disconnects its messenger links.</p>
    <label>New personal password<input type="password" autoComplete="new-password" minLength={8} maxLength={1024} value={password} disabled={busy || !connected} onInput={(event) => setPassword(event.currentTarget.value)} /></label>
    {error && <p class="settings-error" role="alert">{error}</p>}
    {saved && <p role="status">Your personal password has changed.</p>}
    <button class="ibtn" type="submit" disabled={!connected || busy || password.length < 8}>{busy ? "resetting…" : "reset personal password"}</button>
  </form>;
}

export function OwnerAccess() {
  const { client, connected } = useGateway();
  const navigate = useBrowserNavigation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const link = async () => {
    setBusy(true); setError(null);
    try {
      await navigate(await startOwnerLink(client));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Owner linking failed"); }
    finally { setBusy(false); }
  };
  return <section class="settings-form"><h2>Space ownership</h2>
    <p>Link your verified owner identity so you can recover root for your GSV if you lose access. This leaves local accounts and credentials unchanged.</p>
    {error && <p class="settings-error" role="alert">{error}</p>}
    <button class="ibtn" type="button" disabled={!connected || busy} onClick={() => void link()}>{busy ? "opening owner verification…" : "link owner identity"}</button>
  </section>;
}
