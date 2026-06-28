import type { ComponentChildren } from "preact";
import { Button } from "../../../components/ui/Button";
import { Search } from "../../../components/ui/Search";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import type { ListTemplateSearch } from "../list-template/ListTemplate";
import { TemplateEmptyState } from "../list-template/TemplateEmptyState";
import "./CardListTemplate.css";

type CardListTemplateProps = {
  /** Single page header — title + count. */
  listTitle: string;
  listMeta: string;
  /** Object noun for the empty state, e.g. "CREW" → "NO CREW". */
  emptyObject: string;
  /** When true the card grid is replaced with the shared empty state. */
  isEmpty: boolean;

  /** Action bar (on top) — search / filters / connect. */
  connectLabel: string;
  onConnect?: () => void;
  search?: ListTemplateSearch;
  filters?: ComponentChildren;

  /** The cards. Rendered into a full-width responsive grid. */
  children: ComponentChildren;
};

/** The CARD list template: one header, a horizontal action bar on top
 *  (search / filters / connect), then a full-width card grid (or the shared
 *  empty state). The grid is generic over the card component. */
export function CardListTemplate({
  listTitle,
  listMeta,
  emptyObject,
  isEmpty,
  connectLabel,
  onConnect,
  search,
  filters,
  children,
}: CardListTemplateProps) {
  // Same count rule as the table action bar: 1 → centered, 2 → inline,
  // 3 → search row then filter + connect.
  const actionCount = 1 + (search ? 1 : 0) + (filters ? 1 : 0);

  return (
    <div class="gsv-card-template" aria-label={`${listTitle} list`}>
      <SectionHeader
        className="gsv-card-template-header"
        title={listTitle}
        meta={listMeta}
        divider
        headingLevel={2}
      />

      <div class="gsv-card-template-action" data-actions={actionCount}>
        {search ? (
          <div class="gsv-card-template-search">
            <Search
              block
              size="small"
              placeholder={search.placeholder ?? "Search…"}
              value={search.value}
              onChange={search.onChange}
            />
          </div>
        ) : null}
        {filters ? <div class="gsv-card-template-filters">{filters}</div> : null}
        <div class="gsv-card-template-connect">
          <Button variant="primary" block label={connectLabel} onClick={onConnect} />
        </div>
      </div>

      <div class="gsv-card-template-body">
        {isEmpty ? (
          <TemplateEmptyState object={emptyObject} />
        ) : (
          <div class="gsv-card-template-grid">{children}</div>
        )}
      </div>
    </div>
  );
}
