import type { EventSource, ShipOutcome } from "@humansandmachines/gsv/protocol";
import { Fragment } from "preact";
import type { ComponentType } from "preact";
import type { EventSources } from "../shared/useEventSources";
import { useT, type TextKey } from "../../../i18n/locale";

const SOURCE_ICON = "M10 3a5 5 0 0 0-5 5c0 4-2 5-2 6h14c0-1-2-2-2-6a5 5 0 0 0-5-5Zm-2 12a2 2 0 0 0 4 0";

/** Each source is one more row in the list of things that happen; the source itself is looked after in Work. */
export function EventSourceRows({ events, shipOutcomes, RowIcon, disabled, onOpen }: {
  events: EventSources;
  shipOutcomes: ReadonlyArray<{ outcome: ShipOutcome; label: TextKey; icon: string }>;
  RowIcon: ComponentType<{ path: string }>;
  disabled: boolean;
  onOpen: (name: string) => void;
}) {
  const t = useT();
  const off = disabled || events.pending;
  return <>{events.sources.map((source: EventSource) => <Fragment key={source.sourceId}>
    <button type="button" class="settings-happenings-name settings-happenings-source" onClick={() => onOpen(source.name)}><RowIcon path={SOURCE_ICON} />{source.label}</button>
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
