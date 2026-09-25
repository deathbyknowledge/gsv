import { useState } from "preact/hooks";
import { Spinner } from "../app/components/ui/Spinner";
import { TextInput } from "../app/components/ui/TextInput";
import "../app/features/session/LoginScreen.css";
import { spaceAddress } from "./spaceAddress";

type Props = { ready: boolean; disabled?: boolean; onConnect(origin: string): Promise<void> };

export function DesktopConnect({ ready, disabled = false, onConnect }: Props) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const address = spaceAddress(value);
  const submit = async (event: Event) => {
    event.preventDefault();
    if (!ready || disabled || busy) return;
    if (!address.origin) { setError("Enter a handle or domain."); return; }
    setBusy(true); setError("");
    try { await onConnect(address.origin); }
    catch { setError("Could not open this space. Try again."); }
    finally { setBusy(false); }
  };

  return <form class="gsv-login-fields desktop-connect" onSubmit={submit} aria-busy={busy}>
    <TextInput label="Space" placeholder="handle or domain" value={value} suffix={address.suffix}
      disabled={disabled || busy} status={error ? "error" : "none"} message={error}
      onChange={(next) => { setValue(next); setError(""); }}
      inputProps={{ autoComplete: "off", autoCapitalize: "none", spellcheck: false, inputMode: "url" }} />
    <button class="gsv-btn gsv-btn-secondary gsv-btn-block desktop-welcome-submit" type="submit" aria-label="Open space" disabled={!ready || disabled || busy || !value.trim()}>
      {busy ? <Spinner /> : <span class="gsv-btn-label">Open space</span>}
    </button>
    {import.meta.env.DEV && <a class="gsv-auth-link" href="/?mock=1">open the development mock</a>}
  </form>;
}
