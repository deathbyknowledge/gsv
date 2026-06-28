import type { ComponentChildren } from "preact";
import { AsciiPlanet } from "../../../components/ui/AsciiPlanet";
import { Button } from "../../../components/ui/Button";
import { DesktopHint } from "../../gsv-shell/desktop/DesktopHint";
import { ListRow, type ListRowStatus } from "../../../components/ui/ListRow";
import { Search } from "../../../components/ui/Search";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import type { StatusTone } from "../../../components/ui/StatusDot";
import type { TagTone } from "../../../components/ui/Tag";
import { listRowStatusForTone } from "../components/consoleDetailRows";
import "./ListTemplate.css";

export type ListTemplateRow = {
  id: string;
  icon: string;
  label: string;
  sub: string;
  tone: StatusTone;
  statusLabel: string;
  tag?: { label: string; tone: TagTone };
  /** Opens the object's detail / edit view. */
  onOpen?: () => void;
};

export type ListTemplateSearch = {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
};

type ListTemplateProps = {
  /** The single page header — title + count. Lives in the header component; the
   *  two columns below carry no headers of their own. */
  listTitle: string;
  listMeta: string;
  rows: readonly ListTemplateRow[];
  /** Object noun for the empty state, e.g. "MACHINES" → "NO MACHINES". */
  emptyObject: string;

  /** Left column — the action surface. */
  connectLabel: string;
  onConnect?: () => void;
  search?: ListTemplateSearch;
  /** Optional filter controls (Selects, chips). */
  filters?: ComponentChildren;
};

function ListTemplateRowView({ row }: { row: ListTemplateRow }) {
  return (
    <div class="gsv-list-template-row">
      <ListRow
        icon={row.icon}
        label={row.label}
        sub={row.sub}
        status={listRowStatusForTone(row.tone) as ListRowStatus}
        statusDotPlacement="trailing"
        statusLabel={row.statusLabel}
        tag={row.tag?.label}
        tagTone={row.tag?.tone}
        chevron={Boolean(row.onOpen)}
        onClick={row.onOpen}
      />
    </div>
  );
}

/** Empty state: a full-bleed placeholder banner (no border, ship-visual style)
 *  over a "NO <OBJECT>" label in the amber desktop terminal lettering. */
function ListTemplateEmpty({ object }: { object: string }) {
  const label = `NO ${object}`;
  return (
    <div class="gsv-list-template-empty">
      <div class="gsv-list-template-empty-banner">
        <AsciiPlanet variant="moon" formDuration={3.4} label={label} />
      </div>
      <div class="gsv-list-template-empty-hint">
        <DesktopHint lines={[`> ${label}`]} minimizedText={label} />
      </div>
    </div>
  );
}

/** The LIST page template: one header, then a body split into an ACTION column
 *  (search / filters / connect-new) and a LIST column (items or empty state). */
export function ListTemplate({
  listTitle,
  listMeta,
  rows,
  emptyObject,
  connectLabel,
  onConnect,
  search,
  filters,
}: ListTemplateProps) {
  // Action-bar arrangement keys off how many controls are present (connect is
  // always there): 1 → centered, 2 → inline, 3 → search row then filter+connect.
  const actionCount = 1 + (search ? 1 : 0) + (filters ? 1 : 0);

  return (
    <div class="gsv-list-template" aria-label={`${listTitle} list`}>
      <SectionHeader
        className="gsv-list-template-header"
        title={listTitle}
        meta={listMeta}
        divider
        headingLevel={2}
      />
      <div class="gsv-list-template-body">
        <section class="gsv-list-template-action" data-actions={actionCount}>
          {search ? (
            <div class="gsv-list-template-search">
              <Search
                block
                size="small"
                placeholder={search.placeholder ?? "Search…"}
                value={search.value}
                onChange={search.onChange}
              />
            </div>
          ) : null}
          {filters ? <div class="gsv-list-template-filters">{filters}</div> : null}
          <div class="gsv-list-template-connect">
            <Button variant="primary" block label={connectLabel} onClick={onConnect} />
          </div>
        </section>

        <section class="gsv-list-template-list">
          {rows.length === 0 ? (
            <ListTemplateEmpty object={emptyObject} />
          ) : (
            rows.map((row) => <ListTemplateRowView key={row.id} row={row} />)
          )}
        </section>
      </div>
    </div>
  );
}
