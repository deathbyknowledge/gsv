import type { NoticeDelivery, NoticeKind, NoticeRule, ResponsibilityConfigurableSourcePolicyId, ResponsibilitySourcePolicy } from "@humansandmachines/gsv/protocol";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { LoadingState } from "../../../components/ui/Spinner";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { INSTRUMENT_NOTICE_RULES_KEY, INSTRUMENT_SOURCES_KEY } from "../wire/queryKeys";
import { canConfigure } from "./settingsModel";
import { SettingsError } from "./settingsShared";
import { useT, type TextKey } from "../../../i18n/locale";
import { PageHeading } from "../../../components/ui/PageHeading";

/** One thing that can happen. `notice` is its notice rule; `source` is the responsibility source that has Ship act on it. */
type Happening = { label: TextKey; notice?: NoticeKind; source?: ResponsibilitySourcePolicy["id"]; shipNote?: TextKey };

const HAPPENINGS: readonly Happening[] = [
  { label: "settings.happenings.request", notice: "contact.request", shipNote: "settings.happenings.youDecide" },
  { label: "settings.happenings.message", notice: "contact.message", shipNote: "settings.happenings.perPerson" },
  { label: "settings.happenings.inviteAccepted", notice: "contact.invite.accepted" },
  { label: "settings.happenings.mail", source: "mail.received" },
  { label: "settings.happenings.machineAdded", source: "machine.added" },
  { label: "settings.happenings.adapterConnected", source: "adapter.connected" },
  { label: "settings.happenings.adapterAuth", source: "adapter.auth_required" },
];

export function WhenThingsHappen({ account }: { account: ConsoleAccount }) {
  const t = useT();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const canReadSources = canConfigure(account, "r12y.source.list");
  const canChangeSources = canConfigure(account, "r12y.source.update");
  // Notice rules belong to a person, so root administration has none.
  const hasRules = account.uid >= 1000 && canConfigure(account, "notify.rule.list");
  const canChangeRules = hasRules && canConfigure(account, "notify.rule.set");
  const sources = useQuery({ queryKey: INSTRUMENT_SOURCES_KEY, queryFn: () => client.r12y.source.list({}), enabled: connected && canReadSources });
  const rules = useQuery({
    queryKey: INSTRUMENT_NOTICE_RULES_KEY,
    queryFn: async () => (await client.call("notify.rule.list", {})).rules,
    enabled: connected && hasRules,
  });
  const updateSource = useMutation({
    mutationFn: ({ id, enabled }: { id: ResponsibilityConfigurableSourcePolicyId; enabled: boolean }) => client.r12y.source.update({ id, enabled }),
    onSuccess: () => cache.invalidateQueries({ queryKey: INSTRUMENT_SOURCES_KEY }),
  });
  const updateRule = useMutation({
    mutationFn: async ({ kind, notify }: { kind: NoticeKind; notify: NoticeDelivery }) =>
      (await client.call("notify.rule.set", { kind, notify })).rule,
    onSuccess: (rule) => cache.setQueryData<NoticeRule[]>(
      INSTRUMENT_NOTICE_RULES_KEY,
      (current) => current?.map((entry) => entry.kind === rule.kind ? rule : entry),
    ),
  });
  if (!canReadSources && !hasRules) return <p class="settings-muted">{t("settings.happenings.noAccess")}</p>;
  const busy = !connected || updateSource.isPending || updateRule.isPending;
  const sourceById = new Map(sources.data?.sources.map((source) => [source.id, source]));
  const shown = new Set(HAPPENINGS.map((happening) => happening.source));
  const upkeep = sources.data?.sources.filter((source) => source.control === "configurable" && !shown.has(source.id)) ?? [];
  const loading = connected && ((canReadSources && sources.isPending) || (hasRules && rules.isPending));
  return <section class="settings-standing" aria-label={t("settings.happenings.title")}>
    <PageHeading title={t("settings.happenings.title")} description={t("settings.happenings.intro")} />
    {loading && <LoadingState>{t("common.loading")}</LoadingState>}
    <SettingsError error={sources.error ?? rules.error ?? updateSource.error ?? updateRule.error} />
    {!loading && <>
      <table class="settings-happenings">
        <thead><tr>
          <th scope="col">{t("settings.happenings.title")}</th>
          <th scope="col">{t("settings.happenings.tellMe")}</th>
          <th scope="col">{t("settings.happenings.shipHandles")}</th>
        </tr></thead>
        <tbody>{HAPPENINGS.map((happening) => {
          const label = t(happening.label);
          const rule = rules.data?.find((entry) => entry.kind === happening.notice);
          const source = happening.source ? sourceById.get(happening.source) : undefined;
          return <tr key={happening.label}>
            <th scope="row">{label}{rule?.changedBy === "ship" && <small>{t("settings.happenings.changedByShip")}</small>}</th>
            <td>{rule
              ? <input type="checkbox" aria-label={`${label}: ${t("settings.happenings.tellMe")}`} checked={rule.notify === "messenger"} disabled={busy || !canChangeRules}
                  onChange={(event) => updateRule.mutate({ kind: rule.kind, notify: event.currentTarget.checked ? "messenger" : "none" })} />
              : <span class="settings-muted">{happening.notice ? "–" : t("settings.happenings.later")}</span>}</td>
            <td>{source
              ? <input type="checkbox" aria-label={`${label}: ${t("settings.happenings.shipHandles")}`} checked={source.enabled} disabled={busy || !canChangeSources || source.control === "required"}
                  onChange={() => { if (source.control === "configurable") updateSource.mutate({ id: source.id, enabled: !source.enabled }); }} />
              : <span class="settings-muted">{happening.shipNote ? t(happening.shipNote) : "–"}</span>}</td>
          </tr>;
        })}</tbody>
      </table>
      {upkeep.length > 0 && <>
        <h2>{t("settings.happenings.upkeep")}</h2>
        {upkeep.map((source) => <label class="settings-check" key={source.id}><input type="checkbox" checked={source.enabled} disabled={busy || !canChangeSources}
            onChange={() => { if (source.control === "configurable") updateSource.mutate({ id: source.id, enabled: !source.enabled }); }} />{source.id === "memory.review" ? t("settings.happenings.memoryReview") : source.name}</label>)}
      </>}
      <p class="settings-muted">{t("settings.happenings.alwaysOn")}</p>
    </>}
  </section>;
}
