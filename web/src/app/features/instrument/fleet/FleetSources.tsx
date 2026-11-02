import type { EventRecord, EventSource, EventSourceWebhook } from "@humansandmachines/gsv/protocol";
import { useState } from "preact/hooks";
import { Select } from "../../../components/ui/Select";
import { LoadingState } from "../../../components/ui/Spinner";
import { TextInput } from "../../../components/ui/TextInput";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useT, type TextKey } from "../../../i18n/locale";
import type { FleetRow } from "../Instrument";
import type { EventSources } from "../shared/useEventSources";
import { INSTRUMENT_EVENT_SOURCES_KEY } from "../wire/queryKeys";
import { relativeTime, sourceRow } from "./fleetModel";

const RECENT_EVENTS = 20;

const DELIVERIES = [
  { webhook: "none", label: "fleet.sources.deliveryNone" },
  { webhook: "github", label: "fleet.sources.deliveryGithub" },
  { webhook: "stripe", label: "fleet.sources.deliveryStripe" },
  { webhook: "standard", label: "fleet.sources.deliveryStandard" },
  { webhook: "url", label: "fleet.sources.deliveryUrl" },
] as const satisfies ReadonlyArray<{ webhook: EventSourceWebhook; label: TextKey }>;

const SENDERS = {
  client: "fleet.sources.sender.client",
  process: "fleet.sources.sender.process",
  schedule: "fleet.sources.sender.schedule",
  webhook: "fleet.sources.sender.webhook",
} satisfies Record<EventRecord["emittedBy"], TextKey>;

function deliveryLabel(webhook: EventSourceWebhook): TextKey {
  return DELIVERIES.find((delivery) => delivery.webhook === webhook)?.label ?? "fleet.sources.deliveryNone";
}

export function SourcesSection({ events, canChange, now, onSelect, onCreate }: {
  events: EventSources;
  canChange: boolean;
  now: number;
  onSelect: (row: FleetRow) => void;
  onCreate: () => void;
}) {
  const t = useT();
  return <section class="fleet-block" aria-label={t("fleet.sources.title")}>
    <h2>
      <i /> {t("fleet.sources.title")}
      <button type="button" class="fleet-heading-action" disabled={!canChange} onClick={onCreate}>{t("fleet.sources.new")}</button>
      <span class="count">{events.sources.length}</span>
    </h2>
    {events.loading ? <LoadingState>{t("common.loading")}</LoadingState> : events.sources.length ? <div class="tablewrap">
      <table class="fleet-places-table">
        <thead><tr><th>{t("fleet.sources.source")}</th><th>{t("fleet.sources.delivery")}</th><th>{t("fleet.field.state")}</th><th>{t("fleet.sources.lastEventHead")}</th></tr></thead>
        <tbody>{events.sources.map((source) => <tr key={source.sourceId} data-row={sourceRow(source.name)} tabIndex={0} onClick={() => onSelect(sourceRow(source.name))}>
          <td><span class={`dot ${source.enabled ? "is-on" : "is-idle"}`} aria-hidden="true" />{source.label}</td>
          <td class="dim">{t(deliveryLabel(source.webhook))}</td>
          <td class="dim">{t(source.enabled ? "fleet.sources.on" : "fleet.sources.pausedState")}</td>
          <td class="dim">{source.lastEventAtMs ? relativeTime(source.lastEventAtMs, now) : t("fleet.time.never")}</td>
        </tr>)}</tbody>
      </table>
    </div> : <p class="fleet-empty">{t("fleet.sources.empty")}</p>}
  </section>;
}

