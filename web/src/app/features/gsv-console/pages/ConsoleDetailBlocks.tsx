import type { ComponentChildren } from "preact";
import { Tag, type TagTone } from "../../../components/ui/Tag";

export type ConsoleDetailField = {
  label: string;
  value: number | string | null | undefined;
  tone?: TagTone;
  wide?: boolean;
};

export type ConsoleDetailChip = {
  label: string;
  tone?: TagTone;
};

export type ConsoleDetailListItem = {
  id: string;
  label: string;
  meta: string;
  chips?: readonly ConsoleDetailChip[];
};

type ConsoleRowDetailsProps = {
  summary: string;
  children: ComponentChildren;
};

export function ConsoleRowDetails({ summary, children }: ConsoleRowDetailsProps) {
  return (
    <details class="gsv-console-list-row-details">
      <summary>
        <span>{summary}</span>
      </summary>
      <div class="gsv-console-detail-body">{children}</div>
    </details>
  );
}

export function ConsoleDetailGrid({ fields }: { fields: readonly ConsoleDetailField[] }) {
  const visibleFields = fields.filter((field) => hasDetailValue(field.value));

  if (visibleFields.length === 0) {
    return null;
  }

  return (
    <dl class="gsv-console-detail-grid">
      {visibleFields.map((field) => (
        <div class="gsv-console-detail-field" data-wide={field.wide ? "true" : undefined} key={field.label}>
          <dt>{field.label}</dt>
          <dd>
            {field.tone ? (
              <Tag label={String(field.value)} tone={field.tone} boxed />
            ) : (
              <code>{field.value}</code>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ConsoleDetailChips({
  title,
  emptyLabel,
  chips,
}: {
  title: string;
  emptyLabel: string;
  chips: readonly ConsoleDetailChip[];
}) {
  const visibleChips = chips.filter((chip) => chip.label.trim().length > 0);

  return (
    <section class="gsv-console-detail-section">
      <div class="gsv-console-detail-section-heading">
        <span>{title}</span>
        <small>{visibleChips.length > 0 ? `${visibleChips.length} ITEMS` : emptyLabel}</small>
      </div>
      <div class="gsv-console-detail-chip-list">
        {visibleChips.length > 0 ? visibleChips.map((chip, index) => (
          <Tag key={`${index}-${chip.label}`} label={chip.label} tone={chip.tone ?? "idle"} boxed />
        )) : (
          <span class="gsv-console-detail-empty">{emptyLabel}</span>
        )}
      </div>
    </section>
  );
}

export function ConsoleDetailList({
  title,
  emptyLabel,
  items,
}: {
  title: string;
  emptyLabel: string;
  items: readonly ConsoleDetailListItem[];
}) {
  return (
    <section class="gsv-console-detail-section">
      <div class="gsv-console-detail-section-heading">
        <span>{title}</span>
        <small>{items.length > 0 ? `${items.length} ITEMS` : emptyLabel}</small>
      </div>
      <div class="gsv-console-detail-list">
        {items.length > 0 ? items.map((item) => (
          <div class="gsv-console-detail-list-item" key={item.id}>
            <div class="gsv-console-detail-list-copy">
              <strong>{item.label}</strong>
              <small>{item.meta}</small>
            </div>
            {item.chips && item.chips.length > 0 ? (
              <div class="gsv-console-detail-chip-list gsv-console-detail-chip-list--inline">
                {item.chips.map((chip, index) => (
                  <Tag key={`${item.id}-${index}-${chip.label}`} label={chip.label} tone={chip.tone ?? "idle"} boxed />
                ))}
              </div>
            ) : null}
          </div>
        )) : (
          <span class="gsv-console-detail-empty">{emptyLabel}</span>
        )}
      </div>
    </section>
  );
}

function hasDetailValue(value: number | string | null | undefined): boolean {
  return value !== null && value !== undefined && String(value).trim().length > 0;
}
