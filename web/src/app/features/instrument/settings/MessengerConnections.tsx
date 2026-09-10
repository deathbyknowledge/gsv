import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { LoadingState } from "../../../components/ui/Spinner";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { disconnectConsoleAdapterPairing } from "../../gsv-console/backend/consoleService";
import type { ConsoleIdentityLink } from "../../gsv-console/domain/consoleModels";
import { INSTRUMENT_MESSENGERS_KEY } from "../wire/queryKeys";
import { refreshMessengerConnections } from "../wire/messengerSync";
import { MessengerPairing } from "./Telegram";
import { loadMessengerConnections, messengerConnectionStatus } from "./messengerConnectionsService";
import { canConfigure } from "./settingsModel";
import { SettingsError, type SettingsSectionProps } from "./settingsShared";

const MESSENGERS = [{ id: "telegram", name: "Telegram" }, { id: "slack", name: "Slack" }] as const;

export function MessengerConnections({ account, active }: Pick<SettingsSectionProps, "account" | "active">) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [pairing, setPairing] = useState<"telegram" | "slack" | null>(null);
  const [removing, setRemoving] = useState<ConsoleIdentityLink | null>(null);
  const canList = canConfigure(account, "adapter.list") && canConfigure(account, "sys.link.list");
  const canPair = account.uid >= 1000 && ["adapter.pair.info", "adapter.pair.inspect", "adapter.pair.confirm"].every((call) => canConfigure(account, call));
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
    <h1 id="settings-messengers-title">Messengers</h1>
    <p class="settings-intro">Choose where you talk to your Ship.</p>
    {!canList && <p class="settings-muted">Your account cannot view messaging connections.</p>}
    <SettingsError error={connections.error ?? unlink.error} />
    {connections.isPending && connected && canList && <LoadingState variant="panel">Loading messaging connections…</LoadingState>}
    {connections.isError && <button class="settings-text-action" disabled={!connected || connections.isFetching} onClick={() => void connections.refetch()}>try again</button>}
    {connections.data && MESSENGERS.map(({ id, name }) => {
      const adapter = connections.data.adapters.find((entry) => entry.adapter === id);
      const links = connections.data.links.filter((entry) => entry.adapter === id);
      const available = adapter?.available && adapter.supportsPairing;
      const canConnect = connected && canPair && available && !unlink.isPending;
      return <section class="settings-messenger" key={id} aria-label={name}>
        <div class="settings-messenger-heading">
          <h2>{name}</h2>
          <button class="settings-text-action" disabled={pairing === id ? unlink.isPending : !canConnect} onClick={() => { setRemoving(null); setPairing(pairing === id ? null : id); }}>
            {pairing === id ? "close setup" : links.length ? "connect another" : `connect ${name}`}
          </button>
        </div>
        <p class="settings-muted">{id === "telegram" ? "Talk to your Ship from Telegram." : "Talk to your Ship from your Slack workspace."}</p>
        {!available && <p class="settings-muted">{name} linking is not available on this GSV.</p>}
        {available && !canPair && <p class="settings-muted">Your account cannot link a {name} identity.</p>}
        {links.length === 0 && available && <p class="settings-muted">No {name} identity is linked to you.</p>}
        <ul class="settings-list settings-messenger-links">{links.map((link) => {
          const status = messengerConnectionStatus(adapter, link.accountId);
          const error = adapter?.accounts.find((entry) => entry.accountId === link.accountId)?.error;
          const isRemoving = removing?.adapter === link.adapter && removing.accountId === link.accountId && removing.actorId === link.actorId;
          return <li key={JSON.stringify([link.accountId, link.actorId])}>
            <div class="settings-server-heading"><strong>{name} user {link.actorId}</strong><span class={`settings-messenger-status${status === "connected" ? " is-connected" : ""}`}><i aria-hidden="true" />{status}</span></div>
            {id === "slack" && <small>workspace {link.accountId}</small>}
            {error && <p class="settings-error" role="alert">{error}</p>}
            <div class="settings-actions">
              {isRemoving ? <>
                <span>Unlink this identity from your Ship?</span>
                <button class="settings-text-action settings-danger" disabled={!connected || !canUnlink || unlink.isPending} onClick={() => unlink.mutate(link)}>{unlink.isPending ? <LoadingState>unlinking…</LoadingState> : "confirm unlink"}</button>
                <button class="settings-text-action" disabled={unlink.isPending} onClick={() => setRemoving(null)}>keep linked</button>
              </> : <>
                <button class="settings-text-action" disabled={!canConnect} onClick={() => { setRemoving(null); setPairing(id); }}>reconnect</button>
                <button class="settings-text-action settings-danger" disabled={!connected || !canUnlink || unlink.isPending} onClick={() => { unlink.reset(); setRemoving(link); setPairing(null); }}>unlink</button>
              </>}
            </div>
          </li>;
        })}</ul>
        {pairing === id && <fieldset disabled={!connected || !canPair || !available}>
          <MessengerPairing adapter={id} onClose={() => setPairing(null)} onConnected={() => { setPairing(null); void refreshMessengerConnections(cache); }} />
        </fieldset>}
      </section>;
    })}
  </section>;
}
