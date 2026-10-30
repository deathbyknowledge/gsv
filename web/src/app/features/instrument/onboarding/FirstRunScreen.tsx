import { useState } from "preact/hooks";
import { useQuery } from "../../../services/navigation/viewQueries";
import { Alert } from "../../../components/ui/Alert";
import { Button } from "../../../components/ui/Button";
import { ListRow } from "../../../components/ui/ListRow";
import { LoadingState } from "../../../components/ui/Spinner";
import { LATEST_RELEASE_PAGE_URL } from "../../../domain/cliInstall";
import { detectClientPlatform } from "../../../services/gateway/clientPlatform";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useConsoleAdapterPairingInfo } from "../../../services/system/useConsoleData";
import { useT, type TextKey } from "../../../i18n/locale";
import { INSTRUMENT_MESSENGERS_KEY } from "../wire/queryKeys";
import { MessengerPairing } from "../settings/Telegram";
import { whatsAppCountryList } from "../settings/messengers/ManagedTelegramOnboardingFlow";
import { loadMessengerConnections } from "../settings/messengerConnectionsService";
import { MessengerIcon } from "./MessengerIcon";
import type { PreferredSurface } from "./useFirstRunState";

type MessengerChoice = "whatsapp" | "telegram";
/** Which row's drawer is open; a messenger's drawer holds the pairing flow until it reports the connection. */
type Drawer =
  | { kind: "desktop" }
  | { kind: "messenger"; id: MessengerChoice }
  | { kind: "connected"; id: MessengerChoice }
  | null;

const MESSENGERS: ReadonlyArray<{ id: MessengerChoice; name: string; sub: TextKey }> = [
  { id: "whatsapp", name: "WhatsApp", sub: "onboarding.surface.whatsappSub" },
  { id: "telegram", name: "Telegram", sub: "onboarding.surface.telegramSub" },
];

type Props = {
  ownerUid: number;
  completing: boolean;
  completeError: boolean;
  onComplete: (choice: PreferredSurface) => Promise<void>;
};

/**
 * The last onboarding step, standing in front of the chat: where does this person want to message Ship?
 * Each row opens as a drawer, as Settings › Messengers does. A messenger pairs right here, through the
 * same flow Settings uses, so Ship's greeting lands there; "Continue here" completes at once.
 */
export function FirstRunScreen({ ownerUid, completing, completeError, onComplete }: Props) {
  const t = useT();
  const { client, connected } = useGateway();
  const [drawer, setDrawer] = useState<Drawer>(null);
  const inDesktopApp = detectClientPlatform() === "desktop";
  const connections = useQuery({
    queryKey: [...INSTRUMENT_MESSENGERS_KEY, ownerUid],
    queryFn: () => loadMessengerConnections(client, ownerUid),
    enabled: connected,
  });
  const offered = MESSENGERS.filter(({ id }) => {
    const adapter = connections.data?.adapters.find((entry) => entry.adapter === id);
    return adapter?.enabled === true && adapter.supportsPairing && adapter.canLink;
  });
  const linked = (id: MessengerChoice) => connections.data?.links.some((link) => link.adapter === id) === true;
  const whatsAppOffered = offered.some(({ id }) => id === "whatsapp");
  const whatsApp = useConsoleAdapterPairingInfo("whatsapp", whatsAppOffered);
  const unreachable = whatsApp.data?.unreachableCallingCodes ?? [];
  const busy = completing || !connected;
  const platformName = (id: MessengerChoice) => MESSENGERS.find((entry) => entry.id === id)!.name;
  const open = (next: Exclude<Drawer, null>) => setDrawer((current) => JSON.stringify(current) === JSON.stringify(next) ? null : next);
  /* the flow's own Done and Back both leave it; a messenger linked meanwhile is the person's choice */
  const leaveFlow = async (id: MessengerChoice) => {
    const latest = await connections.refetch();
    const paired = latest.data?.links.some((link) => link.adapter === id) === true;
    setDrawer(paired ? { kind: "connected", id } : null);
  };

  const connectedDrawer = (id: MessengerChoice) => <div class="first-run-drawer">
    <Alert variant="success" title={t("onboarding.surface.connectedTitle")} text={t("onboarding.surface.connectedText", { platform: platformName(id) })} />
    <div class="first-run-actions">
      <span class="first-run-actions-spacer" />
      <Button variant="primary" label={t("onboarding.surface.openChat")} disabled={busy} onClick={() => { void onComplete(id); }} />
    </div>
  </div>;

  return <section class="first-run" aria-labelledby="first-run-title">
    <div class="first-run-panel">
      <h1 id="first-run-title">{t("onboarding.surface.title")}</h1>
      <p class="first-run-lead">{t("onboarding.surface.lead")}</p>
      {completeError && <Alert variant="error" text={t("shell.firstRun.failed")} />}
      {connections.isPending && connected && <LoadingState variant="panel">{t("onboarding.surface.loading")}</LoadingState>}
      <div class="first-run-list gsv-cf-framed">
        {offered.map(({ id, name, sub }) => {
          const paired = linked(id);
          const openHere = drawer?.kind !== "desktop" && drawer?.id === id;
          return <div key={id} class="first-run-row" data-first-run-choice={id}>
            <ListRow label={name} labelInfo={t("onboarding.surface.messengerPrivacy")} status="none" chevron active={openHere}
              leading={<MessengerIcon id={id} />}
              sub={t(paired ? "onboarding.surface.connectedSub" : sub)}
              onClick={() => { if (busy) return; open(paired ? { kind: "connected", id } : { kind: "messenger", id }); }} />
            {id === "whatsapp" && !openHere && unreachable.length > 0 && <p class="first-run-row-note">
              {t("onboarding.surface.whatsappUnreachable", { countries: whatsAppCountryList(unreachable, t) })}
            </p>}
            {drawer?.kind === "messenger" && drawer.id === id && <div class="first-run-drawer">
              <MessengerPairing adapter={id} disabled={!connected}
                onClose={() => { void leaveFlow(id); }}
                onConnected={() => { setDrawer({ kind: "connected", id }); void connections.refetch(); }} />
            </div>}
            {drawer?.kind === "connected" && drawer.id === id && connectedDrawer(id)}
          </div>;
        })}
        {!inDesktopApp && <div class="first-run-row" data-first-run-choice="desktop">
          <ListRow label={t("onboarding.surface.desktop")} sub={t("onboarding.surface.desktopSub")} status="none" chevron active={drawer?.kind === "desktop"}
            onClick={() => { if (!busy) open({ kind: "desktop" }); }} />
          {drawer?.kind === "desktop" && <div class="first-run-drawer">
            <p class="first-run-text">{t("onboarding.surface.desktopText")}</p>
            <div class="first-run-actions">
              <span class="first-run-actions-spacer" />
              <Button variant="secondary" label={t("onboarding.surface.continueHere")} disabled={busy} onClick={() => { void onComplete("desktop"); }} />
              <Button variant="primary" href={LATEST_RELEASE_PAGE_URL} label={t("onboarding.surface.download")} />
            </div>
          </div>}
        </div>}
        <div class="first-run-row" data-first-run-choice="web">
          <ListRow label={t("onboarding.surface.web")} sub={t("onboarding.surface.webSub")} status="none" chevron
            onClick={() => { if (!busy) void onComplete("web"); }} />
        </div>
      </div>
    </div>
  </section>;
}
