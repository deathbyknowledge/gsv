import type { NoticeKind, NoticeRule, NotifyRuleSetArgs, ShipOutcome } from "@humansandmachines/gsv/protocol";
import { Fragment } from "preact";
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

const HAPPENINGS = [
  { kind: "contact.request", label: "settings.happenings.request", icon: "M3 3h14v10H8l-5 4V3Zm7 3v3m0 2v.5" },
  { kind: "contact.message", label: "settings.happenings.message", icon: "M3 3h14v10H8l-5 4V3Zm4 4h6M7 10h4" },
  { kind: "contact.invite.accepted", label: "settings.happenings.inviteAccepted", icon: "M7 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-5 8c0-3 2-5 5-5s5 2 5 5m1-7 2 2 4-4" },
  { kind: "mail.received", label: "settings.happenings.mail", icon: "M2 4h16v12H2V4Zm0 1 8 6 8-6" },
  { kind: "machine.added", label: "settings.happenings.machineAdded", icon: "M4 4h12v9H4V4Zm-2 12h16" },
  { kind: "adapter.connected", label: "settings.happenings.adapterConnected", icon: "M7 2v5m6-5v5M5 7h10v3a5 5 0 0 1-10 0V7Zm5 8v3" },
  { kind: "adapter.auth_required", label: "settings.happenings.adapterAuth", icon: "M10 3 2 17h16L10 3Zm0 5v5m0 2v.5" },
] as const satisfies ReadonlyArray<{ kind: NoticeKind; label: TextKey; icon: string }>;

const SHIP_OUTCOMES = [
  { outcome: "none", label: "settings.happenings.shipOff", icon: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM5 5l10 10" },
  { outcome: "context", label: "settings.happenings.shipSees", icon: "M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Zm8 2a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" },
  { outcome: "wake", label: "settings.happenings.shipActs", icon: "M11 2 4 11h5l-1 7 7-9h-5l1-7Z" },
] as const satisfies ReadonlyArray<{ outcome: ShipOutcome; label: TextKey; icon: string }>;

function RowIcon({ path }: { path: string }) {
  return <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d={path} /></svg>;
}

const MEMORY_REVIEW = "memory.review";

export function WhenThingsHappen({ account }: { account: ConsoleAccount }) {
  const t = useT();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const canReadSources = canConfigure(account, "r12y.source.list");
  const canChangeSources = canConfigure(account, "r12y.source.update");
  // Rules belong to a person, so root administration has none.
  const hasRules = account.uid >= 1000 && canConfigure(account, "notify.rule.list");
  const canChangeRules = hasRules && canConfigure(account, "notify.rule.set");
  const sources = useQuery({ queryKey: INSTRUMENT_SOURCES_KEY, queryFn: () => client.r12y.source.list({}), enabled: connected && canReadSources });
  const rules = useQuery({
    queryKey: INSTRUMENT_NOTICE_RULES_KEY,
    queryFn: async () => (await client.call("notify.rule.list", {})).rules,
    enabled: connected && hasRules,
  });
  const updateSource = useMutation({
    mutationFn: (enabled: boolean) => client.r12y.source.update({ id: MEMORY_REVIEW, enabled }),
    onSuccess: () => cache.invalidateQueries({ queryKey: INSTRUMENT_SOURCES_KEY }),
  });
  const updateRule = useMutation({
    mutationFn: async (change: NotifyRuleSetArgs) => (await client.call("notify.rule.set", change)).rule,
    onSuccess: (rule) => {
      cache.setQueryData<NoticeRule[]>(
        INSTRUMENT_NOTICE_RULES_KEY,
        (current) => current?.map((entry) => entry.kind === rule.kind ? rule : entry),
      );
      void cache.invalidateQueries({ queryKey: INSTRUMENT_SOURCES_KEY });
    },
  });
  if (!canReadSources && !hasRules) return <p class="settings-muted">{t("settings.happenings.noAccess")}</p>;
  const busy = !connected || updateSource.isPending || updateRule.isPending;
  const loading = connected && ((canReadSources && sources.isPending) || (hasRules && rules.isPending));
  const memory = sources.data?.sources.find((entry) => entry.id === MEMORY_REVIEW);
  return <section class="settings-standing" aria-label={t("settings.happenings.title")}>
    <PageHeading title={t("settings.happenings.title")} description={t("settings.happenings.intro")} />
    {loading && <LoadingState>{t("common.loading")}</LoadingState>}
    <SettingsError error={sources.error ?? rules.error ?? updateSource.error ?? updateRule.error} />
    {!loading && <>
      {rules.data && <div class="settings-happenings">
        <span class="settings-happenings-head">{t("settings.happenings.event")}</span>
        <span class="settings-happenings-head">{t("settings.happenings.tellMe")}</span>
        <span class="settings-happenings-head">{t("settings.happenings.ship")}</span>
        {HAPPENINGS.map(({ kind, label, icon }) => {
          const rule = rules.data.find((entry) => entry.kind === kind);
          if (!rule) return null;
          const name = t(label);
          return <Fragment key={kind}>
            <span class="settings-happenings-name"><RowIcon path={icon} />{name}</span>
            <input class="settings-happenings-tell" type="checkbox" aria-label={`${t("settings.happenings.tellMe")}: ${name}`} checked={rule.notify === "messenger"} disabled={busy || !canChangeRules}
              onChange={(event) => updateRule.mutate({ kind, notify: event.currentTarget.checked ? "messenger" : "none" })} />
            <div class="settings-happenings-ship" role="radiogroup" aria-label={`${t("settings.happenings.ship")}: ${name}`}>
              {/* A choice a kind doesn't allow keeps its place, so the columns line up down the list. */}
              {SHIP_OUTCOMES.map(({ outcome, label: choice, icon: path }) => rule.shipChoices.includes(outcome)
                ? <button key={outcome} type="button" role="radio" aria-checked={rule.ship === outcome} aria-label={`${t("settings.happenings.ship")}: ${name}: ${t(choice)}`} title={t(choice)}
                  disabled={busy || !canChangeRules} onClick={() => updateRule.mutate({ kind, ship: outcome })}><RowIcon path={path} /></button>
                : <span key={outcome} />)}
            </div>
            {rule.notify === "none" && rule.ship === "none" && <small>{t("settings.happenings.nobody")}</small>}
            {rule.changedBy === "ship" && <small>{t("settings.happenings.changedByShip")}</small>}
          </Fragment>;
        })}
      </div>}
      {rules.data && <p class="settings-happenings-legend">
        {SHIP_OUTCOMES.map(({ outcome, label, icon }) => <span key={outcome}><RowIcon path={icon} />{t(label)}</span>)}
      </p>}
      {memory && <div class="settings-happening">
        <label class="settings-check"><input type="checkbox" checked={memory.enabled} disabled={busy || !canChangeSources}
          onChange={() => updateSource.mutate(!memory.enabled)} />{t("settings.happenings.memoryReview")}</label>
      </div>}
      {sources.data && <p class="settings-muted">{t("settings.happenings.alwaysOn")}</p>}
    </>}
  </section>;
}
