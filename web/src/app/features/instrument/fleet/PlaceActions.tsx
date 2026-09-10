import { useEffect, useRef, useState } from "preact/hooks";
import { useQueryClient } from "@tanstack/preact-query";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useSession } from "../../../services/session/SessionProvider";
import type { IssuedMachineNodeToken } from "../../../services/system/consoleService";
import { useDeleteConsoleMachine } from "../../../services/system/useConsoleData";
import {
  buildBrowserExtensionConfig,
  buildMachineBootstrapCommand,
  expiresAtFromDays,
  type MachineProvisionPlatform,
} from "../../../services/machines/machineProvision";
import { INSTRUMENT_TARGETS_KEY } from "../wire/queryKeys";
import { placeActions, type Place } from "./fleetModel";
import { issuePlacePairing, pairingOrigin } from "./placePairing";

export function PlaceActions({ place, uid, focusPair }: { place: Place; uid: number | null; focusPair: boolean }) {
  const { client, connected } = useGateway();
  const { snapshot } = useSession();
  const queryClient = useQueryClient();
  const allowed = placeActions(place, uid);
  const [mode, setMode] = useState<"pair" | "forget" | null>(null);
  const [platform, setPlatform] = useState<MachineProvisionPlatform>(place.kind === "browser" ? "browser" : /win/i.test(place.platform) && !/darwin/i.test(place.platform) ? "windows" : /darwin|mac/i.test(place.platform) ? "mac" : "linux");
  const [confirmation, setConfirmation] = useState("");
  const [issued, setIssued] = useState<IssuedMachineNodeToken | null>(null);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const mounted = useRef(true);
  const issuance = useRef<AbortController | null>(null);
  const pairButton = useRef<HTMLButtonElement>(null);
  const focused = useRef(false);
  const confirmInput = useRef<HTMLInputElement>(null);
  const remove = useDeleteConsoleMachine();

  useEffect(() => () => {
    mounted.current = false;
    issuance.current?.abort();
  }, []);
  useEffect(() => {
    if (focusPair && allowed.pair && connected && !focused.current) {
      pairButton.current?.focus();
      focused.current = true;
    }
  }, [focusPair, allowed.pair, connected]);
  useEffect(() => {
    if (mode === "forget") confirmInput.current?.focus();
  }, [mode]);

  const create = async () => {
    if (!allowed.pair || !connected || creating) return;
    const controller = new AbortController();
    issuance.current = controller;
    setCreating(true);
    setError(null);
    try {
      const token = await issuePlacePairing(client, { deviceId: place.id, label: place.label, expiresAt: expiresAtFromDays(30) }, controller.signal);
      if (token) {
        if (mounted.current && !controller.signal.aborted) setIssued(token);
        else await client.sys.token.revoke({ tokenId: token.tokenId, reason: "Pairing cancelled before the key was displayed" });
      }
    } catch {
      if (mounted.current) setError("Could not finish creating or cancelling the pairing key. Check `gsv auth token list` and revoke an unused key with `gsv auth token revoke TOKEN_ID` before trying again.");
    } finally {
      if (issuance.current === controller) issuance.current = null;
      if (mounted.current) setCreating(false);
    }
  };
  const cancel = async () => {
    issuance.current?.abort();
    if (issued) {
      setRevoking(true);
      setError(null);
      try {
        await client.sys.token.revoke({ tokenId: issued.tokenId, reason: "Pairing cancelled" });
      } catch {
        if (mounted.current) setError("Could not revoke the pairing key. Keep this panel open and try cancelling again.");
        return;
      } finally {
        if (mounted.current) setRevoking(false);
      }
    }
    if (mounted.current) {
      setIssued(null);
      setCopied(false);
      setMode(null);
    }
  };
  const setup = issued ? (platform === "browser"
    ? JSON.stringify(buildBrowserExtensionConfig({ origin: pairingOrigin(snapshot.url), username: snapshot.username, deviceId: place.id, token: issued.token }), null, 2)
    : buildMachineBootstrapCommand({ origin: pairingOrigin(snapshot.url), platform, username: snapshot.username, deviceId: place.id, token: issued.token })) : "";

  if (!allowed.pair && !allowed.forget) return null;
  return (
    <section class="fleet-place-actions" onKeyDown={(event) => {
      if (event.key === "Escape" && mode && !remove.isPending && !revoking) {
        event.preventDefault();
        void cancel();
      }
    }}>
      <div class="fleet-actions">
        {allowed.pair ? <button ref={pairButton} type="button" class="fleet-text-action" disabled={!connected || creating || mode !== null} onClick={() => { setError(null); setMode("pair"); }}>pair again</button> : null}
        {allowed.forget ? <button type="button" class="fleet-text-action is-danger" disabled={!connected || creating || mode !== null} onClick={() => { setError(null); setConfirmation(""); setMode("forget"); }}>forget place</button> : null}
      </div>
      {mode === "pair" ? (
        <div class="fleet-place-form">
          <h4>Pair {place.label} again</h4>
          <div class="full-id">{place.id}</div>
          <p class="note">Run setup on this computer{place.kind === "browser" ? "’s browser extension" : ""} to connect it again. This keeps the same place ID; it does not remotely restart the device.</p>
          {platform !== "browser" ? <label>Operating system <select class="fleet-select" value={platform} disabled={creating || !!issued} onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === "mac" || value === "windows" || value === "linux") setPlatform(value);
          }}><option value="mac">macOS</option><option value="linux">Linux</option><option value="windows">Windows</option></select></label> : null}
          {issued ? <>
            <p class="note">{platform === "browser" ? "Apply these values in the extension’s connection settings." : "With the GSV CLI installed, run this on the computer."} The key expires in 30 days. Copy the setup before leaving; this key is only displayed here.</p>
            <pre class="fleet-setup">{setup}</pre>
            <div class="fleet-actions">
              <button type="button" class="fleet-text-action is-primary" onClick={() => {
                void navigator.clipboard.writeText(setup).then(() => { if (mounted.current) setCopied(true); }, () => { if (mounted.current) setError("Could not copy the setup. Select and copy it above."); });
              }}>{copied ? "copied" : "copy setup"}</button>
              <button type="button" class="fleet-text-action" disabled={revoking} onClick={() => { setIssued(null); setCopied(false); setMode(null); }}>done</button>
              <button type="button" class="fleet-text-action is-danger" disabled={revoking} onClick={() => void cancel()}>{revoking ? "cancelling…" : "cancel and revoke key"}</button>
            </div>
          </> : <div class="fleet-actions">
            <button type="button" class="ibtn is-primary" disabled={!connected || creating || !allowed.pair} onClick={() => void create()}>{creating ? "creating key…" : "create pairing key"}</button>
            <button type="button" class="fleet-text-action" onClick={() => void cancel()}>cancel</button>
          </div>}
        </div>
      ) : mode === "forget" ? (
        <form class="fleet-place-form" onSubmit={(event) => {
          event.preventDefault();
          if (confirmation !== place.id || !allowed.forget || !connected || remove.isPending) return;
          remove.mutate({ deviceId: place.id }, { onSuccess: () => { void queryClient.invalidateQueries({ queryKey: INSTRUMENT_TARGETS_KEY }); } });
        }}>
          <h4>Forget {place.label}?</h4>
          <p class="note">The place record is removed, any live device connection is disconnected, and active node tokens for this place are revoked.</p>
          <label>Type <code>{place.id}</code> to confirm <input ref={confirmInput} value={confirmation} disabled={remove.isPending} onInput={(event) => setConfirmation(event.currentTarget.value)} autoComplete="off" spellcheck={false} /></label>
          <div class="fleet-actions">
            <button type="submit" class="ibtn is-danger" disabled={!connected || confirmation !== place.id || remove.isPending}>{remove.isPending ? "forgetting…" : "forget place"}</button>
            <button type="button" class="fleet-text-action" disabled={remove.isPending} onClick={() => setMode(null)}>cancel</button>
          </div>
          {remove.error ? <p class="error" role="alert">Could not forget this place: {remove.error.message}</p> : null}
        </form>
      ) : null}
      {error ? <p class="error" role="alert">{error}</p> : null}
    </section>
  );
}