export function SourceInspector({ source, events, canChange, canRead, now, onChoices, onRemoved }: {
  source: EventSource;
  events: EventSources;
  canChange: boolean;
  canRead: boolean;
  now: number;
  onChoices: () => void;
  onRemoved: () => void;
}) {
  const t = useT();
  const { client, connected } = useGateway();
  const [issued, setIssued] = useState("");
  const off = !canChange || events.pending;
  // A secret is shown once, when it's made, so it stays only until this source's details close.
  const revealed = events.revealed?.source.sourceId === source.sourceId ? events.revealed : null;
  const arrived = useQuery({
    queryKey: [...INSTRUMENT_EVENT_SOURCES_KEY, "events", source.name],
    queryFn: async () => (await client.call("event.list", { source: source.name, limit: RECENT_EVENTS })).events,
    enabled: connected && canRead,
  });
  return <div>
    <h3>{source.label}</h3>
    {revealed && (revealed.webhookUrl || revealed.secret) && <div class="fleet-source-secret" role="status">
      <p>{t("fleet.sources.shownOnce")}</p>
      {revealed.webhookUrl && <p>{t("fleet.sources.address")}: <code>{revealed.webhookUrl}</code></p>}
      {revealed.secret && <p>{t("fleet.sources.secret")}: <code>{revealed.secret}</code></p>}
    </div>}
    {events.error && <p class="error" role="alert">{events.error.message}</p>}
    <dl class="fleet-work-details">
      <div><dt>{t("fleet.sources.delivery")}</dt><dd>{t(deliveryLabel(source.webhook))}</dd></div>
      {source.webhook === "none" && <div><dt>{t("fleet.sources.sendOne")}</dt><dd><code>gsv event emit {source.name} --title "…"</code></dd></div>}
    </dl>
    <div class="fleet-work-actions">
      <button type="button" class="fleet-text-action" onClick={onChoices}>{t("fleet.sources.choices")}</button>
      <button type="button" class="fleet-text-action" disabled={off} onClick={() => events.update.mutate({ name: source.name, enabled: !source.enabled })}>
        {t(source.enabled ? "fleet.sources.pause" : "fleet.sources.resume")}
      </button>
      {source.webhook !== "none" && source.webhook !== "stripe" && <button type="button" class="fleet-text-action" disabled={off} onClick={() => events.rotate.mutate({ name: source.name })}>{t("fleet.sources.rotate")}</button>}
      <button type="button" class="fleet-text-action" disabled={off} onClick={() => {
        if (window.confirm(t("fleet.sources.confirmRemove", { name: source.label }))) events.remove.mutate(source.name, { onSuccess: onRemoved });
      }}>{t("fleet.sources.remove")}</button>
    </div>
    {(source.webhook === "stripe" || source.webhook === "standard") && <form class="fleet-source-form" onSubmit={(event) => {
      event.preventDefault();
      events.rotate.mutate({ name: source.name, secret: issued.trim() }, { onSuccess: () => setIssued("") });
    }}>
      <TextInput label={t("fleet.sources.issued")} type="password" value={issued} disabled={off} inputProps={{ name: "event-source-secret", autoComplete: "off" }} onChange={setIssued} />
      <div class="fleet-work-actions"><button class="ibtn" type="submit" disabled={off || issued.trim().length < 8}>{t("fleet.sources.saveIssued")}</button></div>
    </form>}
    <h4 class="fleet-source-heading">{t("fleet.sources.arrived")}</h4>
    {arrived.error ? <p class="error" role="alert">{arrived.error.message}</p>
      : arrived.isPending ? <LoadingState>{t("common.loading")}</LoadingState>
      : arrived.data.length ? <ul class="fleet-source-events">{arrived.data.map((event) => <li key={event.eventId}>
        <span class="fleet-work-title">{event.title}</span>
        {event.preview && <span class="fleet-source-preview">{event.preview}</span>}
        <span class="fleet-work-summary"><span>{t(SENDERS[event.emittedBy])}</span><span>{relativeTime(event.receivedAtMs, now)}</span></span>
        {event.body && <details><summary>{t("fleet.sources.body")}</summary><pre>{event.body}</pre></details>}
      </li>)}</ul>
      : <p class="fleet-empty">{t("fleet.sources.nothingArrived")}</p>}
  </div>;
}

export function NewSource({ events, disabled, onAdded }: { events: EventSources; disabled: boolean; onAdded: (name: string) => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [webhook, setWebhook] = useState<EventSourceWebhook>("none");
  const off = disabled || events.pending;
  return <form class="fleet-source-form" onSubmit={(event) => {
    event.preventDefault();
    const chosen = name.trim();
    events.add.mutate({ name: chosen, webhook }, { onSuccess: () => onAdded(chosen) });
  }}>
    <p class="note">{t("fleet.sources.intro")}</p>
    {events.add.error && <p class="error" role="alert">{events.add.error.message}</p>}
    <TextInput label={t("fleet.sources.name")} value={name} placeholder={t("fleet.sources.namePlaceholder")} disabled={off}
      inputProps={{ name: "event-source-name", maxLength: 63 }} onChange={setName} />
    <Select block label={t("fleet.sources.delivery")} disabled={off} selected={webhook} onSelect={(value) => {
      const chosen = DELIVERIES.find((delivery) => delivery.webhook === value);
      if (chosen) setWebhook(chosen.webhook);
    }} options={DELIVERIES.map((delivery) => ({ label: t(delivery.label), value: delivery.webhook }))} />
    <div class="fleet-work-actions"><button class="ibtn" type="submit" disabled={off || !name.trim()}>{t("fleet.sources.add")}</button></div>
  </form>;
}
