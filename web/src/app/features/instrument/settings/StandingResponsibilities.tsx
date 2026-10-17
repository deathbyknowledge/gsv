import type { ResponsibilitySourcePolicy } from "@humansandmachines/gsv/protocol";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { LoadingState } from "../../../components/ui/Spinner";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { INSTRUMENT_SOURCES_KEY } from "../wire/queryKeys";
import { canConfigure } from "./settingsModel";
import { SettingsError } from "./settingsShared";

export function StandingResponsibilities({ account }: { account: ConsoleAccount }) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const query = useQuery({ queryKey: INSTRUMENT_SOURCES_KEY, queryFn: () => client.r12y.source.list({}), enabled: connected && canConfigure(account, "r12y.source.list") });
  const update = useMutation({ mutationFn: (source: ResponsibilitySourcePolicy) => {
    if (source.control !== "configurable") throw new Error("This responsibility is always on.");
    return client.r12y.source.update({ id: source.id, enabled: !source.enabled });
  }, onSuccess: () => cache.invalidateQueries({ queryKey: INSTRUMENT_SOURCES_KEY }) });
  if (!canConfigure(account, "r12y.source.list")) return <p class="settings-muted">Your account cannot read standing responsibilities.</p>;
  return <section aria-label="Standing responsibilities">
    <h1>Standing responsibilities</h1><p class="settings-muted">What Ship takes care of when something happens.</p>
    {query.isPending && connected && <LoadingState>Loading…</LoadingState>}
    <SettingsError error={query.error ?? update.error} />
    <ul class="settings-list">{query.data?.sources.map((source) => <li key={source.id}>
      <label class="settings-check"><input type="checkbox" checked={source.enabled}
        disabled={source.control === "required" || !connected || update.isPending || !canConfigure(account, "r12y.source.update")}
        onChange={() => update.mutate(source)} /><span>{source.name}</span></label>
      <p class="settings-muted">{source.description}{source.control === "required" ? " Always on." : ""}</p>
    </li>)}</ul>
  </section>;
}
