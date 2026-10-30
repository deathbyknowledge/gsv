import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { useQuery } from "../../../services/navigation/viewQueries";
import { Alert } from "../../../components/ui/Alert";
import { Button } from "../../../components/ui/Button";
import { InfoTip } from "../../../components/ui/InfoTip";
import { LoadingState } from "../../../components/ui/Spinner";
import { LATEST_RELEASE_PAGE_URL } from "../../../domain/cliInstall";
import { detectClientPlatform } from "../../../services/gateway/clientPlatform";
import { gatewayHttpOrigin } from "../../../services/platform/gatewayOrigin";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useT, type TextKey } from "../../../i18n/locale";
import { INSTRUMENT_MESSENGERS_KEY } from "../wire/queryKeys";
import { MessengerPairing } from "../settings/Telegram";
import { loadMessengerConnections } from "../settings/messengerConnectionsService";
import { MessengerIcon } from "./MessengerIcon";
import type { PreferredSurface } from "./useFirstRunState";

type MessengerChoice = "whatsapp" | "telegram";
/** Which section is open; a messenger's holds the pairing flow until it reports the connection. */
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

/** One choice, laid out as a messenger is in Settings › Messengers: heading with its action, a line about it, and what opens beneath. */
export function Section({ name, icon, info, action, onAction, disabled, blurb, children }: {
  name: string;
  icon?: ComponentChildren;
  info?: string;
  action: string;
  onAction: () => void;
  disabled: boolean;
  blurb: string;
  children?: ComponentChildren;
}) {
  return <section class="first-run-section" aria-label={name}>
    <div class="first-run-heading">
      <h2 class="first-run-name">{icon}{name}{info && <InfoTip text={info} position="right" />}</h2>
      <button type="button" class="first-run-text-action" disabled={disabled} onClick={onAction}>{action}</button>
    </div>
    <p class="first-run-muted">{blurb}</p>
    {children}
  </section>;
}

/**
 * The last onboarding step, standing in front of the chat: where does this person want to message Ship?
 * Each choice is a section like Settings › Messengers, without the "nothing connected" line: this is a
 * first run. A messenger pairs right here, through the same flow Settings uses (which names the countries
 * WhatsApp cannot reach), so Ship's greeting lands there; "continue here" completes at once.
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
  const linkFor = (id: MessengerChoice) => connections.data?.links.find((link) => link.adapter === id);
  const busy = completing || !connected;
  const platformName = (id: MessengerChoice) => MESSENGERS.find((entry) => entry.id === id)!.name;
  const toggle = (next: Exclude<Drawer, null>) => setDrawer((current) => JSON.stringify(current) === JSON.stringify(next) ? null : next);
  /* the flow's own Done and Back both leave it; a messenger linked meanwhile is the person's choice */
  const leaveFlow = async (id: MessengerChoice) => {
    const latest = await connections.refetch();
    const paired = latest.data?.links.some((link) => link.adapter === id) === true;
    setDrawer(paired ? { kind: "connected", id } : null);
  };

  return <section class="first-run" aria-labelledby="first-run-title">
    <div class="first-run-panel">
      <h1 id="first-run-title">{t("onboarding.surface.title")}</h1>
      <p class="first-run-lead">{t("onboarding.surface.lead", { address: new URL(gatewayHttpOrigin()).host })}</p>
      {completeError && <Alert variant="error" text={t("shell.firstRun.failed")} />}
      {connections.isPending && connected && <LoadingState variant="panel">{t("onboarding.surface.loading")}</LoadingState>}

      {offered.map(({ id, name, sub }) => {
        const link = linkFor(id);
        const openHere = drawer !== null && drawer.kind !== "desktop" && drawer.id === id;
        return <Section key={id} name={name} icon={<MessengerIcon id={id} />} info={t("onboarding.surface.messengerPrivacy")}
          action={t(openHere ? "settings.messengers.closeSetup" : "settings.messengers.connect", { name })} disabled={busy}
          onAction={() => toggle(link ? { kind: "connected", id } : { kind: "messenger", id })}
          blurb={t(sub)}>
          {link && <ul class="first-run-list"><li>
            <span class="first-run-status">{t("settings.messengers.connectedTo", { id: link.actorId })}</span>
          </li></ul>}
          {drawer?.kind === "messenger" && drawer.id === id && <fieldset class="first-run-drawer" disabled={!connected}>
            <MessengerPairing adapter={id} disabled={!connected}
              onClose={() => { void leaveFlow(id); }}
              onConnected={() => { setDrawer({ kind: "connected", id }); void connections.refetch(); }} />
          </fieldset>}
          {drawer?.kind === "connected" && drawer.id === id && <div class="first-run-drawer">
            <Alert variant="success" title={t("onboarding.surface.connectedTitle")} text={t("onboarding.surface.connectedText", { platform: platformName(id) })} />
            <div class="first-run-actions">
              <span class="first-run-actions-spacer" />
              <Button variant="primary" label={t("onboarding.surface.openChat")} disabled={busy} onClick={() => { void onComplete(id); }} />
            </div>
          </div>}
        </Section>;
      })}

      {!inDesktopApp && <Section name={t("onboarding.surface.desktop")} blurb={t("onboarding.surface.desktopSub")} disabled={busy}
        action={t(drawer?.kind === "desktop" ? "settings.messengers.closeSetup" : "onboarding.surface.desktopAction")}
        onAction={() => toggle({ kind: "desktop" })}>
        {drawer?.kind === "desktop" && <div class="first-run-drawer">
          <p class="first-run-text">{t("onboarding.surface.desktopText")}</p>
          <div class="first-run-actions">
            <span class="first-run-actions-spacer" />
            <Button variant="secondary" label={t("onboarding.surface.continueHere")} disabled={busy} onClick={() => { void onComplete("desktop"); }} />
            <Button variant="primary" href={LATEST_RELEASE_PAGE_URL} label={t("onboarding.surface.download")} />
          </div>
        </div>}
      </Section>}

      <div class="first-run-continue">
        <button type="button" class="first-run-text-action" disabled={busy} onClick={() => { void onComplete("web"); }}>{t("onboarding.surface.web")}</button>
        <p class="first-run-continue-note">{t("onboarding.surface.webSub")}</p>
      </div>
    </div>
  </section>;
}
