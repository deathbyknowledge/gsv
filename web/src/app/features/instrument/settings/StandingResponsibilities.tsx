import type { ResponsibilitySourcePolicy } from "@humansandmachines/gsv/protocol";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { LoadingState } from "../../../components/ui/Spinner";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { INSTRUMENT_SOURCES_KEY } from "../wire/queryKeys";
import { canConfigure } from "./settingsModel";
import { SettingsError } from "./settingsShared";
import { useT } from "../../../i18n/locale";
import { PageHeading } from "../../../components/ui/PageHeading";

export function StandingResponsibilities({ account }: { account: ConsoleAccount }) {
  const t = useT();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const query = useQuery({ queryKey: INSTRUMENT_SOURCES_KEY, queryFn: () => client.r12y.source.list({}), enabled: connected && canConfigure(account, "r12y.source.list") });
  const update = useMutation({ mutationFn: (source: ResponsibilitySourcePolicy) => {
    if (source.control !== "configurable") throw new Error(t("settings.standing.alwaysOnError"));
    return client.r12y.source.update({ id: source.id, enabled: !source.enabled });
  }, onSuccess: () => cache.invalidateQueries({ queryKey: INSTRUMENT_SOURCES_KEY }) });
  if (!canConfigure(account, "r12y.source.list")) return <p class="settings-muted">{t("settings.standing.noAccess")}</p>;
  return <section class="settings-standing" aria-label={t("settings.standing.title")}>
    <PageHeading title={t("settings.standing.title")} description={t("settings.standing.intro")} />
    {query.isPending && connected && <LoadingState>{t("common.loading")}</LoadingState>}
    <SettingsError error={query.error ?? update.error} />
    <ul class="settings-list">{query.data?.sources.map((source) => <li key={source.id}>
      <label class="settings-check"><input type="checkbox" checked={source.enabled}
        disabled={source.control === "required" || !connected || update.isPending || !canConfigure(account, "r12y.source.update")}
        onChange={() => update.mutate(source)} /><span><strong>{source.name}</strong>
          <small>{source.description}{source.control === "required" ? ` ${t("settings.standing.alwaysOn")}` : ""}</small>
        </span></label>
    </li>)}</ul>
  </section>;
}
