import type { EventRecord, EventSource, EventSourceAddArgs, EventSourceWebhook, WebhookHmac } from "@humansandmachines/gsv/protocol";
import { useState } from "preact/hooks";
import { Checkbox } from "../../../components/ui/Checkbox";
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
import { senderOf, WEBHOOK_SENDERS } from "./webhookSenders";

const RECENT_EVENTS = 20;

const DELIVERIES = [
  { webhook: "none", label: "fleet.sources.deliveryNone" },
  { webhook: "standard", label: "fleet.sources.deliveryStandard" },
  { webhook: "hmac", label: "fleet.sources.deliveryHmac" },
  { webhook: "url", label: "fleet.sources.deliveryUrl" },
] as const satisfies ReadonlyArray<{ webhook: EventSourceWebhook; label: TextKey }>;

const SENDERS = {
  client: "fleet.sources.sender.client",
  process: "fleet.sources.sender.process",
  schedule: "fleet.sources.sender.schedule",
  webhook: "fleet.sources.sender.webhook",
} satisfies Record<EventRecord["emittedBy"], TextKey>;

/** How a source's events arrive, naming the sender when its scheme is one of the presets. */
function deliveryText(source: EventSource, t: ReturnType<typeof useT>): string {
  const sender = senderOf(source);
  if (sender) return t("fleet.sources.deliverySender", { name: sender.name });
  return t(DELIVERIES.find((delivery) => delivery.webhook === source.webhook)?.label ?? "fleet.sources.deliveryNone");
}

