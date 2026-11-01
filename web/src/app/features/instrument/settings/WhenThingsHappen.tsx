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

const NOTICES = [
  { kind: "contact.request", label: "settings.happenings.request" },
  { kind: "contact.message", label: "settings.happenings.message" },
  { kind: "contact.invite.accepted", label: "settings.happenings.inviteAccepted" },
] as const satisfies ReadonlyArray<{ kind: NoticeKind; label: TextKey }>;

const SHIP_SOURCES = [
  { id: "mail.received", label: "settings.happenings.mail" },
  { id: "machine.added", label: "settings.happenings.machineAdded" },
  { id: "adapter.connected", label: "settings.happenings.adapterConnected" },
  { id: "adapter.auth_required", label: "settings.happenings.adapterAuth" },
  { id: "memory.review", label: "settings.happenings.memoryReview" },
] as const satisfies ReadonlyArray<{ id: ResponsibilityConfigurableSourcePolicyId; label: TextKey }>;

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
  const loading = connected && ((canReadSources && sources.isPending) || (hasRules && rules.isPending));
  return <section class="settings-standing" aria-label={t("settings.happenings.title")}>
    <PageHeading title={t("settings.happenings.title")} description={t("settings.happenings.intro")} />
    {loading && <LoadingState>{t("common.loading")}</LoadingState>}
    <SettingsError error={sources.error ?? rules.error ?? updateSource.error ?? updateRule.error} />
    {!loading && <>
      {rules.data && <>
        <h2>{t("settings.happenings.tellMe")}</h2>
        {NOTICES.map(({ kind, label }) => {
          const rule = rules.data.find((entry) => entry.kind === kind);
          return rule && <div class="settings-happening" key={kind}>
            <label class="settings-check"><input type="checkbox" checked={rule.notify === "messenger"} disabled={busy || !canChangeRules}
              onChange={(event) => updateRule.mutate({ kind, notify: event.currentTarget.checked ? "messenger" : "none" })} />{t(label)}</label>
            {rule.changedBy === "ship" && <small>{t("settings.happenings.changedByShip")}</small>}
          </div>;
        })}
      </>}
      {sources.data && <>
        <h2>{t("settings.happenings.shipHandles")}</h2>
        {SHIP_SOURCES.map(({ id, label }) => {
          const source = sources.data.sources.find((entry) => entry.id === id);
          return source && <div class="settings-happening" key={id}>
            <label class="settings-check"><input type="checkbox" checked={source.enabled} disabled={busy || !canChangeSources}
              onChange={() => updateSource.mutate({ id, enabled: !source.enabled })} />{t(label)}</label>
          </div>;
        })}
        <p class="settings-muted">{t("settings.happenings.alwaysOn")}</p>
      </>}
    </>}
  </section>;
}
