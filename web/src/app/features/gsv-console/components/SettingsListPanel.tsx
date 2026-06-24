import { AddAction } from "../../../components/ui/AddAction";
import { ListRow, type ListRowStatus } from "../../../components/ui/ListRow";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import type { StatusTone } from "../../../components/ui/StatusDot";
import type { TagTone } from "../../../components/ui/Tag";
import { listRowStatusForTone } from "./consoleDetailRows";
import "./SettingsListPanel.css";

type RowTag = {
  label: string;
  tone: TagTone;
};

export type SettingsListRow = {
  id: string;
  icon: string;
  label: string;
  sub: string;
  tone: StatusTone;
  statusLabel: string;
  tag?: RowTag;
  onOpen?: () => void;
};

type SettingsListAction = {
  label: string;
  onClick?: () => void;
};

type SettingsListPanelProps = {
  title: string;
  meta: string;
  rows: readonly SettingsListRow[];
  emptyLabel: string;
  action?: SettingsListAction;
  fitContent?: boolean;
};

function SettingsListRowView({ row }: { row: SettingsListRow }) {
  return (
    <div class="gsv-console-settings-list-row">
      <ListRow
        icon={row.icon}
        label={row.label}
        sub={row.sub}
        status={listRowStatusForTone(row.tone) as ListRowStatus}
        statusDotPlacement="trailing"
        statusLabel={row.statusLabel}
        tag={row.tag?.label}
        chevron={Boolean(row.onOpen)}
        onClick={row.onOpen}
      />
    </div>
  );
}

function SettingsListActionRow({ action }: { action: SettingsListAction }) {
  return (
    <div class={`gsv-console-settings-action${action.onClick ? "" : " is-disabled"}`} aria-disabled={action.onClick ? undefined : "true"}>
      <AddAction variant="row" label={action.label} onClick={action.onClick} />
    </div>
  );
}

export function SettingsListPanel({
  title,
  meta,
  rows,
  emptyLabel,
  action,
  fitContent = false,
}: SettingsListPanelProps) {
  return (
    <section class={`gsv-console-settings-list${fitContent ? " is-fit-content" : ""}`}>
      <SectionHeader title={title} meta={meta} divider />
      <div class="gsv-console-settings-list-body">
        {rows.length === 0 ? (
          <div class="gsv-console-settings-empty">{emptyLabel}</div>
        ) : rows.map((row) => (
          <SettingsListRowView key={row.id} row={row} />
        ))}
        {action ? <SettingsListActionRow action={action} /> : null}
      </div>
    </section>
  );
}
