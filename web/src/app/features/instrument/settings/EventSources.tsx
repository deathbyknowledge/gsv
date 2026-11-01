import type { EventSource, EventSourceAddArgs, EventSourceRotateArgs, EventSourceSecretResult, EventSourceUpdateArgs, EventSourceWebhook, ShipOutcome } from "@humansandmachines/gsv/protocol";
import { Fragment } from "preact";
import type { ComponentType } from "preact";
import { useState } from "preact/hooks";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { Select } from "../../../components/ui/Select";
import { TextInput } from "../../../components/ui/TextInput";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useT, type TextKey } from "../../../i18n/locale";
import { INSTRUMENT_EVENT_SOURCES_KEY } from "../wire/queryKeys";

const DELIVERIES = [
  { webhook: "none", label: "settings.happenings.sources.deliveryNone" },
  { webhook: "github", label: "settings.happenings.sources.deliveryGithub" },
  { webhook: "stripe", label: "settings.happenings.sources.deliveryStripe" },
  { webhook: "standard", label: "settings.happenings.sources.deliveryStandard" },
  { webhook: "url", label: "settings.happenings.sources.deliveryUrl" },
] as const satisfies ReadonlyArray<{ webhook: EventSourceWebhook; label: TextKey }>;

const SOURCE_ICON = "M10 3a5 5 0 0 0-5 5c0 4-2 5-2 6h14c0-1-2-2-2-6a5 5 0 0 0-5-5Zm-2 12a2 2 0 0 0 4 0";

export function useEventSources(enabled: boolean) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const refresh = () => cache.invalidateQueries({ queryKey: INSTRUMENT_EVENT_SOURCES_KEY });
  const [revealed, setRevealed] = useState<EventSourceSecretResult | null>(null);
  const sources = useQuery({
    queryKey: INSTRUMENT_EVENT_SOURCES_KEY,
    queryFn: async () => (await client.call("event.source.list", {})).sources,
    enabled: connected && enabled,
  });
  const update = useMutation({ mutationFn: (change: EventSourceUpdateArgs) => client.call("event.source.update", change), onSuccess: refresh });
  const add = useMutation({
    mutationFn: (input: EventSourceAddArgs) => client.call("event.source.add", input),
    onSuccess: (result) => { setRevealed(result); return refresh(); },
  });
  const rotate = useMutation({
    mutationFn: (input: EventSourceRotateArgs) => client.call("event.source.rotate", input),
    onSuccess: (result, input) => { if (!input.secret) setRevealed(result); return refresh(); },
  });
  const remove = useMutation({
    mutationFn: (name: string) => client.call("event.source.remove", { name }),
    onSuccess: () => { setRevealed(null); return refresh(); },
  });
  return {
    sources: sources.data ?? [], revealed, update, add, rotate, remove,
    error: sources.error ?? update.error ?? add.error ?? rotate.error ?? remove.error,
    pending: update.isPending || add.isPending || rotate.isPending || remove.isPending,
  };
}

type Events = ReturnType<typeof useEventSources>;

/** Each source is one more row in the list of things that happen. */
export function EventSourceRows({ events, shipOutcomes, RowIcon, disabled }: {
  events: Events;
  shipOutcomes: ReadonlyArray<{ outcome: ShipOutcome; label: TextKey; icon: string }>;
  RowIcon: ComponentType<{ path: string }>;
  disabled: boolean;
}) {
  const t = useT();
  const off = disabled || events.pending;
  return <>{events.sources.map((source: EventSource) => <Fragment key={source.sourceId}>
    <span class="settings-happenings-name"><RowIcon path={SOURCE_ICON} />{source.label}</span>
    <input class="settings-happenings-tell" type="checkbox" aria-label={`${t("settings.happenings.tellMe")}: ${source.label}`} checked={source.notify === "messenger"} disabled={off}
      onChange={(event) => events.update.mutate({ name: source.name, notify: event.currentTarget.checked ? "messenger" : "none" })} />
    <div class="settings-happenings-ship" role="radiogroup" aria-label={`${t("settings.happenings.ship")}: ${source.label}`}>
      {shipOutcomes.map(({ outcome, label, icon }) => source.shipChoices.includes(outcome)
        ? <button key={outcome} type="button" role="radio" aria-checked={source.ship === outcome} aria-label={`${t("settings.happenings.ship")}: ${source.label}: ${t(label)}`} title={t(label)}
          disabled={off} onClick={() => events.update.mutate({ name: source.name, ship: outcome })}><RowIcon path={icon} /></button>
        : <span key={outcome} />)}
    </div>
    {!source.enabled && <small>{t("settings.happenings.sources.paused")}</small>}
    {source.webhook === "url" && <small>{t("settings.happenings.sources.unsigned")}</small>}
    {source.notify === "none" && source.ship === "none" && <small>{t("settings.happenings.nobody")}</small>}
    {source.changedBy === "ship" && <small>{t("settings.happenings.changedByShip")}</small>}
  </Fragment>)}</>;
}

