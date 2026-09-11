import { useState } from "preact/hooks";
import { createPairingSecret } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";

export function OwnerAccess() {
  const { client, connected } = useGateway();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const link = async () => {
    setBusy(true); setError(null);
    try {
      const key = "gsv.ui.owner-link.v1";
      const saved = window.sessionStorage.getItem(key);
      const attempt = saved ? JSON.parse(saved) : { id: crypto.randomUUID(), secret: createPairingSecret() };
      window.sessionStorage.setItem(key, JSON.stringify(attempt));
      const result = await client.account.owner.link(attempt);
      window.sessionStorage.removeItem(key);
      window.location.assign(result.url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Owner linking failed"); }
    finally { setBusy(false); }
  };
  return <section class="settings-form"><h2>Space ownership</h2>
    <p>Link your verified owner identity so you can recover root for your GSV if you lose access. This leaves local accounts and credentials unchanged.</p>
    {error && <p class="settings-error" role="alert">{error}</p>}
    <button class="ibtn" type="button" disabled={!connected || busy} onClick={() => void link()}>{busy ? "opening owner verification…" : "link owner identity"}</button>
  </section>;
}
