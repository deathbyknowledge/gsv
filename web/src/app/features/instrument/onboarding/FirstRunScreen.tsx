import { useState } from "preact/hooks";
import { useQuery } from "../../../services/navigation/viewQueries";
import { Alert } from "../../../components/ui/Alert";
import { Button } from "../../../components/ui/Button";
import { LoadingState } from "../../../components/ui/Spinner";
import { Surface } from "../../../components/ui/Surface";
import { Tag } from "../../../components/ui/Tag";
import { gatewayHttpOrigin } from "../../../services/platform/gatewayOrigin";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useT, type TextKey } from "../../../i18n/locale";
import { INSTRUMENT_MESSENGERS_KEY } from "../wire/queryKeys";
import { loadMessengerConnections } from "../settings/messengerConnectionsService";
import { FirstRunPairing, type MessengerChoice } from "./FirstRunPairing";
import { MessengerIcon } from "./MessengerIcon";

const MESSENGERS: ReadonlyArray<{ id: MessengerChoice; name: string; sub: TextKey }> = [
  { id: "whatsapp", name: "WhatsApp", sub: "onboarding.surface.whatsappSub" },
  { id: "telegram", name: "Telegram", sub: "onboarding.surface.telegramSub" },
];

type Props = {
  ownerUid: number;
  completing: boolean;
  completeError: boolean;
  onComplete: () => Promise<void>;
};

/**
 * The last onboarding step, standing in front of the chat: where does this person want to message Ship?
 * Each choice is a section like Settings › Messengers, without the "nothing connected" line: this is a
 * first run. A messenger pairs right here, through the same flow Settings uses (which names the countries
 * WhatsApp cannot reach), and Ship says hello there once it connects; "continue here" completes at once. When the
 * messenger inventory cannot be loaded the screen says so and offers a retry, rather than passing the
 * failure off as a deployment without messengers; continuing here stays possible, since Settings can connect one later.
 */
export function FirstRunScreen({ ownerUid, completing, completeError, onComplete }: Props) {
  const t = useT();
  const { client, connected } = useGateway();
  const [open, setOpen] = useState<MessengerChoice | null>(null);
  const connections = useQuery({
    queryKey: [...INSTRUMENT_MESSENGERS_KEY, ownerUid],
    queryFn: () => loadMessengerConnections(client, ownerUid),
    enabled: connected,
  });
  const offered = MESSENGERS.filter(({ id }) => {
    const adapter = connections.data?.adapters.find((entry) => entry.adapter === id);
    return adapter?.enabled === true && adapter.supportsPairing && adapter.canLink;
  });
  const busy = completing || !connected;
  const finish = () => { void onComplete(); };

  return <section class="first-run" aria-labelledby="first-run-title">
    <div class="first-run-panel">
      <h1 id="first-run-title">{t("onboarding.surface.title")}</h1>
      <p class="first-run-lead">{t("onboarding.surface.lead", { address: new URL(gatewayHttpOrigin()).host })}</p>
      {completeError && <Alert variant="error" text={t("onboarding.surface.failed")} />}
      {connections.isPending && connected && <LoadingState variant="panel">{t("onboarding.surface.loading")}</LoadingState>}
      {connections.isError && <Alert variant="error" text={t("onboarding.surface.loadFailed")}>
        <Button variant="secondary" label={t("common.tryAgain")} disabled={!connected || connections.isFetching} onClick={() => { void connections.refetch(); }} />
      </Alert>}

      {offered.length > 0 && <div class="first-run-cards">
        {offered.map(({ id, name, sub }, index) => {
          const linked = connections.data?.links.some((link) => link.adapter === id) === true;
          const expanded = open === id;
          // Only the header toggles; the pairing beneath it holds its own controls.
          return <section key={id} class="first-run-card" aria-label={name}>
            <Surface as="button" level={expanded ? 2 : 1} interactive={!busy} disabled={busy} aria-expanded={expanded}
              aria-controls={expanded ? `first-run-${id}` : undefined} onClick={() => setOpen(expanded ? null : id)}>
              <span class="first-run-card-head">
                <MessengerIcon id={id} size={24} />
                <span class="first-run-card-name">{name}</span>
                <span class="first-run-card-sub gsv-prose-lead">{t(sub)}</span>
                {expanded
                  ? <span class="gsv-btn gsv-btn-link first-run-card-state">{t("settings.messengers.closeSetup")}</span>
                  : linked
                    ? <span class="first-run-card-state"><Tag tone="online" dot label={t("onboarding.surface.connectedSub")} /></span>
                    : <span class={`gsv-btn ${index === 0 && open === null ? "gsv-btn-primary" : "gsv-btn-secondary"} first-run-card-action${busy ? " is-disabled" : ""}`}>
                      {t("onboarding.surface.chatOn", { name })}
                    </span>}
              </span>
            </Surface>
            {expanded && <Surface id={`first-run-${id}`} level={2}>
              <FirstRunPairing adapter={id} name={name} linked={linked} disabled={busy} links={connections.data?.links}
                onRefreshLinks={() => { void connections.refetch(); }} onFinish={finish} />
            </Surface>}
          </section>;
        })}
        <p class="first-run-note">{t("onboarding.surface.messengerPrivacy")}</p>
      </div>}

      <div class="first-run-continue">
        {/* without a messenger to choose, the chat is the way on rather than a skip */}
        {!connections.isPending && offered.length === 0
          ? <Button variant="primary" label={t("onboarding.surface.openChat")} disabled={busy} onClick={finish} />
          /* "here" is the client the first run is finishing in */
          : <Button variant="link" label={t("onboarding.surface.skip")} disabled={busy} onClick={finish} />}
      </div>
    </div>
  </section>;
}
