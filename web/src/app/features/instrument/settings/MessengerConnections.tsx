import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useState } from "preact/hooks";
import { LoadingState } from "../../../components/ui/Spinner";
import { InfoTip } from "../../../components/ui/InfoTip";
import { StatusDot, type StatusTone } from "../../../components/ui/StatusDot";
import { Tag } from "../../../components/ui/Tag";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { disconnectConsoleAdapterPairing } from "../../../services/system/consoleService";
import type { ConsoleIdentityLink } from "../../../domain/system/consoleModels";
import { INSTRUMENT_MESSENGERS_KEY } from "../wire/queryKeys";
import { refreshMessengerConnections } from "../wire/messengerSync";
import { MessengerPairing } from "./Telegram";
import type { ManagedMessengerId } from "./messengers/ManagedTelegramOnboardingFlow";
import { loadMessengerConnections, messengerConnectionStatus, type MessengerConnectionStatus } from "./messengerConnectionsService";
import { canConfigure } from "./settingsModel";
import { SettingsError, type SettingsSectionProps } from "./settingsShared";
import { useT, type TextKey } from "../../../i18n/locale";

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

  return <section class="settings-messengers" aria-labelledby="settings-messengers-title">
    <h1 id="settings-messengers-title">{t("settings.messengers.title")}</h1>
    <p class="settings-intro">{t("settings.messengers.intro")}</p>
    {!canList && <p class="settings-muted">{t("settings.messengers.noAccess")}</p>}
    <SettingsError error={connections.error ?? unlink.error} />
    {connections.isPending && connected && canList && <LoadingState variant="panel">{t("settings.messengers.loading")}</LoadingState>}
    {connections.isError && <button class="settings-text-action" disabled={!connected || connections.isFetching} onClick={() => void connections.refetch()}>{t("common.tryAgain")}</button>}
    {connections.data && MESSENGERS.map(({ id, name, blurb }) => {
      const adapter = connections.data.adapters.find((entry) => entry.adapter === id);
      const links = connections.data.links.filter((entry) => entry.adapter === id);
      const statuses = links.map((link) => messengerConnectionStatus(adapter, link.accountId));
      const nameTone: StatusTone = statuses.includes("needs-attention") ? "error"
        : statuses.includes("reconnect-needed") ? "warn"
        : statuses.includes("connected") ? "online" : "idle";
      const available = adapter?.enabled && adapter.supportsPairing;
      const canPair = adapter?.canLink === true;
      const comingSoon = id === "slack" || id === "discord";
      const canConnect = !comingSoon && connected && canPair && available && !unlink.isPending;
      return <section class="settings-messenger" key={id} aria-label={name}>
        <div class="settings-messenger-heading">
          <h2 class="settings-messenger-name">
            <StatusDot tone={nameTone} size={7} />
            {name}
            {comingSoon && <Tag boxed size="medium" tone="idle" label={t("settings.messengers.comingSoon")} />}
          </h2>
          <button class="settings-text-action" disabled={comingSoon || (pairing === id ? unlink.isPending : !canConnect)} onClick={() => { if (comingSoon) return; setRemoving(null); setPairing(pairing === id ? null : id); }}>
            {pairing === id ? t("settings.messengers.closeSetup") : links.length ? t("settings.messengers.connectAnother") : t("settings.messengers.connect", { name })}
          </button>
        </div>
        <p class="settings-muted">{t(blurb)}</p>
        {!available && <p class="settings-muted">{t("settings.messengers.unavailable", { name })}</p>}
        {available && !canPair && <p class="settings-muted">{t("settings.messengers.cannotLink", { name })}</p>}
        {links.length === 0 && available && !comingSoon && <ul class="settings-list settings-messenger-links"><li class="settings-messenger-state">
          <span class="settings-messenger-status gsv-sublabel">{t("settings.messengers.noLinks", { name })}</span>
          {id === "whatsapp" && <InfoTip text={t("settings.messengers.whatsappRelink")} position="right" />}
        </li></ul>}
        <ul class="settings-list settings-messenger-links">{links.map((link) => {
          const status = messengerConnectionStatus(adapter, link.accountId);
          const error = adapter?.accounts.find((entry) => entry.accountId === link.accountId)?.error;
          const isRemoving = removing?.adapter === link.adapter && removing.accountId === link.accountId && removing.actorId === link.actorId;
          return <li key={JSON.stringify([link.accountId, link.actorId])}>
            <div class="settings-server-heading">
              <span class="settings-messenger-status gsv-sublabel">
                {status === "connected"
                  ? t("settings.messengers.connectedTo", { id: link.actorId })
                  : `${t(STATUS_LABELS[status])} · ${t("settings.messengers.user", { platform: name, id: link.actorId })}`}
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
        })}</ul>
        {!comingSoon && pairing === id && <fieldset disabled={!connected || !canPair || !available}>
          <MessengerPairing adapter={id} onClose={() => setPairing(null)} onConnected={() => { setPairing(null); void refreshMessengerConnections(cache); }} />
        </fieldset>}
      </section>;
    })}
  </section>;
}