/** Add sources, and pause, re-key or delete them. A secret is shown only when it's made. */
export function YourSources({ events, disabled }: { events: Events; disabled: boolean }) {
  const t = useT();
  const [name, setName] = useState("");
  const [issued, setIssued] = useState("");
  const [webhook, setWebhook] = useState<EventSourceWebhook>("none");
  const off = disabled || events.pending;
  const { revealed } = events;
  return <section class="settings-event-sources" aria-label={t("settings.happenings.sources.sources")}>
    <h3>{t("settings.happenings.sources.sources")}</h3>
    <p class="settings-muted">{t("settings.happenings.sources.sourcesIntro")}</p>
    {revealed && (revealed.webhookUrl || revealed.secret) && <div class="settings-event-secret" role="status">
      <p>{t("settings.happenings.sources.shownOnce")}</p>
      {revealed.webhookUrl && <p>{t("settings.happenings.sources.address")}: <code>{revealed.webhookUrl}</code></p>}
      {revealed.secret && <p>{t("settings.happenings.sources.secret")}: <code>{revealed.secret}</code></p>}
    </div>}
    {events.sources.map((source) => <div key={source.sourceId} class="settings-actions">
      <span>{source.label}</span>
      <button class="settings-text-action" type="button" disabled={off} onClick={() => events.update.mutate({ name: source.name, enabled: !source.enabled })}>
        {t(source.enabled ? "settings.happenings.sources.pause" : "settings.happenings.sources.resume")}
      </button>
      {source.webhook !== "none" && source.webhook !== "stripe" && <button class="settings-text-action" type="button" disabled={off} onClick={() => events.rotate.mutate({ name: source.name })}>{t("settings.happenings.sources.rotate")}</button>}
      <button class="settings-text-action" type="button" disabled={off} onClick={() => events.remove.mutate(source.name)}>{t("settings.happenings.sources.remove")}</button>
      {(source.webhook === "stripe" || source.webhook === "standard") && <form class="settings-event-add" onSubmit={(event) => {
        event.preventDefault();
        events.rotate.mutate({ name: source.name, secret: issued.trim() }, { onSuccess: () => setIssued("") });
      }}>
        <TextInput label={t("settings.happenings.sources.issued")} type="password" value={issued} disabled={off} inputProps={{ name: "event-source-secret", autoComplete: "off" }} onChange={setIssued} />
        <div class="settings-actions"><button class="ibtn" type="submit" disabled={off || issued.trim().length < 8}>{t("settings.happenings.sources.saveIssued")}</button></div>
      </form>}
    </div>)}
    <form class="settings-event-add" onSubmit={(event) => {
      event.preventDefault();
      events.add.mutate({ name: name.trim(), webhook }, { onSuccess: () => setName("") });
    }}>
      <TextInput label={t("settings.happenings.sources.name")} value={name} placeholder={t("settings.happenings.sources.namePlaceholder")} disabled={off}
        inputProps={{ name: "event-source-name", maxLength: 63 }} onChange={setName} />
      <Select block label={t("settings.happenings.sources.delivery")} disabled={off} selected={webhook} onSelect={(value) => {
        const chosen = DELIVERIES.find((delivery) => delivery.webhook === value);
        if (chosen) setWebhook(chosen.webhook);
      }} options={DELIVERIES.map((delivery) => ({ label: t(delivery.label), value: delivery.webhook }))} />
      <div class="settings-actions"><button class="ibtn" type="submit" disabled={off || !name.trim()}>{t("settings.happenings.sources.add")}</button></div>
    </form>
  </section>;
}
