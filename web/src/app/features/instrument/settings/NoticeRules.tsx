import type { NoticeDelivery, NoticeKind, NoticeRule } from "@humansandmachines/gsv/protocol";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { LoadingState } from "../../../components/ui/Spinner";
import { useT, type TextKey } from "../../../i18n/locale";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useQuery } from "../../../services/navigation/viewQueries";
import { INSTRUMENT_NOTICE_RULES_KEY } from "../wire/queryKeys";
import { SettingsError } from "./settingsShared";

const KIND_LABELS = {
  "contact.request": "settings.notices.kind.request",
  "contact.message": "settings.notices.kind.message",
  "contact.invite.accepted": "settings.notices.kind.inviteAccepted",
} satisfies Record<NoticeKind, TextKey>;

/** What the owner is told about on their messenger. A change applies at once and holds back notices still waiting. */
export function NoticeRules({ active }: { active: boolean }) {
  const t = useT();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const rules = useQuery({
    queryKey: INSTRUMENT_NOTICE_RULES_KEY,
    queryFn: async () => (await client.call("notify.rule.list", {})).rules,
    enabled: connected && active,
  });
  const change = useMutation({
    mutationFn: async ({ kind, notify }: { kind: NoticeKind; notify: NoticeDelivery }) =>
      (await client.call("notify.rule.set", { kind, notify })).rule,
    onSuccess: (rule) => cache.setQueryData<NoticeRule[]>(
      INSTRUMENT_NOTICE_RULES_KEY,
      (current) => current?.map((entry) => entry.kind === rule.kind ? rule : entry),
    ),
  });

  return <section class="settings-messenger" aria-labelledby="settings-notices-title">
    <div class="settings-messenger-heading"><h2 id="settings-notices-title">{t("settings.notices.title")}</h2></div>
    <p class="settings-muted">{t("settings.notices.intro")}</p>
    <SettingsError error={rules.error ?? change.error} />
    {rules.isPending && connected && <LoadingState variant="panel">{t("settings.notices.loading")}</LoadingState>}
    {rules.data?.map((rule) => <div class="settings-notice-rule" key={rule.kind}>
      <label class="settings-check"><input
        type="checkbox"
        checked={rule.notify === "messenger"}
        disabled={!connected || change.isPending}
        onChange={(event) => change.mutate({ kind: rule.kind, notify: event.currentTarget.checked ? "messenger" : "none" })}
      />{t(KIND_LABELS[rule.kind])}</label>
      {rule.changedBy === "ship" && <small>{t("settings.notices.changedByShip")}</small>}
    </div>)}
  </section>;
}