function stateText(source: EventSource): TextKey {
  if (!source.enabled) return "fleet.sources.pausedState";
  return source.awaitingSecret ? "fleet.sources.awaitingState" : "fleet.sources.on";
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
          <td class="dim">{deliveryText(source, t)}</td>
          <td class="dim">{t(stateText(source))}</td>
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
      <div><dt>{t("fleet.sources.delivery")}</dt><dd>{deliveryText(source, t)}</dd></div>
      {source.hmac && !senderOf(source) && <div><dt>{t("fleet.sources.signatureHeader")}</dt><dd><code>{source.hmac.header}</code></dd></div>}
      {source.webhook === "none" && <div><dt>{t("fleet.sources.sendOne")}</dt><dd><code>gsv event emit {source.name} --title "…"</code></dd></div>}
    </dl>
    <div class="fleet-work-actions">
      <button type="button" class="fleet-text-action" onClick={onChoices}>{t("fleet.sources.choices")}</button>
      <button type="button" class="fleet-text-action" disabled={off} onClick={() => events.update.mutate({ name: source.name, enabled: !source.enabled })}>
        {t(source.enabled ? "fleet.sources.pause" : "fleet.sources.resume")}
      </button>
      {source.webhook !== "none" && !source.senderSecret && <button type="button" class="fleet-text-action" disabled={off} onClick={() => events.rotate.mutate({ name: source.name })}>{t("fleet.sources.rotate")}</button>}
      <button type="button" class="fleet-text-action" disabled={off} onClick={() => {
        if (window.confirm(t("fleet.sources.confirmRemove", { name: source.label }))) events.remove.mutate(source.name, { onSuccess: onRemoved });
      }}>{t("fleet.sources.remove")}</button>
    </div>
    {source.awaitingSecret && <p class="note">{t("fleet.sources.awaitingSecret")}</p>}
    {(source.webhook === "standard" || source.webhook === "hmac") && <form class="fleet-source-form" onSubmit={(event) => {
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
      // The list keeps 30 days, while the sources table still shows an older last event.
      : <p class="fleet-empty">{t(source.lastEventAtMs ? "fleet.sources.nothingRecent" : "fleet.sources.nothingArrived")}</p>}
  </div>;
}

type Choice = EventSourceWebhook | (typeof WEBHOOK_SENDERS)[number]["id"];

/** The fields of a signature that isn't one of the presets. */
function SignatureFields({ hmac, disabled, onChange }: { hmac: WebhookHmac; disabled: boolean; onChange: (hmac: WebhookHmac) => void }) {
  const t = useT();
  const optional = (value: string) => value.trim() || undefined;
  const [timestamp, setTimestamp] = useState(hmac.pairs?.timestamp ?? "");
  const [signature, setSignature] = useState(hmac.pairs?.signature ?? "");
  const setPairs = (nextTimestamp: string, nextSignature: string) => {
    setTimestamp(nextTimestamp);
    setSignature(nextSignature);
    const { pairs: _pairs, ...rest } = hmac;
    onChange(nextTimestamp.trim() || nextSignature.trim()
      ? { ...rest, pairs: { timestamp: nextTimestamp.trim(), signature: nextSignature.trim() } }
      : rest);
  };
  const set = (key: "prefix" | "idHeader" | "typeHeader", value: string) => {
    const { [key]: _old, ...rest } = hmac;
    const next = optional(value);
    onChange(next === undefined ? rest : { ...rest, [key]: next });
  };
  return <>
    <p class="note">{t("fleet.sources.hmacIntro")}</p>
    <TextInput label={t("fleet.sources.signatureHeader")} value={hmac.header} placeholder="x-signature" disabled={disabled}
      inputProps={{ name: "event-source-header", maxLength: 64 }} onChange={(header) => onChange({ ...hmac, header: header.trim() })} />
    <Select block label={t("fleet.sources.encoding")} disabled={disabled} selected={hmac.encoding}
      onSelect={(value) => onChange({ ...hmac, encoding: value === "base64" ? "base64" : "hex" })}
      options={[{ label: "hex", value: "hex" }, { label: "base64", value: "base64" }]} />
    <TextInput label={t("fleet.sources.prefix")} value={hmac.prefix ?? ""} placeholder="sha256=" disabled={disabled}
      inputProps={{ name: "event-source-prefix", maxLength: 32 }} onChange={(value) => set("prefix", value)} />
    <TextInput label={t("fleet.sources.timestampKey")} value={timestamp} placeholder="t" disabled={disabled}
      inputProps={{ name: "event-source-timestamp-key", maxLength: 16 }} onChange={(value) => setPairs(value, signature)} />
    <TextInput label={t("fleet.sources.signatureKey")} value={signature} placeholder="v1" disabled={disabled}
      inputProps={{ name: "event-source-signature-key", maxLength: 16 }} onChange={(value) => setPairs(timestamp, value)} />
    <TextInput label={t("fleet.sources.idHeader")} value={hmac.idHeader ?? ""} placeholder="x-delivery-id" disabled={disabled}
      inputProps={{ name: "event-source-id-header", maxLength: 64 }} onChange={(value) => set("idHeader", value)} />
    <TextInput label={t("fleet.sources.typeHeader")} value={hmac.typeHeader ?? ""} placeholder="x-event-type" disabled={disabled}
      inputProps={{ name: "event-source-type-header", maxLength: 64 }} onChange={(value) => set("typeHeader", value)} />
  </>;
}

function addArgs(name: string, choice: Choice, hmac: WebhookHmac, senderSecret: boolean): EventSourceAddArgs {
  const sender = WEBHOOK_SENDERS.find((preset) => preset.id === choice);
  if (sender) return { name, webhook: "hmac", hmac: sender.hmac, ...(sender.senderSecret ? { senderSecret: true } : undefined) };
  if (choice === "hmac") return { name, webhook: "hmac", hmac, ...(senderSecret ? { senderSecret: true } : undefined) };
  if (choice === "standard") return { name, webhook: "standard", ...(senderSecret ? { senderSecret: true } : undefined) };
  return { name, webhook: choice === "url" ? "url" : "none" };
}

export function NewSource({ events, disabled, onAdded }: { events: EventSources; disabled: boolean; onAdded: (name: string) => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [choice, setChoice] = useState<Choice>("none");
  const [hmac, setHmac] = useState<WebhookHmac>({ header: "", encoding: "hex" });
  const [senderSecret, setSenderSecret] = useState(false);
  const off = disabled || events.pending;
  const option = (label: string, value: Choice) => ({ label, value });
  const options = [
    option(t("fleet.sources.deliveryNone"), "none"),
    ...WEBHOOK_SENDERS.map((sender) => option(t("fleet.sources.deliverySender", { name: sender.name }), sender.id)),
    ...DELIVERIES.filter((delivery) => delivery.webhook !== "none").map((delivery) => option(t(delivery.label), delivery.webhook)),
  ];
  const incomplete = choice === "hmac" && (!hmac.header || (hmac.pairs !== undefined && (!hmac.pairs.timestamp || !hmac.pairs.signature)));
  return <form class="fleet-source-form" onSubmit={(event) => {
    event.preventDefault();
    const chosen = name.trim();
    events.add.mutate(addArgs(chosen, choice, hmac, senderSecret), { onSuccess: () => onAdded(chosen) });
  }}>
    <p class="note">{t("fleet.sources.intro")}</p>
    {events.add.error && <p class="error" role="alert">{events.add.error.message}</p>}
    <TextInput label={t("fleet.sources.name")} value={name} placeholder={t("fleet.sources.namePlaceholder")} disabled={off}
      inputProps={{ name: "event-source-name", maxLength: 63 }} onChange={setName} />
    <Select block label={t("fleet.sources.delivery")} disabled={off} selected={choice} onSelect={(value) => {
      const chosen = options.find((entry) => entry.value === value);
      if (chosen) setChoice(chosen.value);
    }} options={options} />
    {choice === "hmac" && <SignatureFields hmac={hmac} disabled={off} onChange={setHmac} />}
    {(choice === "hmac" || choice === "standard") && <Checkbox label={t("fleet.sources.senderSecret")} checked={senderSecret} disabled={off} onChange={setSenderSecret} />}
    <div class="fleet-work-actions"><button class="ibtn" type="submit" disabled={off || !name.trim() || incomplete}>{t("fleet.sources.add")}</button></div>
  </form>;
}
