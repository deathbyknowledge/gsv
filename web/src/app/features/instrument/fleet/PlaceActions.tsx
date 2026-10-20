import { useEffect, useRef, useState } from "preact/hooks";
import { useViewActive } from "../../../services/navigation/ViewActivity";
import { useQueryClient } from "@tanstack/preact-query";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useDeleteConsoleMachine } from "../../../services/system/useConsoleData";
import { useDevicePairing } from "../../../services/machines/DevicePairingProvider";
import { DevicePairingPanel } from "../shared/DevicePairingPanel";
import { INSTRUMENT_TARGETS_KEY } from "../wire/queryKeys";
import { placeActions, type Place } from "./fleetModel";
import { rich, useT, type TextKey } from "../../../i18n/locale";

export function PlaceActions({ place, uid, focusPair }: { place: Place; uid: number | null; focusPair: boolean }) {
  const t = useT();
  const active = useViewActive();
  const { connected } = useGateway();
  const { pairing } = useDevicePairing();
  const queryClient = useQueryClient();
  const allowed = placeActions(place, uid);
  const [mode, setMode] = useState<"pair" | "forget" | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<TextKey | null>(null);
  const pairButton = useRef<HTMLButtonElement>(null);
  const focused = useRef(false);
  const confirmInput = useRef<HTMLInputElement>(null);
  const remove = useDeleteConsoleMachine();

  useEffect(() => {
    if (active && focusPair && allowed.pair && connected && !focused.current) {
      pairButton.current?.focus();
      focused.current = true;
    }
  }, [active, focusPair, allowed.pair, connected]);
  useEffect(() => { if (active && mode === "forget") confirmInput.current?.focus(); }, [mode]);

  if (!allowed.pair && !allowed.forget) return null;
  return <section class="fleet-place-actions" onKeyDown={(event) => {
    if (event.key === "Escape" && mode && !remove.isPending) { event.preventDefault(); setMode(null); }
  }}>
    <div class="fleet-actions">
      {allowed.pair && <button ref={pairButton} type="button" class="fleet-text-action" disabled={!connected || mode !== null} onClick={() => {
        const platform = place.kind === "browser" ? "browser" : /win/i.test(place.platform) && !/darwin/i.test(place.platform) ? "windows" : /darwin|mac/i.test(place.platform) ? "mac" : "linux";
        if (pairing.selectExisting(place.label, place.id, platform)) { setError(null); setMode("pair"); }
        else setError("fleet.placeActions.invitationBusy");
      }}>{t("fleet.placeActions.pairAgain")}</button>}
      {allowed.forget && <button type="button" class="fleet-text-action is-danger" disabled={!connected || mode !== null} onClick={() => { setError(null); setConfirmation(""); setMode("forget"); }}>{t("fleet.placeActions.forget")}</button>}
    </div>
    {mode === "pair" ? <>
      <h4>{t("fleet.placeActions.pairTitle", { label: place.label })}</h4>
      <DevicePairingPanel targets={[{ deviceId: place.id, online: place.online }]} onClose={() => setMode(null)} />
    </> : mode === "forget" ? (
        <form class="fleet-place-form" onSubmit={(event) => {
          event.preventDefault();
          if (confirmation !== place.id || !allowed.forget || !connected || remove.isPending) return;
          remove.mutate({ deviceId: place.id }, { onSuccess: () => { void queryClient.invalidateQueries({ queryKey: INSTRUMENT_TARGETS_KEY }); } });
        }}>
          <h4>{t("fleet.placeActions.forgetTitle", { label: place.label })}</h4>
          <p class="note">{t("fleet.placeActions.forgetNote")}</p>
          <label>{rich(t("fleet.placeActions.confirm"), { id: <code>{place.id}</code> })} <input ref={confirmInput} value={confirmation} disabled={remove.isPending} onInput={(event) => setConfirmation(event.currentTarget.value)} autoComplete="off" spellcheck={false} /></label>
          <div class="fleet-actions">
            <button type="submit" class="ibtn is-danger" disabled={!connected || confirmation !== place.id || remove.isPending}>{remove.isPending ? t("fleet.placeActions.forgetting") : t("fleet.placeActions.forget")}</button>
            <button type="button" class="fleet-text-action" disabled={remove.isPending} onClick={() => setMode(null)}>{t("common.cancel")}</button>
          </div>
          {remove.error ? <p class="error" role="alert">{t("fleet.placeActions.forgetFailed", { error: remove.error.message })}</p> : null}
        </form>
    ) : null}
    {error && <p class="error" role="alert">{t(error)}</p>}
  </section>;
}
