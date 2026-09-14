import { useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { startOwnerLink } from "../../../services/session/ownerLink";

export function OwnerAccess() {
  const { client, connected } = useGateway();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const link = async () => {
    setBusy(true); setError(null);
    try {
      window.location.assign(await startOwnerLink(client));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Owner linking failed"); }
    finally { setBusy(false); }
  };
  return <section class="settings-form"><h2>Space ownership</h2>
    <p>Link your verified owner identity so you can recover root for your GSV if you lose access. This leaves local accounts and credentials unchanged.</p>
    {error && <p class="settings-error" role="alert">{error}</p>}
    <button class="ibtn" type="button" disabled={!connected || busy} onClick={() => void link()}>{busy ? "opening owner verification…" : "link owner identity"}</button>
  </section>;
}
