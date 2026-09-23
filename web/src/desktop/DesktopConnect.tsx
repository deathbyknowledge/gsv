import { useState } from "preact/hooks";
import { Button } from "../app/components/ui/Button";
import { SectionHeader } from "../app/components/ui/SectionHeader";
import { TextInput } from "../app/components/ui/TextInput";
import { AuthLayout } from "../app/features/session/AuthLayout";
import "../app/features/session/LoginScreen.css";
import { spaceAddress } from "./spaceAddress";

type Props = { ready: boolean; onConnect(origin: string): Promise<void> };

export function DesktopConnect({ ready, onConnect }: Props) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const address = spaceAddress(value);
  const submit = async (event: Event) => {
    event.preventDefault();
    if (!ready || busy) return;
    if (!address.origin) { setError("Enter a handle or domain."); return; }
    setBusy(true); setError("");
    try { await onConnect(address.origin); }
    catch { setError("Could not open this space. Try again."); }
    finally { setBusy(false); }
  };

  return <AuthLayout visible surfaceClass="gsv-auth-surface-login">
    <div class="gsv-login-panel desktop-connect">
      <SectionHeader title="Connect your space" titleSize="title" divider />
      <div class="gsv-login-body">
        <form class="gsv-login-fields" onSubmit={submit}>
          <TextInput label="Space" placeholder="handle or domain" value={value} suffix={address.suffix}
            disabled={busy} status={error ? "error" : "none"} message={error}
            onChange={(next) => { setValue(next); setError(""); }}
            inputProps={{ autoFocus: true, autoComplete: "off", autoCapitalize: "none", spellcheck: false, inputMode: "url" }} />
          <div class="gsv-login-submit">
            <Button type="submit" label={busy ? "Connecting…" : "Continue"} block disabled={!ready || busy || !value.trim()} />
          </div>
          {import.meta.env.DEV && <a class="gsv-auth-link" href="/?mock=1">open the development mock</a>}
        </form>
      </div>
    </div>
  </AuthLayout>;
}
