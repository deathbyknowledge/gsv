import { useEffect, useState } from "preact/hooks";
import { useQuery } from "../../../services/navigation/viewQueries";
import { Alert } from "../../../components/ui/Alert";
import { Button } from "../../../components/ui/Button";
import { LoadingState } from "../../../components/ui/Spinner";
import { Tag } from "../../../components/ui/Tag";
import { gatewayHttpOrigin } from "../../../services/platform/gatewayOrigin";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { clearFirstRunMessenger, readFirstRunMessenger } from "../../../services/session/installationOnboarding";
import { useT, type TextKey } from "../../../i18n/locale";
import { INSTRUMENT_MESSENGERS_KEY } from "../wire/queryKeys";
import { loadMessengerConnections } from "../settings/messengerConnectionsService";
import { MessengerCard } from "../settings/messengers/MessengerCard";
import { MessengerSteps, type MessengerChoice } from "../settings/messengers/MessengerSteps";
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
  const [arrivedFrom, setArrivedFrom] = useState(readFirstRunMessenger);
  const connections = useQuery({
    queryKey: [...INSTRUMENT_MESSENGERS_KEY, ownerUid],
    queryFn: () => loadMessengerConnections(client, ownerUid),
    enabled: connected,
  });
  const offered = MESSENGERS.filter(({ id }) => {
    const adapter = connections.data?.adapters.find((entry) => entry.adapter === id);
    return adapter?.enabled === true && adapter.supportsPairing && adapter.canLink;
  });
  /* someone who signed up from a messenger finds its card open, once, unless it is already connected */
  useEffect(() => {
    if (!arrivedFrom || !connections.data) return;
    clearFirstRunMessenger();
    setArrivedFrom(null);
    const arrival = offered.find(({ id }) => id === arrivedFrom);
    if (arrival && !connections.data.links.some((link) => link.adapter === arrival.id)) setOpen(arrival.id);
  }, [arrivedFrom, connections.data]);
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
          return <MessengerCard key={id} id={id} name={name} sub={t(sub)} icon={<MessengerIcon id={id} size={24} />}
            action={linked ? undefined : t("onboarding.surface.chatOn", { name })} primary={index === 0 && open === null}
            status={linked && <Tag tone="online" dot label={t("onboarding.surface.connectedSub")} />}
            expanded={expanded} disabled={busy} onToggle={() => setOpen(expanded ? null : id)}>
            {expanded && <MessengerSteps adapter={id} name={name} linked={linked} disabled={busy} links={connections.data?.links}
              onRefreshLinks={() => { void connections.refetch(); }} doneLabel={t("onboarding.surface.openChatHere")} onFinish={finish} />}
          </MessengerCard>;
        })}
        <p class="first-run-note">{t("onboarding.surface.messengerPrivacy")}</p>
      </div>}

      <div class="first-run-continue">
        {/* without a messenger to choose, the chat is the way on rather than a skip */}
        {!connections.isPending && offered.length === 0
          ? <Button variant="primary" label={t("onboarding.surface.openChat")} disabled={busy} onClick={finish} />
          /* "here" is the client the first run is finishing in */
          : <Button variant="secondary" label={t("onboarding.surface.skip")} disabled={busy} onClick={finish} />}
      </div>
    </div>
  </section>;
}
