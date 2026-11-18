import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useEffect, useState } from "preact/hooks";
import { useAppLocation } from "../../../services/navigation/appNavigation";
import { LoadingState } from "../../../components/ui/Spinner";
import { Tag, type TagTone } from "../../../components/ui/Tag";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { disconnectConsoleAdapterPairing } from "../../../services/system/consoleService";
import type { ConsoleIdentityLink } from "../../../domain/system/consoleModels";
import { INSTRUMENT_MESSENGERS_KEY } from "../wire/queryKeys";
import { refreshMessengerConnections } from "../wire/messengerSync";
import { MessengerPairing } from "./Telegram";
import { MessengerIcon } from "../onboarding/MessengerIcon";
import { MessengerCard } from "./messengers/MessengerCard";
import { MessengerSteps } from "./messengers/MessengerSteps";
import type { ManagedMessengerId } from "./messengers/ManagedTelegramOnboardingFlow";
import { loadMessengerConnections, messengerConnectionStatus, messengerLinkName, type MessengerConnectionStatus } from "./messengerConnectionsService";
import { canConfigure } from "./settingsModel";
import { SettingsError, type SettingsSectionProps } from "./settingsShared";
import { useT, type TextKey } from "../../../i18n/locale";
import { PageHeading } from "../../../components/ui/PageHeading";

const MESSENGERS: ReadonlyArray<{ id: ManagedMessengerId; name: string; blurb: TextKey }> = [
  { id: "whatsapp", name: "WhatsApp", blurb: "settings.messengers.whatsapp" },
  { id: "telegram", name: "Telegram", blurb: "settings.messengers.telegram" },
  { id: "slack", name: "Slack", blurb: "settings.messengers.slack" },
  { id: "discord", name: "Discord", blurb: "settings.messengers.discord" },
];
const STATUS_LABELS = {
  connected: "settings.messengers.status.connected",
  "reconnect-needed": "settings.messengers.status.reconnectNeeded",
  "needs-attention": "settings.messengers.status.needsAttention",
  "status-unavailable": "settings.messengers.status.statusUnavailable",
  "service-unavailable": "settings.messengers.status.serviceUnavailable",
} satisfies Record<MessengerConnectionStatus, TextKey>;
const STATUS_TONES = {
  connected: "online",
  "reconnect-needed": "warn",
  "needs-attention": "error",
  "status-unavailable": "idle",
  "service-unavailable": "idle",
} satisfies Record<MessengerConnectionStatus, TagTone>;

