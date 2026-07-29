import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { AddAction } from "./AddAction";
import { Collapsible } from "./Collapsible";
import { ListRow, type ListRowStatus } from "./ListRow";
import { SectionHeader } from "./SectionHeader";
import { StatusDot } from "./StatusDot";
import type { TagTone } from "./Tag";
import "./ListCard.css";

export interface ListCardRow {
  id: string;
  label: string;
  /** Description line under the label (show/hide by presence). */
  sub?: string;
  /** Leading icon glyph (show/hide by presence). */
  icon?: string;
  /** Leading avatar image src — takes precedence over `icon`. */
  avatarSrc?: string;
  /** Status dot tone. The dot always shows; the `statusLabel` reveals on hover. */
  status?: ListRowStatus;
  statusLabel?: string;
  tag?: string;
  tagTone?: TagTone;
  onClick?: () => void;
}

export interface ListCardProps {
  title: string;
  /** Header counter / status string (show/hide by presence). */
  meta?: string;
  metaWord?: string;
  /** Header title click — "go to page". */
  onOpen?: () => void;
  rows: readonly ListCardRow[];
  emptyLabel?: string;
  /** "New" row at the foot of the list (show/hide by presence). */
  addLabel?: string;
  onAdd?: () => void;
  /** Rows shown before "show more" (default 6). */
  initialVisible?: number;
  /** Extra rows revealed per "show more" click (default 10). */
  showMoreStep?: number;
  /** Show the show-more / view-all footer once rows exceed the visible count
   *  (default true). */
  footer?: boolean;
  /** "View all" handler — navigate to the full page. Omit to reveal every row
   *  inline instead. */
  onViewAll?: () => void;
  /** Collapse to a click-to-expand drawer below the given breakpoint. */
  collapse?: { id: string; at: "tablet" | "mobile" };
  className?: string;
}

const LC_ROW_STYLE: JSX.CSSProperties = {
  minHeight: "44px",
  padding: "13px 16px",
};

/** ListCard — the standard "list display card": a section header (optional
 *  counter) over a list of rows, with per-row icon / avatar / description /
 *  status (dot always, label on hover, trailing), an optional "new" row, and an
 *  optional show-more / view-all footer once the list runs long. Optionally
 *  collapses to a drawer on narrow panels. */
export function ListCard({
  title,
  meta,
  metaWord,
  onOpen,
  rows,
  emptyLabel = "NOTHING HERE",
  addLabel,
  onAdd,
  initialVisible = 6,
  showMoreStep = 10,
  footer = true,
  onViewAll,
  collapse,
  className = "",
}: ListCardProps) {
  const [shown, setShown] = useState(initialVisible);
  const visible = rows.slice(0, shown);
  const hasMore = rows.length > visible.length;
  const showFooter = footer && hasMore;
  const showMore = () => setShown((n) => n + showMoreStep);
  const viewAll = onViewAll ?? (() => setShown(rows.length));

  const header = (
    <SectionHeader
      className="gsv-lc-heading"
      title={title}
      meta={meta}
      metaWord={metaWord}
      onClick={onOpen}
      chevron={Boolean(onOpen)}
      density="compact"
      divider
    />
  );

  const list = (
    <div class="gsv-lc-list">
      {visible.length === 0 ? (
        <div class="gsv-lc-empty gsv-sublabel">
          <StatusDot tone="idle" size={7} />
          <span>{emptyLabel}</span>
        </div>
      ) : visible.map((row) => (
        <ListRow
          key={row.id}
          className="gsv-lc-row"
          leading={row.avatarSrc ? <img class="gsv-lc-avatar" src={row.avatarSrc} alt="" /> : undefined}
          icon={row.avatarSrc ? undefined : row.icon}
          iconTitle={row.label}
          label={row.label}
          sub={row.sub}
          status={row.status ?? "none"}
          statusDotPlacement="trailing"
          statusLabel={row.statusLabel}
          tag={row.tag}
          tagTone={row.tagTone}
          chevron={Boolean(row.onClick)}
          onClick={row.onClick}
          style={LC_ROW_STYLE}
        />
      ))}
      {addLabel ? (
        <div class="gsv-lc-add">
          <AddAction variant="row" label={addLabel} onClick={onAdd} />
        </div>
      ) : null}
    </div>
  );

  const footerEl = showFooter ? (
    <div class="gsv-lc-footer">
      <button type="button" class="gsv-lc-footlink" onClick={showMore}>show more</button>
      <button type="button" class="gsv-lc-footlink" onClick={viewAll}>view all</button>
    </div>
  ) : null;

  const rootClass = `gsv-lc ${className}`.trim();

  if (collapse) {
    return (
      <Collapsible id={collapse.id} collapseAt={collapse.at} className={rootClass} header={header} footer={footerEl}>
        {list}
      </Collapsible>
    );
  }

  return (
    <div class={rootClass}>
      {header}
      {list}
      {footerEl}
    </div>
  );
}
