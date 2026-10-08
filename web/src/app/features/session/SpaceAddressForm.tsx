import { useState } from "preact/hooks";
import { Spinner } from "../../components/ui/Spinner";
import { TextInput } from "../../components/ui/TextInput";
import "./LoginScreen.css";
import { spaceAddress } from "../../services/session/spaceAddress";

type Props = { ready?: boolean; disabled?: boolean; onConnect(origin: string): Promise<void> };

export function SpaceAddressForm({ ready = true, disabled = false, onConnect }: Props) {
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
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not open this space. Try again."); }
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
  </form>;
}