export function MessengerConnections({ account, active }: Pick<SettingsSectionProps, "account" | "active">) {
  const t = useT();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [pairing, setPairing] = useState<ManagedMessengerId | null>(null);
  const [removing, setRemoving] = useState<ConsoleIdentityLink | null>(null);
  const canList = canConfigure(account, "adapter.list") && canConfigure(account, "sys.link.list");
  const canUnlink = account.uid >= 1000 && canConfigure(account, "adapter.pair.disconnect");
  const connections = useQuery({
    queryKey: [...INSTRUMENT_MESSENGERS_KEY, account.uid],
    queryFn: () => loadMessengerConnections(client, account.uid),
    enabled: connected && active && canList,
  });
  const unlink = useMutation({
    mutationFn: (link: ConsoleIdentityLink) => disconnectConsoleAdapterPairing(client, link),
    onSuccess: async () => {
      setRemoving(null);
      await refreshMessengerConnections(cache);
    },
  });
  // Ship sends people here as ?section=messengers&messenger=whatsapp to connect one: open its setup once per visit.
  const location = useAppLocation();
  const loaded = connections.data !== undefined;
  useEffect(() => {
    if (!active || !loaded) return;
    const requested = new URLSearchParams(window.location.search).get("messenger");
    const messenger = MESSENGERS.find((entry) => entry.id === requested)?.id;
    const adapter = connections.data?.adapters.find((entry) => entry.adapter === messenger);
    if (messenger && messenger !== "slack" && messenger !== "discord" && adapter?.enabled && adapter.supportsPairing && adapter.canLink) {
      setRemoving(null);
      setPairing(messenger);
    }
  }, [active, loaded, location.revision]);

  return <section class="settings-messengers" aria-labelledby="settings-messengers-title">
    <PageHeading id="settings-messengers-title" title={t("settings.messengers.title")} description={t("settings.messengers.intro")} />
    {!canList && <p class="settings-muted">{t("settings.messengers.noAccess")}</p>}
    <SettingsError error={connections.error ?? unlink.error} />
    {connections.isPending && connected && canList && <LoadingState variant="panel">{t("settings.messengers.loading")}</LoadingState>}
    {connections.isError && <button class="settings-text-action" disabled={!connected || connections.isFetching} onClick={() => void connections.refetch()}>{t("common.tryAgain")}</button>}
    {connections.data && MESSENGERS.map(({ id, name, blurb }) => {
      const adapter = connections.data.adapters.find((entry) => entry.adapter === id);
      const links = connections.data.links.filter((entry) => entry.adapter === id);
      const statuses = links.map((link) => messengerConnectionStatus(adapter, link.accountId));
      // The card names the worst state among its accounts.
      const headline = (["needs-attention", "reconnect-needed", "connected"] as const).find((status) => statuses.includes(status)) ?? statuses[0];
      const available = adapter?.enabled && adapter.supportsPairing;
      const canPair = adapter?.canLink === true;
      const comingSoon = id === "slack" || id === "discord";
      const canConnect = !comingSoon && connected && canPair && available && !unlink.isPending;
      const fromLink = id === "whatsapp" || id === "telegram";
      return <MessengerCard key={id} id={id} name={name} sub={t(blurb)} icon={<MessengerIcon id={id} size={24} />}
        action={comingSoon ? undefined : links.length ? t("settings.messengers.connectAnother") : t("settings.messengers.connect", { name })}
        status={comingSoon
          ? <Tag boxed size="medium" tone="idle" label={t("settings.messengers.comingSoon")} />
          : headline && <Tag tone={STATUS_TONES[headline]} dot label={t(STATUS_LABELS[headline])} />}
        expanded={pairing === id} disabled={comingSoon || (pairing === id ? unlink.isPending : !canConnect)}
        onToggle={() => { if (comingSoon) return; setRemoving(null); setPairing(pairing === id ? null : id); }}
        details={(!available || !canPair || links.length > 0) && <>
          {!available && <p class="settings-muted">{t("settings.messengers.unavailable", { name })}</p>}
          {available && !canPair && <p class="settings-muted">{t("settings.messengers.cannotLink", { name })}</p>}
          {links.length > 0 && <ul class="settings-list settings-messenger-links">{links.map((link) => {
          const status = messengerConnectionStatus(adapter, link.accountId);
          const error = adapter?.accounts.find((entry) => entry.accountId === link.accountId)?.error;
          const isRemoving = removing?.adapter === link.adapter && removing.accountId === link.accountId && removing.actorId === link.actorId;
          return <li key={JSON.stringify([link.accountId, link.actorId])}>
            <div class="settings-server-heading">
              <span class="settings-messenger-status gsv-sublabel">
                {status === "connected"
                  ? t("settings.messengers.connectedTo", { id: messengerLinkName(link) })
                  : `${t(STATUS_LABELS[status])} · ${t("settings.messengers.user", { platform: name, id: messengerLinkName(link) })}`}
              </span>
            </div>
            {id === "slack" && <small>{t("settings.messengers.workspace", { id: link.accountId })}</small>}
            {error && <p class="settings-error" role="alert">{error}</p>}
            <div class="settings-actions">
              {isRemoving ? <>
                <span>{t("settings.messengers.confirmUnlink")}</span>
                <button class="settings-text-action settings-danger" disabled={!connected || !canUnlink || unlink.isPending} onClick={() => unlink.mutate(link)}>{unlink.isPending ? <LoadingState>{t("settings.messengers.unlinking")}</LoadingState> : t("settings.messengers.confirm")}</button>
                <button class="settings-text-action" disabled={unlink.isPending} onClick={() => setRemoving(null)}>{t("settings.messengers.keep")}</button>
              </> : <>
                <button class="settings-text-action" disabled={!canConnect} onClick={() => { if (!canConnect) return; setRemoving(null); setPairing(id); }}>{t("settings.messengers.reconnect")}</button>
                <button class="settings-text-action settings-danger" disabled={!connected || !canUnlink || unlink.isPending} onClick={() => { unlink.reset(); setRemoving(link); setPairing(null); }}>{t("settings.messengers.unlink")}</button>
              </>}
            </div>
          </li>;
        })}</ul>}
        </>}>
        {pairing === id && (fromLink
          ? <MessengerSteps adapter={id} name={name} linked={false} disabled={!connected || !canPair || !available} links={connections.data.links}
            onRefreshLinks={() => { void connections.refetch(); }} doneLabel={t("settings.pairing.done")}
            onFinish={() => { setPairing(null); void refreshMessengerConnections(cache); }} />
          : <fieldset disabled={!connected || !canPair || !available}>
            <MessengerPairing adapter={id} disabled={!connected || !canPair || !available} onClose={() => setPairing(null)} onConnected={() => { setPairing(null); void refreshMessengerConnections(cache); }}
              links={connections.data.links} onRefreshLinks={() => { void connections.refetch(); }} />
          </fieldset>)}
      </MessengerCard>;
    })}
  </section>;
}
